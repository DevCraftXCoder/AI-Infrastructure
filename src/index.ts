import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, Variables, ChatRequest, ChatResponse } from "./types.js";
import { verifyAuth } from "./auth.js";
import { callProvider } from "./providers.js";
import { checkSync, check } from "./safety.js";
import dashboard from "./dashboard.js";
import { runHealthChecks } from "./registry.js";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "X-Feature"], allowMethods: ["POST", "GET", "DELETE", "OPTIONS"] }));

app.get("/health", (c) => c.json({ status: "ok", service: "ai-gateway" }));

// Control-plane dashboard + registry API (served at "/" and "/api/control/*")
app.route("/", dashboard);

app.use("/v1/*", verifyAuth);

app.post("/v1/chat/completions", async (c) => {
  const requestId = crypto.randomUUID();

  let body: ChatRequest;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body.messages?.length) return c.json({ error: "no_messages" }, 400);

  const feature = c.req.header("x-feature")?.trim();
  if (!feature) return c.json({ error: "missing_x_feature_header" }, 400);

  const { success } = await c.env.GATEWAY_RATE_LIMITER.limit({ key: c.get("callerHash") });
  if (!success) return c.json({ error: "rate_limited" }, 429);

  // Input safety — sync blocklist
  const input = body.messages.filter(m => m.role === "user" || m.role === "system")
    .map(m => typeof m.content === "string" ? m.content : m.content.map((b: { text?: string }) => b.text ?? "").join(" "))
    .join(" ");
  const safe = checkSync(input);
  if (!safe.allowed) {
    c.executionCtx.waitUntil(writeLog(c.env, "safety_log", { feature, phase: "input", outcome: "blocked", reason: safe.reason, excerpt: input.slice(0, 200), created_at: Date.now() }));
    return c.json({ error: "content_blocked" }, 403);
  }

  // Prompt-cache breakpoints on large system messages
  for (const msg of body.messages) {
    if (msg.role === "system" && typeof msg.content === "string" && msg.content.length > 4096) {
      msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
    }
  }

  const t0 = Date.now();
  let result: Awaited<ReturnType<typeof callProvider>>;
  try { result = await callProvider(body, c.env); } catch {
    c.executionCtx.waitUntil(writeLog(c.env, "cost_ledger", { request_id: requestId, feature, model: body.model, was_fallback: 0, input_tokens: null, output_tokens: null, cache_status: "none", latency_ms: Date.now() - t0, status_code: 502, created_at: Date.now() }));
    return c.json({ error: "upstream_failed" }, 502);
  }

  if (body.stream) {
    c.executionCtx.waitUntil(writeLog(c.env, "cost_ledger", { request_id: requestId, feature, model: body.model, was_fallback: result.wasFallback ? 1 : 0, input_tokens: null, output_tokens: null, cache_status: "none", latency_ms: Date.now() - t0, status_code: result.response.status, created_at: Date.now() }));
    const streamResp = new Response(result.response.body, result.response);
    streamResp.headers.set("X-Request-ID", requestId);
    return streamResp;
  }

  const json = await result.response.json() as ChatResponse;
  const u = json.usage;
  const cacheStatus = (u?.cache_read_input_tokens ?? 0) > 0 ? "hit" : (u?.cache_creation_input_tokens ?? 0) > 0 ? "miss" : "none";
  c.executionCtx.waitUntil(writeLog(c.env, "cost_ledger", { request_id: requestId, feature, model: body.model, was_fallback: result.wasFallback ? 1 : 0, input_tokens: u?.prompt_tokens ?? null, output_tokens: u?.completion_tokens ?? null, cache_status: cacheStatus, latency_ms: Date.now() - t0, status_code: 200, created_at: Date.now() }));

  // Output safety — non-blocking
  const out = json.choices?.[0]?.message?.content;
  if (typeof out === "string") {
    c.executionCtx.waitUntil(
      check(out, c.env.PERSPECTIVE_API_KEY).then(r => {
        if (r.flagged) return writeLog(c.env, "safety_log", { feature, phase: "output", outcome: "flagged", reason: r.flagReason, excerpt: out.slice(0, 200), created_at: Date.now() });
      }).catch(() => {})
    );
  }

  return c.json(json, 200, { "X-Request-ID": requestId });
});

// Hard-coded column schemas per table — prevents column-name injection via Object.keys()
const SCHEMAS: Record<string, string[]> = {
  cost_ledger: ["id", "request_id", "feature", "model", "was_fallback", "input_tokens", "output_tokens", "cache_status", "latency_ms", "status_code", "created_at"],
  safety_log:  ["id", "feature", "phase", "outcome", "reason", "excerpt", "created_at"],
};

async function writeLog(env: Env, table: string, data: Record<string, unknown>): Promise<void> {
  const cols = SCHEMAS[table];
  if (!cols) return; // unknown table — reject silently (also allowlists table names)
  try {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    const fullData: Record<string, unknown> = { id, ...data };
    const vals = cols.map(k => fullData[k] ?? null);
    await env.DB.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...vals).run();
  } catch { /* never break the response path */ }
}

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Health sweep on every tick (5-min cron); TTL purges nightly (3am cron).
    ctx.waitUntil(runHealthChecks(env, ctx).catch(() => {}));
    if (controller.cron === "0 3 * * *") {
      ctx.waitUntil(env.DB.prepare("DELETE FROM safety_log WHERE created_at < ?").bind(Date.now() - 30 * 864e5).run().catch(() => {}));
      ctx.waitUntil(env.DB.prepare("DELETE FROM health_checks WHERE checked_at < ?").bind(Date.now() - 7 * 864e5).run().catch(() => {}));
      ctx.waitUntil(env.DB.prepare("DELETE FROM activity WHERE created_at < ?").bind(Date.now() - 30 * 864e5).run().catch(() => {}));
      ctx.waitUntil(env.DB.prepare("DELETE FROM cost_ledger WHERE created_at < ?").bind(Date.now() - 90 * 864e5).run().catch(() => {})); // 90-day retention
    }
  },
};
