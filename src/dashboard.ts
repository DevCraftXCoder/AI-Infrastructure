import { Hono } from "hono";
import type { Env, Variables } from "./types.js";
import { verifyAuth } from "./auth.js";
import {
  listOrgs, listProjects, listRegions, listServices, summarize,
  listActivity, getService, recentChecks, upsertService, deleteService,
  runHealthChecks, logActivity, updateServiceStatus, uptimePercent, ingestEvent, type Filter,
} from "./registry.js";
import extra from "./dashboard-extra.js";

const ALL = "__all__";
const dash = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Escape user-controlled strings before inserting into innerHTML. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function readFilter(c: { req: { query: (k: string) => string | undefined } }): Filter {
  return {
    org: c.req.query("org") || undefined,
    project: c.req.query("project") || undefined,
    region: c.req.query("region") || undefined,
    status: c.req.query("status") || undefined,
    q: (c.req.query("q") || "").trim() || undefined,
  };
}

// ---- stats API (P1: real backend stats from cost_ledger) ---------------

interface StatRow { feature: string; total: number; errors: number; avg_latency: number; p95_latency: number; cache_hits: number; input_tokens: number; output_tokens: number; fallbacks: number }

dash.get("/api/control/stats", async (c) => {
  try {
    const window = parseInt(c.req.query("window") || "86400000", 10); // default 24h in ms
    const since = Date.now() - window;
    const org = c.req.query("org") || undefined;

    // Total request counts, error rates, latency, cache hits, token usage per feature
    const rows = await c.env.DB.prepare(`
      SELECT
        feature,
        COUNT(*) as total,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors,
        AVG(latency_ms) as avg_latency,
        SUM(CASE WHEN cache_status = 'hit' THEN 1 ELSE 0 END) as cache_hits,
        SUM(COALESCE(input_tokens, 0)) as input_tokens,
        SUM(COALESCE(output_tokens, 0)) as output_tokens,
        SUM(was_fallback) as fallbacks
      FROM cost_ledger
      WHERE created_at >= ?
      GROUP BY feature
      ORDER BY total DESC
      LIMIT 100
    `).bind(since).all<StatRow>();

    // p95 latency: window functions + GROUP BY on derived table is invalid in some D1 builds.
    // Compute p95 per-feature via a safe subquery that picks the row at the 95th percentile position.
    // If D1 doesn't support window functions, p95 degrades gracefully to null (never breaks the endpoint).
    let p95Map: Record<string, number> = {};
    try {
      const p95Rows = await c.env.DB.prepare(`
        SELECT feature, latency_ms as p95_latency FROM (
          SELECT feature, latency_ms,
            ROW_NUMBER() OVER (PARTITION BY feature ORDER BY latency_ms) as rn,
            COUNT(*) OVER (PARTITION BY feature) as cnt
          FROM cost_ledger WHERE created_at >= ?
        ) sub WHERE sub.rn >= CAST(sub.cnt * 0.95 AS INTEGER)
      `).bind(since).all<{ feature: string; p95_latency: number }>();
      // Keep only the first (lowest qualifying) row per feature
      const seen = new Set<string>();
      for (const r of p95Rows.results ?? []) {
        if (!seen.has(r.feature)) { p95Map[r.feature] = r.p95_latency; seen.add(r.feature); }
      }
    } catch { /* window functions unsupported — p95 remains null for all features */ }

    // Aggregate totals
    const totals = await c.env.DB.prepare(`
      SELECT
        COUNT(*) as total_requests,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as total_errors,
        AVG(latency_ms) as avg_latency_ms,
        SUM(CASE WHEN cache_status = 'hit' THEN 1 ELSE 0 END) as cache_hit_count,
        SUM(COALESCE(input_tokens, 0)) as total_input_tokens,
        SUM(COALESCE(output_tokens, 0)) as total_output_tokens,
        SUM(was_fallback) as total_fallbacks,
        COUNT(DISTINCT feature) as active_features
      FROM cost_ledger WHERE created_at >= ?
    `).bind(since).first<{
      total_requests: number; total_errors: number; avg_latency_ms: number;
      cache_hit_count: number; total_input_tokens: number; total_output_tokens: number;
      total_fallbacks: number; active_features: number;
    }>();

    const features = (rows.results ?? []).map(r => ({
      ...r,
      p95_latency: p95Map[r.feature] ?? null,
      error_rate: r.total > 0 ? Math.round((r.errors / r.total) * 100) : 0,
      cache_hit_rate: r.total > 0 ? Math.round((r.cache_hits / r.total) * 100) : 0,
      fallback_rate: r.total > 0 ? Math.round((r.fallbacks / r.total) * 100) : 0,
    }));

    const t = totals ?? { total_requests: 0, total_errors: 0, avg_latency_ms: 0, cache_hit_count: 0, total_input_tokens: 0, total_output_tokens: 0, total_fallbacks: 0, active_features: 0 };
    return c.json({
      window_ms: window,
      since,
      totals: {
        ...t,
        error_rate: t.total_requests > 0 ? Math.round((t.total_errors / t.total_requests) * 100) : 0,
        cache_hit_rate: t.total_requests > 0 ? Math.round((t.cache_hit_count / t.total_requests) * 100) : 0,
        fallback_rate: t.total_requests > 0 ? Math.round((t.total_fallbacks / t.total_requests) * 100) : 0,
      },
      by_feature: features,
    });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

// ---- read APIs (public) ------------------------------------------------

dash.get("/api/control/orgs", async (c) => {
  try { return c.json({ orgs: await listOrgs(c.env) }); }
  catch { return c.json({ error: "internal_error" }, 500); }
});

dash.get("/api/control/projects", async (c) => {
  try {
    const org = c.req.query("org") || "";
    return c.json({ projects: org ? await listProjects(c.env, org) : [] });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

dash.get("/api/control/regions", async (c) => {
  try {
    const org = c.req.query("org") || "";
    const project = c.req.query("project") || ALL;
    return c.json({ regions: org ? await listRegions(c.env, org, project) : [] });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

// One-shot payload for the dashboard: filters + all dropdown options + filtered services + summary.
dash.get("/api/control/overview", async (c) => {
  try {
    const orgs = await listOrgs(c.env);
    const f = readFilter(c);
    // When no org is specified (or ALL), show aggregate across all orgs
    const org = (f.org && f.org !== ALL && orgs.includes(f.org)) ? f.org : undefined;
    if (orgs.length === 0) return c.json({ orgs, projects: [], regions: [], services: [], summary: summarize([]), filters: { org: ALL, project: ALL, region: ALL, status: f.status ?? ALL, q: f.q ?? "" } });

    const projects = org ? await listProjects(c.env, org) : [];
    const project = (f.project && f.project !== ALL && projects.includes(f.project)) ? f.project : ALL;
    const regions = org ? await listRegions(c.env, org, project) : [];
    const region = (f.region && f.region !== ALL && regions.includes(f.region)) ? f.region : ALL;

    const services = await listServices(c.env, { org, project: project !== ALL ? project : undefined, region: region !== ALL ? region : undefined, status: f.status, q: f.q });
    return c.json({
      orgs, projects, regions,
      filters: { org: org ?? ALL, project, region, status: f.status ?? ALL, q: f.q ?? "" },
      services,
      summary: summarize(services),
    });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

dash.get("/api/control/activity", async (c) => {
  try {
    const f = readFilter(c);
    const limit = parseInt(c.req.query("limit") || "20", 10);
    return c.json({ activity: await listActivity(c.env, f, isNaN(limit) ? 20 : limit) });
  } catch { return c.json({ error: "internal_error" }, 500); }
});


dash.get("/api/control/export", async (c) => {
  try {
    const f = readFilter(c);
    const services = await listServices(c.env, f);
    if ((c.req.query("format") || "json") === "csv") {
      const cols = ["org", "project", "region", "name", "kind", "status", "latency_ms", "version", "url", "last_check"];
      const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const rows = services.map(s => cols.map(k => esc((s as unknown as Record<string, unknown>)[k])).join(","));
      const csv = [cols.join(","), ...rows].join("\n");
      return new Response(csv, { headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=services.csv" } });
    }
    return c.json({ services });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

dash.get("/api/control/docs", (c) => c.json({
  service: "ai-infrastructure control-plane",
  endpoints: [
    { method: "GET", path: "/api/control/overview", auth: false, query: "org, project, region, status, q", desc: "Filters + dropdown options + filtered services + health summary (one shot)." },
    { method: "GET", path: "/api/control/orgs", auth: false, desc: "Distinct organizations." },
    { method: "GET", path: "/api/control/projects?org=", auth: false, desc: "Projects within an org." },
    { method: "GET", path: "/api/control/regions?org=&project=", auth: false, desc: "Regions within an org/project." },
    { method: "GET", path: "/api/control/activity?org=&project=&limit=", auth: false, desc: "Recent activity / What Changed feed." },
    { method: "GET", path: "/api/control/services/:id", auth: false, desc: "Service detail + recent health-check history." },
    { method: "GET", path: "/api/control/export?format=csv|json", auth: false, desc: "Export the filtered service set." },
    { method: "GET", path: "/api/control/stats?window=86400000&org=", auth: false, desc: "Gateway request counts, error rates, latency (avg + p95), cache hit rate, token usage, fallback rate — aggregated from cost_ledger." },
    { method: "POST", path: "/api/control/services", auth: true, body: "{org, project, region?, name, kind?, url?, version?, status?}", desc: "Register or update a service." },
    { method: "PATCH", path: "/api/control/services/:id/status", auth: true, body: "{status: healthy|degraded|down|unknown}", desc: "Manually set service status (for local services the cron cannot reach)." },
    { method: "DELETE", path: "/api/control/services/:id", auth: true, desc: "Remove a service." },
    { method: "POST", path: "/api/control/activity", auth: true, body: "{org, project?, service?, kind?, message, detail?}", desc: "Ingest an external event (deploy, config change) into the activity feed." },
    { method: "POST", path: "/api/control/health-check", auth: true, desc: "Trigger an immediate health sweep of all public endpoints." },
    { method: "GET", path: "/api/control/incidents", auth: true, query: "org, status", desc: "List incidents with open/critical stats." },
    { method: "POST", path: "/api/control/incidents", auth: true, body: "{org, title, severity?, project?, detail?, affected_users?}", desc: "Create incident." },
    { method: "PATCH", path: "/api/control/incidents/:id", auth: true, body: "{status?, severity?, detail?, affected_users?, sla_breached?}", desc: "Update incident." },
    { method: "DELETE", path: "/api/control/incidents/:id", auth: true, desc: "Delete incident." },
    { method: "GET", path: "/api/control/logs", auth: true, query: "limit, status, service", desc: "Health-check log entries joined with service metadata." },
    { method: "GET", path: "/api/control/observability", auth: true, query: "window", desc: "SLO metrics, per-service latency, instrumentation coverage." },
    { method: "GET", path: "/api/control/access/session", auth: false, desc: "Session info (role, MFA status, expiry) — reflects Bearer token validity." },
    { method: "POST", path: "/api/control/access/extend-session", auth: true, desc: "Extend current session by 8h." },
    { method: "POST", path: "/api/control/access/renew-session", auth: true, desc: "Renew session and re-verify MFA status." },
    { method: "POST", path: "/api/control/access/logout", auth: true, desc: "Invalidate current session." },
    { method: "GET", path: "/api/control/access/audit", auth: true, query: "org, limit", desc: "Audit log entries (config changes, status changes, deploys)." },
    { method: "GET", path: "/api/control/tokens", auth: true, query: "org", desc: "List service tokens — hashes never returned." },
    { method: "POST", path: "/api/control/tokens", auth: true, body: "{org, name, scope?, expires_in_days?}", desc: "Create service token — raw token returned once only." },
    { method: "DELETE", path: "/api/control/tokens/:id", auth: true, desc: "Revoke service token." },
  ],
}));

// ---- improvement 2: service detail with uptime % -----------------------

// Override the plain service detail route to include uptime.
dash.get("/api/control/services/:id", async (c) => {
  try {
    const id = c.req.param("id") ?? "";
    const svc = await getService(c.env, id);
    if (!svc) return c.json({ error: "not_found" }, 404);
    const [checks, uptime] = await Promise.all([recentChecks(c.env, id), uptimePercent(c.env, id)]);
    return c.json({ service: svc, checks, uptime });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

// ---- write APIs (Bearer GATEWAY_KEY) ----------------------------------

dash.post("/api/control/services", verifyAuth, async (c) => {
  let body: { org?: string; project?: string; region?: string; name?: string; kind?: string; url?: string | null; version?: string | null; status?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body.org || !body.project || !body.name) return c.json({ error: "org_project_name_required" }, 400);
  if (!/^[A-Za-z0-9 ._-]{1,64}$/.test(body.name)) return c.json({ error: "invalid_service_name", message: "Service name must be 1–64 chars, letters/digits/spaces/._- only." }, 400);
  const allowed = new Set(["healthy", "degraded", "down", "unknown"]);
  try {
    const svc = await upsertService(c.env, {
      org: body.org, project: body.project, region: body.region, name: body.name,
      kind: body.kind, url: body.url, version: body.version,
      status: body.status && allowed.has(body.status) ? body.status as "healthy" | "degraded" | "down" | "unknown" : undefined,
    });
    return c.json({ service: svc }, 201);
  } catch { return c.json({ error: "internal_error" }, 500); }
});

dash.delete("/api/control/services/:id", verifyAuth, async (c) => {
  try { return (await deleteService(c.env, c.req.param("id") ?? "")) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404); }
  catch { return c.json({ error: "internal_error" }, 500); }
});

// improvement 2: manual status override (for local services cron can't reach)
dash.patch("/api/control/services/:id/status", verifyAuth, async (c) => {
  let body: { status?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  const allowed = new Set(["healthy", "degraded", "down", "unknown"]);
  if (!body.status || !allowed.has(body.status)) return c.json({ error: "status must be healthy|degraded|down|unknown" }, 400);
  try {
    const svc = await updateServiceStatus(c.env, c.req.param("id") ?? "", body.status as "healthy" | "degraded" | "down" | "unknown");
    if (!svc) return c.json({ error: "not_found" }, 404);
    return c.json({ service: svc });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

// improvement 5: deploy / external event ingest for CI hooks
dash.post("/api/control/activity", verifyAuth, async (c) => {
  let body: { org?: string; project?: string; service?: string; kind?: string; message?: string; detail?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body.org || !body.message) return c.json({ error: "org_and_message_required" }, 400);
  try {
    await ingestEvent(c.env, { org: body.org, project: body.project ?? null, service: body.service ?? null, kind: body.kind ?? "deploy", message: body.message, detail: body.detail ?? null });
    return c.json({ ok: true });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

dash.post("/api/control/health-check", verifyAuth, async (c) => {
  try {
    const checked = await runHealthChecks(c.env);
    await logActivity(c.env, { org: "3Sixty Co.", kind: "check", message: `Manual health sweep checked ${checked} services` });
    return c.json({ ok: true, checked });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

// ---- cost API route -------------------------------------------------------
dash.get("/api/control/cost", async (c) => {
  const windowMs = parseInt(c.req.query("window") || "86400000", 10);
  const since = Date.now() - windowMs;
  try {
    const result = await c.env.DB.prepare(
      `SELECT model, SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, COUNT(*) as requests
       FROM cost_ledger WHERE created_at > ? GROUP BY model ORDER BY total_input DESC`
    ).bind(since).all<{model:string;total_input:number;total_output:number;requests:number}>();
    const PRICING: Record<string,{i:number;o:number}> = {
      "anthropic/claude-haiku-4.5":{i:0.25,o:1.25},
      "anthropic/claude-sonnet-4-6":{i:3.0,o:15.0},
      "anthropic/claude-opus-4-7":{i:15.0,o:75.0},
      "openai/gpt-4o-mini":{i:0.15,o:0.6},
    };
    let total = 0;
    const byModel = (result.results||[]).map(r => {
      const p = PRICING[r.model] ?? {i:1.0,o:5.0};
      const cost = ((r.total_input||0)/1e6*p.i)+((r.total_output||0)/1e6*p.o);
      total += cost;
      return {model:r.model,input_tokens:r.total_input||0,output_tokens:r.total_output||0,cost_usd:Math.round(cost*10000)/10000,requests:r.requests||0};
    });
    const projectedMonthly = windowMs>0 ? Math.round(total/(windowMs/(30*24*3600*1000))*100)/100 : 0;
    return c.json({total_cost_usd:Math.round(total*10000)/10000,projected_monthly_usd:projectedMonthly,by_model:byModel,window_ms:windowMs});
  } catch { return c.json({error:"internal_error"},500); }
});

// ---- extra routes (incidents, logs, access, tokens, observability) ------
dash.route("/", extra);

// ---- served dashboard --------------------------------------------------
// no-store: the dashboard HTML is an inline build artifact that changes on
// every deploy. Without this, browsers heuristic-cache it and keep rendering
// the previous build's UI (stale font, old banners) across deploys.
const HTML_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
} as const;

dash.get("/", (c) => c.html(PAGE, 200, HTML_HEADERS));
dash.get("/dashboard", (c) => c.html(PAGE, 200, HTML_HEADERS));

export default dash;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>3Sixty Co. — Control Plane</title>
<link rel="icon" type="image/png" href="https://3sixtyco.dev/3sixty-favicon.png" />
<link rel="apple-touch-icon" href="https://3sixtyco.dev/3sixty-favicon.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800;1,9..40,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#0a0a0a;--panel:#111;--panel2:#161616;--panel3:#1a1a1a;
    --border:#222;--border2:#2c2c2c;--text:#e8e8e8;--muted:#7a7a7a;
    --accent:#e94560;--accent-bg:rgba(233,69,96,.12);--accent-border:rgba(233,69,96,.35);
    --healthy:#3fb950;--degraded:#d29922;--down:#e94560;--unknown:#6e7681;--r:12px;
    --sidebar:220px;
  }
  html,body{height:100%;background:var(--bg);color:var(--text);font-family:'DM Sans',system-ui,sans-serif;-webkit-font-smoothing:antialiased;font-size:14px}
  h1,h2,h3,h4,.syne{font-family:'DM Sans',sans-serif}
  .mono{font-family:'JetBrains Mono',monospace}
  a{color:var(--accent);text-decoration:none}
  .app{display:flex;height:100vh;overflow:hidden}
  .sidebar{width:var(--sidebar);min-width:var(--sidebar);background:var(--panel);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto;flex-shrink:0}
  .main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}
  .topbar{padding:0 16px;height:52px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-shrink:0;background:var(--panel);overflow:hidden;min-width:0}
  .content{flex:1;overflow-y:auto;padding:20px}
  .sidebar-logo{height:52px;padding:0 14px;display:flex;flex-direction:column;justify-content:center;border-bottom:1px solid var(--border)}
  .sidebar-logo .name{font-family:'DM Sans';font-size:13px;font-weight:700;letter-spacing:.04em}
  .sidebar-logo .sub{font-size:10px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;margin-top:1px}
  .nav-section{padding:10px 10px 4px}
  .nav-label{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);padding:0 6px;margin-bottom:4px;font-weight:600}
  .nav-item{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer;font-size:13px;color:var(--muted);transition:background .12s,color .12s;user-select:none}
  .nav-item:hover{background:var(--panel2);color:var(--text)}
  .nav-item.active{background:var(--accent-bg);color:var(--accent);font-weight:500}
  .nav-item .icon{width:16px;text-align:center;font-style:normal;flex-shrink:0;font-size:13px}
  .nav-badge{margin-left:auto;font-size:10px;font-weight:700;padding:1px 6px;border-radius:999px;background:var(--accent);color:#fff}
  .topbar-tab-badge{display:inline-flex;align-items:center;font-size:10px;font-weight:700;letter-spacing:.1em;padding:3px 10px;border-radius:999px;text-transform:uppercase;background:rgba(63,185,80,.12);color:var(--healthy);flex-shrink:0;border:1px solid rgba(63,185,80,.2)}
  .topbar-crumb{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;max-width:180px;flex-shrink:1}
  .topbar-sep{width:1px;height:18px;background:var(--border2);flex-shrink:0}
  .topbar-filter-grp{display:flex;align-items:center;gap:4px;flex-shrink:1;min-width:0}
  .topbar-filter-lbl{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:700;white-space:nowrap}
  .topbar-right{margin-left:auto;display:flex;align-items:center;gap:6px;flex-shrink:0}
  .seg{display:inline-flex;background:var(--panel2);border:1px solid var(--border);border-radius:999px;padding:3px;gap:2px}
  .seg button{background:transparent;border:none;color:var(--muted);padding:5px 13px;border-radius:999px;font:inherit;font-size:12px;cursor:pointer}
  .seg button.active{background:var(--accent-bg);color:var(--accent);font-weight:500}
  .topbar-sel{background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 8px;font:inherit;font-size:12px;cursor:pointer;max-width:120px;min-width:0}
  .panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--r)}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);padding:16px}
  .section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
  .section-title{font-family:'DM Sans';font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:700}
  .btn{display:inline-flex;align-items:center;gap:6px;background:var(--panel2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:7px 13px;font:inherit;font-size:12px;cursor:pointer;transition:border-color .12s,background .12s}
  .btn:hover{border-color:#3a3a3a;background:var(--panel3)}
  .btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
  .btn.primary:hover{background:#d03a52}
  .btn.danger{color:var(--accent);border-color:var(--accent-border)}
  .btn.danger:hover{background:var(--accent-bg)}
  .btn.ghost{background:transparent;border-color:transparent}
  .btn.ghost:hover{background:var(--panel2);border-color:var(--border)}
  .badge{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.08em;padding:3px 8px;border-radius:999px;text-transform:uppercase}
  .badge.healthy,.badge.ok{color:var(--healthy);background:rgba(63,185,80,.12)}
  .badge.degraded{color:var(--degraded);background:rgba(210,153,34,.12)}
  .badge.down,.badge.error{color:var(--down);background:rgba(233,69,96,.12)}
  .badge.unknown{color:var(--unknown);background:rgba(110,118,129,.14)}
  .badge.p0{color:#ff4d4d;background:rgba(255,77,77,.13)}
  .badge.p1{color:#ff9900;background:rgba(255,153,0,.13)}
  .badge.p2{color:#ffd700;background:rgba(255,215,0,.13)}
  .badge.p3{color:var(--muted);background:rgba(110,118,129,.14)}
  .badge.sla{color:var(--down);background:rgba(233,69,96,.15);border:1px solid rgba(233,69,96,.3)}
  .badge.admin{color:var(--accent);background:var(--accent-bg);border:1px solid var(--accent-border)}
  .badge.operator{color:#7c9ef7;background:rgba(124,158,247,.12)}
  .badge.viewer{color:var(--muted);background:rgba(110,118,129,.14)}
  .badge.live{color:var(--healthy);background:rgba(63,185,80,.12);animation:pulse 2s ease-in-out infinite}
  .badge.idle{color:var(--muted);background:rgba(110,118,129,.1)}
  .badge.warn{color:#ff9900;background:rgba(255,153,0,.13)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}
  .stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px}
  .stat-tile{padding:14px 16px;background:var(--panel);border:1px solid var(--border);border-radius:var(--r)}
  .stat-tile .val{font-family:'DM Sans';font-size:22px;font-weight:800;line-height:1}
  .stat-tile .lbl{font-size:10px;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;margin-top:4px}
  .stat-tile.accent .val{color:var(--accent)}
  .stat-tile.green .val{color:var(--healthy)}
  table.tbl{width:100%;border-collapse:collapse;font-size:12.5px}
  table.tbl th{text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);color:var(--muted);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;font-weight:600}
  table.tbl td{padding:9px 12px;border-bottom:1px solid var(--border)}
  table.tbl tbody tr:hover{background:var(--panel2)}
  input[type=text],select,textarea{background:var(--panel2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:7px 11px;font:inherit;font-size:13px}
  input[type=text]:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
  select{cursor:pointer}
  .tab-bar{display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:16px}
  .tab-btn{padding:8px 14px;background:transparent;border:none;color:var(--muted);font:inherit;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
  .tab-btn.active{color:var(--text);border-bottom-color:var(--accent)}
  .tab-btn .cnt{font-size:10px;margin-left:4px;background:var(--panel2);padding:1px 6px;border-radius:999px}
  .toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px}
  .toolbar-right{margin-left:auto;display:flex;align-items:center;gap:8px}
  .search-box{display:flex;align-items:center;gap:6px;background:var(--panel2);border:1px solid var(--border2);border-radius:8px;padding:5px 10px}
  .search-box input{background:transparent;border:none;color:var(--text);font:inherit;font-size:13px;min-width:180px;outline:none}
  .banner{padding:10px 14px;border-radius:var(--r);font-size:13px;display:flex;align-items:center;gap:10px;margin-bottom:14px}
  .banner.danger{background:rgba(233,69,96,.1);border:1px solid rgba(233,69,96,.35);color:#f87171}
  .banner.warn{background:rgba(255,153,0,.1);border:1px solid rgba(255,153,0,.3);color:#fbbf24}
  .banner .dismiss{margin-left:auto;background:transparent;border:none;color:inherit;cursor:pointer;font-size:16px;line-height:1}
  .grid-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
  .svc-card{padding:14px;cursor:pointer;transition:border-color .15s}
  .svc-card:hover{border-color:var(--border2)}
  .svc-card .top{display:flex;justify-content:space-between;align-items:center}
  .svc-card .nm{font-weight:600;font-size:14px}
  .svc-card .meta{color:var(--muted);font-size:11px;margin-top:7px;display:flex;gap:8px;flex-wrap:wrap}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .dot.healthy{background:var(--healthy)}.dot.degraded{background:var(--degraded)}.dot.down{background:var(--down)}.dot.unknown{background:var(--unknown)}
  .inc-card{padding:16px 18px;margin-bottom:10px;cursor:pointer;transition:border-color .15s}
  .inc-card:hover{border-color:var(--border2)}
  .inc-card.p0{border-left:3px solid #ff4d4d}
  .inc-card.p1{border-left:3px solid #ff9900}
  .inc-card.p2{border-left:3px solid #ffd700}
  .inc-card .inc-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
  .inc-card .inc-title{font-weight:600;font-size:14px;margin-right:auto}
  .inc-card .inc-meta{font-size:12px;color:var(--muted);display:flex;gap:12px;flex-wrap:wrap}
  .inc-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
  .inc-stat{padding:14px;text-align:center}
  .inc-stat .n{font-family:'DM Sans';font-size:28px;font-weight:800}
  .inc-stat .k{font-size:10px;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;margin-top:3px}
  .log-row{display:grid;grid-template-columns:160px 46px 130px 80px 1fr 160px;gap:0;border-bottom:1px solid var(--border);align-items:center;font-size:12px;font-family:'JetBrains Mono',monospace}
  .log-row:hover{background:var(--panel2)}
  .log-row .lc{padding:7px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .log-row .svc-chip{display:inline-flex;align-items:center;justify-content:center;width:28px;height:22px;border-radius:5px;background:var(--panel3);font-size:10px;font-weight:700;letter-spacing:.04em}
  .log-hdr{background:var(--panel2);color:var(--muted);font-size:10px;letter-spacing:.08em;text-transform:uppercase;font-family:'DM Sans',sans-serif}
  .metric-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:16px}
  .metric-card{padding:14px;background:var(--panel);border:1px solid var(--border);border-radius:var(--r)}
  .metric-card .mv{font-family:'DM Sans';font-size:20px;font-weight:800;line-height:1.1}
  .metric-card .mk{font-size:10px;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;margin-top:4px}
  .metric-card .ms{font-size:11px;color:var(--muted);margin-top:2px}
  .bar-chart{display:flex;align-items:flex-end;gap:4px;height:60px;margin:8px 0 4px}
  .bar-chart .bc-bar{flex:1;border-radius:3px 3px 0 0;background:var(--accent);opacity:.7;min-height:2px}
  .bar-labels{display:flex;gap:4px;font-size:10px;color:var(--muted);font-family:'DM Sans',sans-serif}
  .bar-labels span{flex:1;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .coverage-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px}
  .slo-row{display:grid;grid-template-columns:1fr 80px 80px 80px;gap:0;border-bottom:1px solid var(--border);padding:8px 12px;align-items:center;font-size:13px}
  .access-card{padding:18px;margin-bottom:14px}
  .avatar{width:38px;height:38px;border-radius:50%;background:var(--accent-bg);border:1px solid var(--accent-border);display:flex;align-items:center;justify-content:center;font-family:'DM Sans';font-weight:700;font-size:14px;color:var(--accent)}
  .risk-ring{width:52px;height:52px;border-radius:50%;border:3px solid var(--accent);display:flex;align-items:center;justify-content:center;flex-direction:column;flex-shrink:0}
  .risk-ring .rv{font-family:'DM Sans';font-size:15px;font-weight:800;color:var(--accent)}
  .risk-ring .rl{font-size:8px;letter-spacing:.1em;color:var(--muted);text-transform:uppercase}
  .kv-row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px}
  .kv-row .k{color:var(--muted)}
  .kv-row .v{font-family:'DM Sans',sans-serif;font-size:12px}
  .role-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}
  .role-card{padding:12px;border-radius:var(--r);border:1px solid var(--border);text-align:center}
  .role-card.current{border-color:var(--accent);background:var(--accent-bg)}
  .role-card .rn{font-family:'DM Sans';font-size:13px;font-weight:700;margin-bottom:3px}
  .perm-matrix{width:100%;border-collapse:collapse;font-size:12.5px}
  .perm-matrix th{padding:8px 10px;border-bottom:1px solid var(--border);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600;text-align:center}
  .perm-matrix th:first-child{text-align:left}
  .perm-matrix th.admin-col{color:var(--accent)}
  .perm-matrix td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:center}
  .perm-matrix td:first-child{text-align:left}
  .perm-matrix tbody tr:hover{background:var(--panel2)}
  .perm-matrix .perm-name{font-weight:500;font-size:13px}
  .perm-matrix .perm-desc{font-size:11px;color:var(--muted);margin-top:2px}
  .perm-matrix .perm-req{font-size:10px;color:var(--muted);margin-top:2px}
  .perm-matrix .granted{color:var(--healthy);font-size:15px}
  .perm-matrix .off{color:var(--border2);font-size:15px}
  .perm-section-hdr td{background:var(--panel2);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:700;padding:6px 10px;border-bottom:1px solid var(--border)}
  .session-expire.expired{color:var(--down)}
  .drawer{position:fixed;top:0;right:0;height:100%;width:min(440px,92vw);background:var(--panel);border-left:1px solid var(--border);transform:translateX(100%);transition:transform .22s ease;z-index:50;overflow-y:auto;padding:22px}
  .drawer.open{transform:translateX(0)}
  .drawer .close-btn{position:absolute;top:14px;right:16px;background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer}
  .scrim{position:fixed;inset:0;background:rgba(0,0,0,.6);opacity:0;pointer-events:none;transition:opacity .2s;z-index:40}
  .scrim.open{opacity:1;pointer-events:auto}
  .modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:60;display:none;align-items:center;justify-content:center}
  .modal-bg.open{display:flex}
  .modal{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);padding:24px;width:min(480px,92vw);max-height:85vh;overflow-y:auto}
  .modal h3{font-family:'DM Sans';font-size:16px;margin-bottom:16px}
  .field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
  .field label{font-size:11px;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;font-weight:600}
  .spark{display:flex;align-items:flex-end;gap:2px;height:36px;margin:8px 0}
  .spark span{flex:1;min-height:2px;border-radius:2px 2px 0 0;opacity:.7}
  .empty{text-align:center;color:var(--muted);padding:60px 20px}
  .empty .hint{font-size:12px;margin-top:6px;color:#555}
  .fresh{font-size:11px;color:var(--muted)}
  .countdown{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted)}
  .divider{border:none;border-top:1px solid var(--border);margin:14px 0}
  /* ── Observability improvements ── */
  .obs-wizard{background:rgba(233,69,96,.07);border:1px dashed rgba(233,69,96,.4);border-radius:var(--r);padding:18px 20px;margin-bottom:14px}
  .obs-wizard h4{font-size:14px;font-weight:700;margin-bottom:4px;color:var(--text)}
  .obs-wizard .wiz-step{display:flex;align-items:flex-start;gap:10px;margin-top:10px}
  .obs-wizard .wiz-num{width:22px;height:22px;border-radius:50%;background:var(--accent);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
  .obs-wizard .code-block{background:var(--panel2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text);margin-top:6px;position:relative;word-break:break-all;line-height:1.7}
  .obs-wizard .copy-btn{position:absolute;top:6px;right:6px;background:var(--panel3);border:1px solid var(--border2);border-radius:5px;color:var(--muted);font-size:10px;padding:2px 7px;cursor:pointer;transition:color .12s}
  .obs-wizard .copy-btn:hover{color:var(--text)}
  .obs-partial{background:rgba(210,153,34,.09);border:1px solid rgba(210,153,34,.3);border-radius:var(--r);padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px;font-size:13px;color:#fbbf24}
  .obs-partial .partial-svc{font-family:'JetBrains Mono',monospace;font-size:12px;background:rgba(210,153,34,.15);padding:1px 7px;border-radius:4px}
  .svc-pills{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
  .svc-pill{display:inline-flex;align-items:center;gap:5px;background:var(--panel2);border:1px solid var(--border2);border-radius:999px;padding:4px 10px 4px 7px;font-size:12px;cursor:pointer;transition:border-color .12s,background .12s;user-select:none}
  .svc-pill:hover{border-color:#3a3a3a;background:var(--panel3)}
  .svc-pill.active{border-color:var(--accent);background:var(--accent-bg);color:var(--accent)}
  .svc-pill .pd{width:7px;height:7px;border-radius:50%;flex-shrink:0}
  .obs-sub-tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:14px}
  .obs-sub-btn{padding:7px 12px;background:transparent;border:none;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .12s;white-space:nowrap}
  .obs-sub-btn:hover{color:var(--text)}
  .obs-sub-btn.active{color:var(--text);border-bottom-color:var(--accent);font-weight:500}
  .obs-sub-btn .cnt{font-size:10px;margin-left:4px;background:var(--panel2);padding:1px 5px;border-radius:999px;font-weight:400}
  .spark-inline{display:flex;align-items:flex-end;gap:1.5px;height:28px;margin-top:6px}
  .spark-inline span{flex:1;min-height:2px;border-radius:2px 2px 0 0;opacity:.65}
  .metric-trend{font-size:10px;margin-top:3px;display:flex;align-items:center;gap:3px}
  .metric-trend.up{color:#f87171}
  .metric-trend.down-good{color:var(--healthy)}
  .metric-trend.flat{color:var(--muted)}
  .slo-delta{font-size:10px;margin-left:5px;font-family:'DM Sans',sans-serif}
  .slo-delta.near{color:#fbbf24}
  .slo-delta.safe{color:var(--healthy)}
  .slo-delta.ok{color:var(--muted)}
  .cov-signal{display:flex;gap:8px;margin:10px 0 4px}
  .cov-signal-bar{display:flex;flex-direction:column;align-items:center;gap:3px;flex:1}
  .cov-signal-bar .csbg{width:100%;height:44px;background:var(--panel2);border-radius:4px;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end}
  .cov-signal-bar .csfill{background:var(--accent);opacity:.7;border-radius:4px 4px 0 0;transition:height .3s}
  .cov-signal-bar .cslbl{font-size:10px;color:var(--muted);letter-spacing:.04em;text-align:center}
  .cov-signal-bar .cspct{font-size:10px;font-family:'DM Sans',sans-serif;color:var(--text)}
  .cov-setup-link{margin-left:auto;font-size:11px;color:var(--accent);cursor:pointer;flex-shrink:0}
  .cov-setup-link:hover{text-decoration:underline}
  .inline-bar-wrap{width:100%;display:flex;align-items:center}
  .inline-bar-bg{flex:1;height:4px;background:var(--panel2);border-radius:2px;overflow:hidden}
  .inline-bar-fill{height:100%;border-radius:2px;background:var(--accent);transition:width .4s}
  .obs-layout{display:grid;grid-template-columns:1fr 230px;gap:14px;align-items:start}
  .sug-panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);padding:14px;margin-bottom:12px}
  .sug-title{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:8px}
  .sug-action{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px;color:var(--text);border:1px solid transparent;transition:background .12s,border-color .12s;margin-bottom:4px}
  .sug-action:hover{background:rgba(124,108,247,.12);border-color:rgba(124,108,247,.35)}
  .sug-action .sa-icon{font-size:13px;color:#a78bfa;flex-shrink:0}
  .alerts-wrap{position:relative;display:inline-flex}
  .alerts-flyout{position:absolute;top:calc(100% + 8px);right:0;width:300px;background:var(--panel);border:1px solid var(--border);border-radius:var(--r);z-index:30;box-shadow:0 8px 32px rgba(0,0,0,.45);display:none;max-height:340px;overflow-y:auto}
  .alerts-flyout.open{display:block}
  .alerts-flyout-hdr{padding:9px 14px;border-bottom:1px solid var(--border);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:700}
  .alerts-flyout-item{padding:10px 14px;border-bottom:1px solid var(--border);font-size:12px;cursor:pointer;display:flex;align-items:center;gap:8px}
  .alerts-flyout-item:last-child{border-bottom:none}
  .alerts-flyout-item:hover{background:var(--panel2)}
  .obs-cd{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--muted);margin-right:4px}
  /* Compact density mode */
  .app.compact .content{padding:12px}
  .app.compact .metric-card{padding:10px 12px}
  .app.compact .metric-card .mv{font-size:16px}
  .app.compact .metric-card .mk{font-size:9px}
  .app.compact .spark-inline{height:20px}
  .app.compact .panel{border-radius:8px}
  .app.compact .stat-tile{padding:10px 12px}
  .app.compact .stat-tile .val{font-size:18px}
  .app.compact .card{padding:12px}
  @media(max-width:900px){.obs-layout{grid-template-columns:1fr}}
  @media(max-width:640px){.sidebar{display:none}.log-row{grid-template-columns:90px 36px 80px 60px 1fr}.inc-stats{grid-template-columns:repeat(2,1fr)}}
  @media(prefers-reduced-motion:reduce){.drawer,.scrim,.modal-bg,.badge.live{transition:none;animation:none}}
  @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
  .shimmer{background:linear-gradient(90deg,var(--panel) 25%,var(--panel2) 50%,var(--panel) 75%);background-size:200%;animation:shimmer 1.5s infinite}
  .role-preview-overlay{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid var(--accent-border);border-radius:var(--r);padding:12px 18px;font-size:13px;z-index:100;box-shadow:0 4px 20px rgba(0,0,0,.4);animation:slideUp .2s ease}
  @keyframes slideUp{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
  .ai-wrap{display:flex;flex-direction:column;height:calc(100vh - 52px)}
  .ai-messages{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:10px;min-height:0}
  .ai-msg{max-width:78%;display:flex;flex-direction:column;gap:3px}
  .ai-msg.user{align-self:flex-end}.ai-msg.assistant{align-self:flex-start}
  .ai-bubble{padding:10px 14px;border-radius:12px;font-size:13px;line-height:1.6;word-break:break-word;white-space:pre-wrap}
  .ai-msg.user .ai-bubble{background:var(--accent-bg);border:1px solid var(--accent-border);color:var(--text);border-radius:12px 12px 2px 12px}
  .ai-msg.assistant .ai-bubble{background:var(--panel2);border:1px solid var(--border);color:var(--text);border-radius:12px 12px 12px 2px}
  .ai-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--muted);text-align:center;padding:40px 20px}
  .ai-empty .ai-icon{font-size:36px;opacity:.35;margin-bottom:4px}
  .ai-empty .ai-hint{font-size:12px;max-width:280px;line-height:1.6}
  .ai-input-row{padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:flex-end;background:var(--panel);flex-shrink:0}
  .ai-textarea{flex:1;background:var(--panel2);border:1px solid var(--border2);border-radius:10px;padding:10px 12px;color:var(--text);font:inherit;font-size:13px;resize:none;min-height:40px;max-height:130px;outline:none;line-height:1.5;transition:border-color .12s}
  .ai-textarea:focus{border-color:var(--accent-border)}
  .ai-send{background:var(--accent);color:#fff;border:none;border-radius:10px;padding:10px 16px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;transition:opacity .12s;flex-shrink:0;line-height:1}
  .ai-send:hover{opacity:.85}.ai-send:disabled{opacity:.4;cursor:not-allowed}
  .ai-model-row{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--border);font-size:11px;color:var(--muted);flex-shrink:0}
  .ai-model-sel{background:var(--panel2);border:1px solid var(--border);border-radius:6px;padding:3px 8px;color:var(--text);font:inherit;font-size:11px;cursor:pointer}
  .ai-typing{display:inline-flex;gap:4px;align-items:center;padding:10px 14px}
  .ai-typing span{width:5px;height:5px;background:var(--muted);border-radius:50%;animation:aiBlink 1.2s infinite}
  .ai-typing span:nth-child(2){animation-delay:.2s}.ai-typing span:nth-child(3){animation-delay:.4s}
  @keyframes aiBlink{0%,80%,100%{opacity:.25}40%{opacity:1}}
</style>
</head>
<body>
<div class="app">
<nav class="sidebar" id="sidebar">
  <div class="sidebar-logo"><div class="name">3Sixty Co.</div><div class="sub">Control Plane</div></div>
  <div class="nav-section">
    <div class="nav-label">Monitor</div>
    <div class="nav-item active" data-tab="overview" onclick="nav(this)"><i class="icon">◈</i> Overview</div>
    <div class="nav-item" data-tab="incidents" onclick="nav(this)"><i class="icon">⚠</i> Incidents <span class="nav-badge" id="incBadge" style="display:none">0</span></div>
  </div>
  <div class="nav-section">
    <div class="nav-label">Explore</div>
    <div class="nav-item" data-tab="services" onclick="nav(this)"><i class="icon">⊞</i> Services</div>
    <div class="nav-item" data-tab="observability" onclick="nav(this)"><i class="icon">◎</i> Observability</div>
    <div class="nav-item" data-tab="topology" onclick="nav(this)"><i class="icon">⋈</i> Topology</div>
  </div>
  <div class="nav-section">
    <div class="nav-label">Control</div>
    <div class="nav-item" data-tab="logs" onclick="nav(this)"><i class="icon">≡</i> Logs</div>
    <div class="nav-item" data-tab="deploys" onclick="nav(this)"><i class="icon">↑</i> Deploys</div>
    <div class="nav-item" data-tab="access" onclick="nav(this)"><i class="icon">◉</i> Access</div>
  </div>
  <div class="nav-section">
    <div class="nav-label">AI</div>
    <div class="nav-item" data-tab="ai-assistant" onclick="nav(this)"><i class="icon">⬡</i> AI Assistant</div>
  </div>
</nav>
<div class="main">
<div class="topbar">
  <span class="topbar-tab-badge" id="topTitle">OVERVIEW</span>
  <span id="topBreadcrumb" class="topbar-crumb">All Orgs / All Projects</span>
  <div class="topbar-sep"></div>
  <div class="topbar-filter-grp">
    <span class="topbar-filter-lbl">Org</span>
    <select class="topbar-sel" id="orgSel" autocomplete="off"></select>
  </div>
  <div class="topbar-filter-grp">
    <span class="topbar-filter-lbl">Project</span>
    <select class="topbar-sel" id="projSel" autocomplete="off"></select>
  </div>
  <div class="topbar-filter-grp">
    <span class="topbar-filter-lbl">Region</span>
    <select class="topbar-sel" id="regionSel" autocomplete="off"></select>
  </div>
  <div class="topbar-right">
    <span class="fresh" id="fresh"></span>
    <button class="btn ghost" id="refreshBtn">↺ Refresh</button>
    <button class="btn ghost" id="exportBtn">↓ Export</button>
    <button class="btn ghost" id="pauseBtn">⏸ Pause</button>
    <select class="topbar-sel" id="refreshIntervalSel"><option value="30000">30s</option><option value="60000">1m</option><option value="300000">5m</option></select>
    <div class="alerts-wrap" id="alertsWrap">
      <button class="btn ghost" id="alertsBtn" onclick="toggleAlerts()">⚠ Alerts <span class="nav-badge" id="alertsBadge" style="display:none;margin-left:2px">0</span></button>
      <div class="alerts-flyout" id="alertsFlyout">
        <div class="alerts-flyout-hdr">Active Alerts</div>
        <div id="alertsFlyoutList"><div style="padding:14px;color:var(--muted);font-size:12px">No active alerts.</div></div>
      </div>
    </div>
  </div>
</div>
<div class="content" id="content">

<div id="tab-overview">
  <div class="stat-row" id="summary"></div>
  <div id="ovIncBanner" style="display:none" class="banner danger"><span>⚠</span><span id="ovIncText"></span><button class="btn ghost" style="font-size:11px;margin-left:8px;padding:4px 8px" onclick="nav(document.querySelector('[data-tab=incidents]'))">View →</button></div>
  <div style="margin-bottom:14px">
    <div class="section-header"><span class="section-title">LLM Gateway — Last 24h</span></div>
    <div class="stat-row" id="gwStats"></div>
    <div class="panel" style="overflow-x:auto;margin-top:10px">
      <table class="tbl"><thead><tr><th>Feature</th><th>Requests</th><th>Error Rate</th><th>Avg Latency</th><th>Cache Hit</th><th>Input Tokens</th><th>Fallback</th></tr></thead>
      <tbody id="featureTbody"><tr><td colspan="7" style="color:var(--muted);padding:20px;text-align:center">Loading…</td></tr></tbody></table>
    </div>
  </div>
  <div id="body"></div>
</div>

<div id="tab-services" style="display:none">
  <div class="toolbar" style="position:sticky;top:0;z-index:10;background:var(--bg);padding-bottom:8px">
    <select class="topbar-sel" id="statusSel" onchange="st.status=this.value;renderSvcBody()"><option value="__all__">All Statuses</option><option value="healthy">Healthy</option><option value="degraded">Degraded</option><option value="down">Down</option><option value="unknown">Unknown</option></select>
    <div class="search-box"><input type="text" id="searchQ" placeholder="filter services…" oninput="st.q=this.value.trim();renderSvcBody()" /></div>
    <span id="svcCount" class="fresh" style="margin-left:4px"></span>
    <div class="seg" id="viewSeg">
      <button class="active" data-v="comfortable" onclick="setView(this)">Comfortable</button>
      <button data-v="compact" onclick="setView(this)">Compact</button>
      <button data-v="ops" onclick="setView(this)">Ops Mode</button>
    </div>
    <button class="btn ghost" id="recheckAllBtn" onclick="recheckAll()">↺ Re-check all</button>
  </div>
  <div id="svcBody"></div>
</div>

<div id="tab-incidents" style="display:none">
  <div class="inc-stats">
    <div class="panel inc-stat"><div class="n" id="iOpen">—</div><div class="k">Open Tickets</div></div>
    <div class="panel inc-stat"><div class="n" id="iCrit" style="color:var(--down)">—</div><div class="k">Critical P0</div></div>
    <div class="panel inc-stat"><div class="n" id="iAffected">—</div><div class="k">Affected Users</div></div>
    <div class="panel inc-stat"><div class="n" id="iSla">—</div><div class="k">SLA Breached</div></div>
  </div>
  <div id="incSevChips" style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">
    <button class="btn ghost" style="font-size:11px" data-sev="__all__" onclick="filterIncSev(this)">All</button>
    <button class="btn ghost" style="font-size:11px" data-sev="P0" onclick="filterIncSev(this)">P0 Critical</button>
    <button class="btn ghost" style="font-size:11px" data-sev="P1" onclick="filterIncSev(this)">P1 High</button>
    <button class="btn ghost" style="font-size:11px" data-sev="P2" onclick="filterIncSev(this)">P2+ Other</button>
  </div>
  <div class="toolbar">
    <div class="tab-bar" style="margin-bottom:0;border:none">
      <button class="tab-btn active" data-itab="all" onclick="filterIncTab(this)">Incidents</button>
      <button class="tab-btn" data-itab="slo" onclick="filterIncTab(this)">SLO Budgets</button>
    </div>
    <div class="toolbar-right">
      <select class="topbar-sel" id="incStatusSel" onchange="loadIncidents()"><option value="__all__">All Statuses</option><option value="open">Open</option><option value="in_progress">In Progress</option><option value="identified">Identified</option><option value="resolved">Resolved</option></select>
      <button class="btn primary" onclick="openNewIncident()">+ New Incident</button>
    </div>
  </div>
  <div id="incList" style="margin-top:12px"></div>
</div>

<div id="tab-observability" style="display:none">
  <div class="toolbar">
    <div class="seg" id="timeSeg">
      <button data-w="900000" onclick="setTimeWindow(this)">15m</button>
      <button class="active" data-w="3600000" onclick="setTimeWindow(this)">1h</button>
      <button data-w="21600000" onclick="setTimeWindow(this)">6h</button>
      <button data-w="86400000" onclick="setTimeWindow(this)">24h</button>
      <button data-w="604800000" onclick="setTimeWindow(this)">7d</button>
    </div>
    <div class="toolbar-right">
      <span class="obs-cd" id="obsCountdown"></span>
      <span class="badge live" id="obsBadge">LIVE</span>
      <button class="btn ghost" onclick="loadObs()">↺ Refresh</button>
    </div>
  </div>
  <div class="obs-sub-tabs">
    <button class="obs-sub-btn active" data-otab="metrics" onclick="setObsTab(this)">Metrics <span class="cnt" id="obsTabMetricsCnt">6</span></button>
    <button class="obs-sub-btn" data-otab="traces" onclick="setObsTab(this)">Traces <span class="cnt" id="obsTabTracesCnt">—</span></button>
    <button class="obs-sub-btn" data-otab="logs" onclick="setObsTab(this)">Logs <span class="cnt">live tail</span></button>
    <button class="obs-sub-btn" data-otab="events" onclick="setObsTab(this)">Events <span class="cnt">deploys</span></button>
    <button class="obs-sub-btn" data-otab="cost" onclick="setObsTab(this)">Cost <span class="cnt">AI + infra</span></button>
    <button class="obs-sub-btn" data-otab="errors" onclick="setObsTab(this)">Errors <span class="cnt">triage</span></button>
  </div>
  <div id="obsPartialBanner" style="display:none" class="obs-partial">
    <span style="flex-shrink:0">◎</span>
    <span id="obsPartialText">1 service has incomplete health signals.</span>
    <button class="btn ghost" style="font-size:11px;padding:4px 9px;margin-left:auto" onclick="nav(document.querySelector('[data-tab=logs]'))">Inspect →</button>
    <button style="background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:16px;margin-left:6px" onclick="this.parentElement.style.display='none'">×</button>
  </div>
  <div id="obsWizard" style="display:none" class="obs-wizard">
    <h4 style="font-family:'DM Sans',sans-serif">● Live monitoring active — no health data in this window</h4>
    <p style="font-size:12px;color:var(--muted);margin-top:3px;font-family:'DM Sans',sans-serif">No health checks have run in the selected time range. Health checks run every 5 minutes. Widen the window or wait for the next probe cycle.</p>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn" style="font-size:12px" onclick="setTimeWindow(document.querySelector('[data-w=\'86400000\']'))">View 24h</button>
      <button class="btn" style="font-size:12px" onclick="loadObs()">↺ Refresh now</button>
    </div>
  </div>
  <div id="obsPills" class="svc-pills" style="display:none"></div>
  <div id="obsMainContent"><div class="obs-layout">
    <div style="min-width:0">
      <div class="metric-cards" id="obsMetrics"></div>
      <div class="section-header" style="margin-top:6px"><span class="section-title">Key Metrics</span></div>
      <div class="metric-cards" id="obsKeyMetrics"></div>
      <div class="panel" style="padding:16px;margin-bottom:12px">
        <div class="section-header"><span class="section-title">P99 Latency Per Service (ms)</span></div>
        <div id="latencyTable"></div>
      </div>
      <div class="panel" style="padding:16px;margin-bottom:12px">
        <div class="section-header"><span class="section-title">SLO Targets</span></div>
        <div id="sloRows"></div>
      </div>
      <div class="panel" style="padding:16px;margin-bottom:12px">
        <div class="section-header"><span class="section-title">Instrumentation Coverage</span><span id="coverageBadge" class="badge down">0/9</span></div>
        <div id="coverageList"></div>
      </div>
    </div>
    <div>
      <div class="sug-panel">
        <div class="sug-title">Suggested</div>
        <div class="sug-action" onclick="sug('Explain any anomalies in current observability data — error rate, latency spikes, health score')"><span class="sa-icon">✦</span><span>Explain anomaly</span></div>
        <div class="sug-action" onclick="sug('Analyze SLO trend — are we within P95 latency and error rate targets? What is the burn rate?')"><span class="sa-icon">✦</span><span>Check SLO trend</span></div>
        <div class="sug-action" onclick="sug('Compare current metrics to expected baseline — flag any services degraded, high error rate, or approaching SLO limits')"><span class="sa-icon">✦</span><span>Compare to baseline</span></div>
      </div>
      <div class="panel" style="padding:14px">
        <div class="section-title" style="margin-bottom:8px">Signal Coverage</div>
        <div class="cov-signal" id="covSignalBars"></div>
      </div>
    </div>
  </div>
</div></div><div id="obsTabContent" style="display:none"></div>
</div>

<div id="tab-topology" style="display:none">
  <div id="topologyToolbar" class="toolbar">
    <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);cursor:pointer">
      <input type="checkbox" id="topoFilterDegraded" onchange="loadTopology()" /> Show only degraded/down
    </label>
    <div style="margin-left:auto;display:flex;align-items:center;gap:12px;font-size:12px">
      <span><span class="dot healthy"></span> Healthy</span>
      <span><span class="dot degraded"></span> Degraded</span>
      <span><span class="dot down"></span> Down</span>
      <span><span class="dot unknown"></span> Unknown</span>
    </div>
    <button class="btn ghost" onclick="loadTopology()">↺ Refresh</button>
  </div>
  <div id="topologyBody"></div>
</div>

<div id="tab-logs" style="display:none">
  <div class="toolbar">
    <span id="logStatus" class="badge idle">IDLE</span>
    <span class="countdown" id="logCountdown">next in 30s</span>
    <select class="topbar-sel" id="logIntervalSel" onchange="setLogInterval()"><option value="30000">30s</option><option value="15000">15s</option><option value="60000">60s</option></select>
    <select class="topbar-sel" id="logSvcSel" onchange="loadLogs()"><option value="__all__">All services</option></select>
    <div class="toolbar-right">
      <button class="btn ghost" id="logPauseBtn" onclick="toggleLogPause()">⏸ Pause</button>
      <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);cursor:pointer"><input type="checkbox" id="autoScrollChk" checked /> Auto-scroll</label>
      <button class="btn ghost" id="exportLogsBtn">↓ Export CSV</button>
    </div>
  </div>
  <div class="toolbar" style="margin-top:-6px">
    <div class="search-box"><input type="text" id="logSearch" placeholder="Search logs…" oninput="renderLogs()" /></div>
    <label style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" id="regexChk" /> Regex</label>
    <div class="tab-bar" style="margin-bottom:0;border:none;margin-left:auto">
      <button class="tab-btn active" data-ltab="all" onclick="filterLogTab(this)">All <span class="cnt" id="logCntAll">0</span></button>
      <button class="tab-btn" data-ltab="ok" onclick="filterLogTab(this)">OK <span class="cnt" id="logCntOk">0</span></button>
      <button class="tab-btn" data-ltab="errors" onclick="filterLogTab(this)">Errors <span class="cnt" id="logCntErr">0</span></button>
    </div>
  </div>
  <div class="panel" style="overflow:hidden">
    <div class="log-row log-hdr"><div class="lc">Timestamp</div><div class="lc">Svc</div><div class="lc">Service</div><div class="lc">Status</div><div class="lc">Message</div><div class="lc">Trace ID</div></div>
    <div id="logRows" style="max-height:560px;overflow-y:auto"></div>
  </div>
</div>

<div id="tab-deploys" style="display:none">
  <div class="toolbar">
    <div style="display:flex;gap:6px;flex-wrap:wrap" id="deployKindChips">
      <button class="btn ghost" style="font-size:11px" data-kind="__all__" onclick="filterDeployKind(this)">All</button>
      <button class="btn ghost" style="font-size:11px" data-kind="deploy" onclick="filterDeployKind(this)">Deploy</button>
      <button class="btn ghost" style="font-size:11px" data-kind="rollback" onclick="filterDeployKind(this)">Rollback</button>
      <button class="btn ghost" style="font-size:11px" data-kind="incident" onclick="filterDeployKind(this)">Incident</button>
      <button class="btn ghost" style="font-size:11px" data-kind="config" onclick="filterDeployKind(this)">Config</button>
    </div>
    <div class="toolbar-right">
      <button class="btn ghost" onclick="loadActivity()">↺ Refresh</button>
      <button class="btn primary" style="font-size:11px" onclick="openRecordDeploy()">+ Record Deploy</button>
    </div>
  </div>
  <div class="panel" style="overflow-x:auto">
    <table class="tbl"><thead><tr><th>When</th><th>Kind</th><th>Project</th><th>Message</th></tr></thead>
    <tbody id="activityRows"><tr><td colspan="4" style="color:var(--muted);padding:20px;text-align:center">Loading…</td></tr></tbody></table>
  </div>
</div>

<div id="tab-access" style="display:none">
  <div class="tab-bar">
    <button class="tab-btn active" data-atab="access" onclick="switchAccessTab(this)">Access</button>
    <button class="tab-btn" data-atab="audit" onclick="switchAccessTab(this)">Audit Log</button>
    <button class="tab-btn" data-atab="tokens" onclick="switchAccessTab(this)">Service Tokens</button>
  </div>
  <div id="atab-access">
    <div class="banner danger" id="mfaBanner" style="display:none">
      <span>⚠</span><span>MFA coverage is unresolved for this session. Confirm identity assurance before performing restart, rollback, config, or token actions.</span>
      <button class="dismiss" onclick="this.parentElement.style.display='none'">×</button>
    </div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start">
      <div class="panel access-card" style="flex:1;min-width:280px">
        <div class="section-header"><span class="section-title">Effective Access</span><button class="btn ghost" style="font-size:11px" onclick="copySession()">Copy session info</button></div>
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
          <div class="avatar">F</div>
          <div style="flex:1"><div style="font-weight:600;font-size:14px" id="aIdentity">Loading…</div><div style="font-size:11px;color:var(--muted);margin-top:2px">Online · Region</div></div>
          <div class="risk-ring"><div class="rv" id="aRiskVal">—</div><div class="rl">RISK</div></div>
        </div>
        <div class="kv-row"><span class="k">SESSION STATUS</span><span id="aSessState" class="badge warn">—</span></div>
        <div class="kv-row"><span class="k">EFFECTIVE ROLE</span><span id="aRole" class="badge admin">—</span></div>
        <div class="kv-row"><span class="k">ACTOR</span><span class="v" id="aActorName">—</span></div>
        <div class="kv-row"><span class="k">SESSION EXPIRES</span><span class="v" id="aExpiry" style="font-family:'DM Sans',sans-serif;font-size:12px">—</span></div>
        <div class="kv-row"><span class="k">IDLE</span><span class="v" id="aIdle" style="font-family:'DM Sans',sans-serif;font-size:12px">—</span></div>
        <div class="kv-row"><span class="k">AUTH PROVIDER</span><span class="v" id="aProvider">—</span></div>
        <div class="kv-row"><span class="k">MFA STATUS</span><span id="aMfa" class="badge warn">—</span></div>
        <div class="kv-row"><span class="k">TIME LEFT</span><span class="v" id="aCountdown" style="font-family:'JetBrains Mono',monospace;font-size:12px">—</span></div>
        <hr class="divider"/>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
          <button class="btn" onclick="renewSession()">Renew Session</button>
          <button class="btn" onclick="extendSession()">Extend Session</button>
          <button class="btn ghost" onclick="setGatewayKey()">Set Gateway Key</button>
          <button class="btn danger" onclick="forceLogout()">Force Logout</button>
        </div>
        <div id="aSessErr" style="display:none;margin-top:10px;font-size:12px;color:var(--down);background:rgba(248,81,73,.08);border:1px solid rgba(248,81,73,.25);border-radius:6px;padding:8px 10px"></div>
      </div>
      <div style="flex:1;min-width:260px">
        <div class="section-title" style="margin-bottom:10px">Role Hierarchy</div>
        <div class="role-cards">
          <div class="role-card"><div class="rn">Viewer</div><div class="ri badge viewer" style="display:inline-block;margin-top:4px">INHERITED</div></div>
          <div class="role-card"><div class="rn">Operator</div><div class="ri badge operator" style="display:inline-block;margin-top:4px">INHERITED</div></div>
          <div class="role-card current"><div class="rn" style="color:var(--accent)">Admin</div><div class="ri badge admin" style="display:inline-block;margin-top:4px">CURRENT</div></div>
        </div>
        <div class="section-title" style="margin-bottom:8px;margin-top:14px">Effective Permissions</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">✓ Status &nbsp;✓ Metrics &nbsp;✓ Traces &nbsp;✓ Audit log &nbsp;✓ Restart &nbsp;✓ Rollback &nbsp;✓ Config write &nbsp;✓ Tokens <span style="color:var(--accent);cursor:pointer;margin-left:4px" onclick="document.getElementById('permMatrix').scrollIntoView({behavior:'smooth'})">show all (13)</span></div>
        <div style="font-size:12px;color:var(--healthy)">✓ None missing</div>
      </div>
    </div>
    <div class="panel" style="padding:16px;margin-top:14px" id="permMatrix">
      <div class="section-header">
        <span class="section-title">Permission Matrix</span>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="text" id="permFilter" placeholder="Filter permissions…" style="font-size:12px;padding:5px 9px" oninput="filterPerms()" />
          <button class="btn ghost" style="font-size:11px" onclick="exportPermCsv()">Export CSV</button>
        </div>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:10px;display:flex;gap:14px"><span>● Granted</span><span>● Inherited</span><span>○ Off</span></div>
      <table class="perm-matrix"><thead><tr><th>Permission</th><th>Viewer</th><th>Operator</th><th class="admin-col">Admin</th></tr></thead><tbody id="permBody"></tbody></table>
    </div>
  </div>
  <div id="atab-audit" style="display:none">
    <div class="section-header"><span class="section-title">Audit Log</span><button class="btn ghost" onclick="loadAudit()">↺ Refresh</button></div>
    <div class="panel" style="overflow-x:auto"><table class="tbl"><thead><tr><th>When</th><th>Kind</th><th>Org</th><th>Project</th><th>Message</th></tr></thead><tbody id="auditRows"><tr><td colspan="5" style="color:var(--muted);padding:20px;text-align:center">Loading…</td></tr></tbody></table></div>
  </div>
  <div id="atab-tokens" style="display:none">
    <div class="section-header"><span class="section-title">Service Tokens</span><button class="btn primary" onclick="openNewToken()">+ New Token</button></div>
    <div class="panel" style="overflow-x:auto"><table class="tbl"><thead><tr><th>Name</th><th>Org</th><th>Scope</th><th>Created</th><th>Expires</th><th>Last Used</th><th></th></tr></thead><tbody id="tokenRows"><tr><td colspan="7" style="color:var(--muted);padding:20px;text-align:center">Loading…</td></tr></tbody></table></div>
  </div>
</div>

<div id="tab-ai-assistant" style="display:none;height:100%;overflow:hidden">
  <div class="ai-wrap">
    <div class="ai-model-row">
      <span>Model</span>
      <select class="ai-model-sel" id="aiModelSel">
        <option value="anthropic/claude-sonnet-4-6">Claude Sonnet 4.6</option>
        <option value="anthropic/claude-haiku-4.5">Claude Haiku 4.5</option>
        <option value="openai/gpt-4o-mini">GPT-4o mini</option>
      </select>
      <span style="margin-left:auto">Key: <span id="aiKeyStatus" style="color:var(--degraded)">no key</span></span>
      <button class="btn ghost" style="font-size:11px" onclick="clearAiChat()">Clear</button>
    </div>
    <div class="ai-messages" id="aiMessages">
      <div class="ai-empty" id="aiEmpty">
        <div class="ai-icon">⬡</div>
        <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px">AI Assistant</div>
        <div class="ai-hint">Chat with any model via the gateway. Enter your key under Access → Set Gateway Key first.</div>
      </div>
    </div>
    <div class="ai-input-row">
      <textarea class="ai-textarea" id="aiInput" placeholder="Ask anything…" rows="1" onkeydown="aiKeydown(event)"></textarea>
      <button class="btn ghost" id="aiStopBtn" style="display:none" onclick="aiStop()">■ Stop</button>
      <button class="ai-send" id="aiSend" onclick="aiSend()">Send ↑</button>
    </div>
    <div id="aiSugChips" style="display:flex;gap:6px;flex-wrap:wrap;padding:0 16px 10px;flex-shrink:0"></div>
  </div>
</div>

</div></div></div>

<div class="scrim" id="scrim" onclick="closeDrawer()"></div>
<aside class="drawer" id="drawer"><button class="close-btn" onclick="closeDrawer()">×</button><div id="drawerBody"></div></aside>

<div class="modal-bg" id="incModal">
  <div class="modal"><h3>New Incident</h3>
    <div class="field"><label>Title</label><input type="text" id="incTitle" placeholder="Brief description" /></div>
    <div class="field"><label>Severity</label><select id="incSev"><option value="P0">P0 — Critical</option><option value="P1">P1 — High</option><option value="P2" selected>P2 — Medium</option><option value="P3">P3 — Low</option></select></div>
    <div class="field"><label>Project</label><input type="text" id="incProject" placeholder="e.g. underground-api" /></div>
    <div class="field"><label>Affected Users</label><input type="text" id="incAffected" placeholder="e.g. 80" /></div>
    <div class="field"><label>Detail</label><textarea id="incDetail" rows="3" style="resize:vertical;min-height:70px" placeholder="Root cause, impact, next steps…"></textarea></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button class="btn" onclick="closeModal('incModal')">Cancel</button><button class="btn primary" onclick="submitIncident()">Create</button></div>
  </div>
</div>

<div class="modal-bg" id="tokModal">
  <div class="modal"><h3>New Service Token</h3>
    <div class="field"><label>Name</label><input type="text" id="tokName" placeholder="e.g. ci-deploy-token" /></div>
    <div class="field"><label>Scope</label><select id="tokScope"><option value="read">Read</option><option value="read:write">Read + Write</option><option value="admin">Admin</option></select></div>
    <div class="field"><label>Expires In</label><select id="tokExpiry"><option value="">Never</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button class="btn" onclick="closeModal('tokModal')">Cancel</button><button class="btn primary" onclick="submitToken()">Create Token</button></div>
  </div>
</div>

<div class="modal-bg" id="tokRevealModal">
  <div class="modal"><h3>Token Created</h3>
    <p style="font-size:13px;color:var(--muted);margin-bottom:12px">Copy this token now — it will not be shown again.</p>
    <div style="background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:12px;font-family:'JetBrains Mono',monospace;font-size:12px;word-break:break-all;margin-bottom:14px" id="tokRevealVal"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('tokRevealVal').textContent).then(function(){this.textContent='Copied!'}.bind(this))">Copy</button><button class="btn primary" onclick="closeModal('tokRevealModal')">Done</button></div>
  </div>
</div>

<div class="modal-bg" id="recordDeployModal">
  <div class="modal"><h3>Record Deploy</h3>
    <div class="field"><label>Message</label><input type="text" id="rdMessage" placeholder="e.g. deployed v1.2.3" /></div>
    <div class="field"><label>Kind</label><select id="rdKind"><option value="deploy">Deploy</option><option value="rollback">Rollback</option><option value="config">Config</option></select></div>
    <div class="field"><label>Project</label><input type="text" id="rdProject" /></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button class="btn" onclick="closeModal('recordDeployModal')">Cancel</button>
      <button class="btn primary" onclick="submitRecordDeploy()">Record</button>
    </div>
  </div>
</div>
<script>
(function(){
'use strict';
var ALL='__all__';
var $=function(id){return document.getElementById(id)};
var api=function(p){return fetch(p).then(function(r){return r.json()})};
var gk=localStorage.getItem('gk')||sessionStorage.getItem('gk')||'';
var sessTimer=null;
function authed(method,path,body){return fetch(path,{method:method,headers:{'Authorization':'Bearer '+gk,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json()})}
function ago(ms){if(!ms)return'never';var s=Math.floor((Date.now()-ms)/1000);if(s<60)return s+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago'}
function fmt(ms){if(!ms)return'—';return new Date(ms).toLocaleString()}
function txt(el,t){if(el)el.textContent=t==null?'':String(t)}
function promptKey(){var k=prompt('Enter GATEWAY_KEY:');if(!k)return false;gk=k;try{localStorage.setItem('gk',k)}catch(e){}sessionStorage.setItem('gk',k);return true}
var st={org:'',project:ALL,region:ALL,status:ALL,q:'',view:'comfortable',services:[],summary:{},lastLoad:0,logTab:'all',obsWindow:3600000,infraCost:'—',incCount:0,incSevFilter:'__all__',sortCol:'name',sortDir:'asc',deployKindFilter:'__all__',currentRole:'viewer',sparkData:null};
var allLogs=[];
var logPaused=false;
var autoRefreshPaused=false;
var aiAbortController=null;
var sessCountdownTimer=null;
var logTimer=null;var logCountdownTimer=null;var logCountdownSec=30;
var TAB_TITLES={overview:'OVERVIEW',services:'SERVICES',incidents:'INCIDENTS',observability:'OBSERVABILITY',topology:'TOPOLOGY',logs:'LOGS',deploys:'DEPLOYS',access:'ACCESS','ai-assistant':'AI ASSISTANT'};
function nav(el){if(!el)return;var tab=el.getAttribute('data-tab');if(!tab)return;document.querySelectorAll('.nav-item').forEach(function(n){n.classList.toggle('active',n===el)});document.querySelectorAll('[id^="tab-"]').forEach(function(t){t.style.display='none'});var panel=$('tab-'+tab);if(panel)panel.style.display='';var tb=$('topTitle');txt(tb,TAB_TITLES[tab]||tab.toUpperCase());var filterTabs=new Set(['overview','services']);var crumb=$('topBreadcrumb');if(crumb)crumb.style.display=filterTabs.has(tab)?'':'none';if(tb){tb.style.background=tab==='overview'?'rgba(63,185,80,.12)':tab==='incidents'?'rgba(233,69,96,.12)':tab==='observability'?'rgba(124,158,247,.12)':tab==='ai-assistant'?'rgba(139,92,246,.12)':'rgba(110,118,129,.14)';tb.style.color=tab==='overview'?'var(--healthy)':tab==='incidents'?'var(--down)':tab==='observability'?'#7c9ef7':tab==='ai-assistant'?'#8b5cf6':'var(--muted)';tb.style.borderColor=tab==='overview'?'rgba(63,185,80,.2)':tab==='incidents'?'rgba(233,69,96,.2)':tab==='observability'?'rgba(124,158,247,.2)':tab==='ai-assistant'?'rgba(139,92,246,.2)':'rgba(110,118,129,.2)'}if(tab==='incidents')loadIncidents();if(tab==='observability'){loadObs();startObsCd();}else stopObsCd();if(tab==='logs'){startLogPoll();loadLogs();}else stopLogPoll();if(tab==='deploys')loadActivity();if(tab==='access'){loadAccess();startSessPoll();}else{stopSessPoll();}if(tab==='ai-assistant')loadAiAssistant();if(tab==='topology'){if(st.services.length)loadTopology();else load().then(function(){loadTopology()});}}
function qsInit(){var p=new URLSearchParams(location.search);if(p.get('org'))st.org=p.get('org');if(p.get('project'))st.project=p.get('project');if(p.get('region'))st.region=p.get('region')}
function opt(val,label,sel){var o=document.createElement('option');o.value=val;o.textContent=label;if(val===sel)o.selected=true;return o}
function fillSelects(d){var orgs=Array.isArray(d.orgs)?d.orgs:[];var projects=Array.isArray(d.projects)?d.projects:[];var regions=Array.isArray(d.regions)?d.regions:[];var f=d.filters||{};var os=$('orgSel');os.innerHTML='';os.appendChild(opt(ALL,'All Orgs',f.org||ALL));orgs.forEach(function(o){os.appendChild(opt(o,o,f.org))});var ps=$('projSel');ps.innerHTML='';ps.appendChild(opt(ALL,'All Projects',f.project));projects.forEach(function(p){ps.appendChild(opt(p,p,f.project))});var rs=$('regionSel');rs.innerHTML='';rs.appendChild(opt(ALL,'All Regions',f.region));regions.forEach(function(r){rs.appendChild(opt(r,r,f.region))});var orgLabel=(f.org&&f.org!==ALL)?f.org:'All Orgs';var projLabel=(f.project&&f.project!==ALL)?f.project:'All Projects';txt($('topBreadcrumb'),orgLabel+' / '+projLabel)}
$('orgSel').onchange=function(){st.org=this.value;st.project=ALL;st.region=ALL;load()};
$('projSel').onchange=function(){st.project=this.value;st.region=ALL;load()};
$('regionSel').onchange=function(){st.region=this.value;load()};
function renderSummary(s){if(!s||typeof s!=='object')s={score:0,total:0,healthy:0,degraded:0,down:0,unknown:0};var box=$('summary');box.innerHTML='';var score=s.score==null?0:s.score;var grade=score>=90?'A':score>=75?'B':score>=55?'C':score>=35?'D':'F';var tiles=[{n:score+' '+grade,k:'Health Score',cls:'accent'},{n:s.total||0,k:'Services'},{n:s.healthy||0,k:'Healthy',cls:'green'},{n:s.degraded||0,k:'Degraded'},{n:s.down||0,k:'Down',clickable:true},{n:st.incCount||0,k:'Incidents',clickable:true,clickFn:'nav(document.querySelector(\'[data-tab=incidents]\'))'},{n:st.infraCost,k:'Infra Cost'},{n:ago(s.freshest),k:'Last Check'}];tiles.forEach(function(c){var el=document.createElement('div');el.className='stat-tile panel'+(c.cls?' '+c.cls:'');var extra=c.clickable?'cursor:pointer':'';el.style.cssText=extra;if(c.clickable&&c.k==='Down'){el.onclick=function(){nav(document.querySelector('[data-tab=services]'));st.status='down';$('statusSel').value='down';renderSvcBody()}}else if(c.clickable&&c.clickFn){el.setAttribute('onclick',c.clickFn)}el.innerHTML='<div class="val">'+c.n+'</div><div class="lbl">'+c.k+'</div>';box.appendChild(el)})}
function renderBody(){var b=$('body');b.innerHTML='';if(!Array.isArray(st.services)||!st.services.length){b.innerHTML='<div class="panel empty"><div>No services for selected filter.</div><div class="hint">POST /api/control/services to register one.</div></div>';return}if(st.view==='ops'){renderOps(b);return}var g=document.createElement('div');g.className='grid-cards';st.services.forEach(function(s){var c=document.createElement('div');c.className='panel svc-card';c.onclick=function(){openService(s.id)};c.innerHTML='<div class="top"><div class="nm">'+s.name+'</div><span class="badge '+s.status+'">'+s.status+'</span></div><div class="meta"><span>'+s.project+'</span><span>'+s.region+'</span>'+(s.latency_ms!=null?'<span>'+s.latency_ms+'ms</span>':'')+'</div>';g.appendChild(c)});b.appendChild(g)}
function renderSvcBody(){var b=$('svcBody');if(!b)return;b.innerHTML='';var svcs=st.services.filter(function(s){if(st.status&&st.status!==ALL&&s.status!==st.status)return false;if(st.q&&!(s.name+s.project+s.kind).toLowerCase().includes(st.q.toLowerCase()))return false;return true});var countEl=$('svcCount');if(countEl)countEl.textContent=svcs.length+' of '+st.services.length;if(!svcs.length){b.innerHTML='<div class="panel empty">No matching services.</div>';return}if(st.view==='ops'){renderOps(b,svcs);return}var g=document.createElement('div');g.className='grid-cards';svcs.forEach(function(s){var c=document.createElement('div');c.className='panel svc-card';c.onclick=function(){openService(s.id)};var recheckBtn='<button class="btn ghost" style="font-size:11px;padding:3px 8px;margin-top:6px" onclick="event.stopPropagation();recheckSvc(\''+s.id+'\')">↺ re-check</button>';c.innerHTML='<div class="top"><div class="nm">'+escHtml(s.name)+'</div><span class="badge '+s.status+'">'+s.status+'</span></div><div class="meta"><span>'+escHtml(s.project)+'</span><span>'+escHtml(s.region)+'</span>'+(s.latency_ms!=null?'<span>'+s.latency_ms+'ms</span>':'')+'</div>'+recheckBtn;g.appendChild(c)});b.appendChild(g)}
function renderOps(b,svcs){var wrap=document.createElement('div');wrap.className='panel';wrap.style.overflowX='auto';var cols=['name','project','region','status','latency_ms','version','last_check'];var labels=['Service','Project','Region','Status','Latency','Version','Checked'];var thead='<thead><tr>';cols.forEach(function(c,i){var arrow=st.sortCol===c?(st.sortDir==='asc'?'  ↑':'  ↓'):'';thead+='<th style="cursor:pointer;user-select:none" onclick="sortOps(\''+c+'\')">'+labels[i]+arrow+'</th>'});thead+='</tr></thead>';var t=document.createElement('table');t.className='tbl';t.innerHTML=thead;var tb=document.createElement('tbody');var sorted=sortOps(null,svcs||st.services);sorted.forEach(function(s){var r=document.createElement('tr');r.onclick=function(){openService(s.id)};r.innerHTML='<td>'+escHtml(s.name)+'</td><td>'+escHtml(s.project)+'</td><td>'+escHtml(s.region)+'</td><td><span class="badge '+s.status+'">'+s.status+'</span></td><td class="mono">'+(s.latency_ms!=null?s.latency_ms+'ms':'—')+'</td><td class="mono">'+escHtml(s.version||'—')+'</td><td>'+ago(s.last_check)+'</td>';tb.appendChild(r)});t.appendChild(tb);wrap.appendChild(t);b.appendChild(wrap)}
function sortOps(col,svcs){if(col){if(st.sortCol===col){st.sortDir=st.sortDir==='asc'?'desc':'asc'}else{st.sortCol=col;st.sortDir='asc'}renderSvcBody();return}var arr=(svcs||[]).slice();arr.sort(function(a,b){var av=a[st.sortCol]||'';var bv=b[st.sortCol]||'';if(typeof av==='number'&&typeof bv==='number')return st.sortDir==='asc'?av-bv:bv-av;return st.sortDir==='asc'?(av+'').localeCompare(bv+''):(bv+'').localeCompare(av+'')});return arr}
function recheckSvc(id){if(!gk){promptKey();return}authed('POST','/api/control/health-check').then(function(){load()})}
function recheckAll(){if(!gk){promptKey();return}authed('POST','/api/control/health-check').then(function(){load()})}
function setView(btn){document.querySelectorAll('#viewSeg button').forEach(function(b){b.classList.toggle('active',b===btn)});st.view=btn.getAttribute('data-v')||'comfortable';var appEl=document.querySelector('.app');if(appEl)appEl.classList.toggle('compact',st.view==='compact');renderBody();renderSvcBody()}
function load(){var p=new URLSearchParams();if(st.org&&st.org!==ALL)p.set('org',st.org);if(st.project&&st.project!==ALL)p.set('project',st.project);if(st.region&&st.region!==ALL)p.set('region',st.region);if(st.status&&st.status!==ALL)p.set('status',st.status);if(st.q)p.set('q',st.q);var sb=$('svcBody');if(sb){sb.innerHTML='<div class="grid-cards">'+['','','',''].map(function(){return '<div class="panel svc-card shimmer" style="height:90px"></div>'}).join('')+'</div>'}return api('/api/control/overview?'+p).then(function(d){if(!d||d.error){updateFresh();if(sb)sb.innerHTML='';return}var f=d.filters||{};st.org=f.org||ALL;st.project=f.project||ALL;st.region=f.region||ALL;st.services=Array.isArray(d.services)?d.services:[];st.summary=d.summary||{};st.lastLoad=Date.now();fillSelects(d);renderSummary(st.summary);renderBody();renderSvcBody();updateFresh();var downs=st.services.filter(function(s){return s.status==='down'||s.status==='degraded'});if(downs.length){$('ovIncBanner').style.display='';txt($('ovIncText'),downs.length+' service(s) degraded or down: '+downs.slice(0,3).map(function(s){return s.name}).join(', '))}else $('ovIncBanner').style.display='none';loadStats();updateAiSuggestedPrompts()})}
function updateFresh(){txt($('fresh'),'updated '+ago(st.lastLoad))}
function loadStats(){api('/api/control/stats?window=86400000').then(function(d){if(!d||d.error)return;var t=d.totals||{};var box=$('gwStats');box.innerHTML='';[{n:t.total_requests||0,k:'Requests (24h)'},{n:(t.error_rate||0)+'%',k:'Error Rate'},{n:t.avg_latency_ms!=null?Math.round(t.avg_latency_ms)+'ms':'—',k:'Avg Latency'},{n:(t.cache_hit_rate||0)+'%',k:'Cache Hit'},{n:(t.total_input_tokens||0).toLocaleString(),k:'Input Tokens'},{n:(t.fallback_rate||0)+'%',k:'Fallback Rate'}].forEach(function(c){var el=document.createElement('div');el.className='stat-tile panel';el.innerHTML='<div class="val">'+c.n+'</div><div class="lbl">'+c.k+'</div>';box.appendChild(el)});var tb=$('featureTbody');tb.innerHTML='';var fs=Array.isArray(d.by_feature)?d.by_feature:[];if(!fs.length){tb.innerHTML='<tr><td colspan="7" style="color:var(--muted);padding:20px;text-align:center">No gateway requests in window</td></tr>';return}fs.forEach(function(f){tb.innerHTML+='<tr><td>'+f.feature+'</td><td>'+f.total+'</td><td>'+f.error_rate+'%</td><td class="mono">'+(f.avg_latency!=null?Math.round(f.avg_latency)+'ms':'—')+'</td><td>'+f.cache_hit_rate+'%</td><td class="mono">'+(f.input_tokens||0).toLocaleString()+'</td><td>'+f.fallback_rate+'%</td></tr>'});if(fs.length>0){st.sparkData=[fs[0].error_rate||0];}}).catch(function(){});loadCost();}
function loadCost(){api('/api/control/cost?window=86400000').then(function(d){if(!d||d.error)return;var total=d.total_cost_usd||0;st.infraCost=total>0?'$'+total.toFixed(4):'$0.0000';var tiles=document.querySelectorAll('.stat-tile .lbl');for(var i=0;i<tiles.length;i++){if(tiles[i].textContent==='Infra Cost'&&tiles[i].previousElementSibling){tiles[i].previousElementSibling.textContent=st.infraCost;break}}}).catch(function(){})}
function loadIncidents(){var org=st.org;var status=($('incStatusSel')||{}).value||ALL;var p=new URLSearchParams();if(org)p.set('org',org);if(status&&status!==ALL)p.set('status',status);authed('GET','/api/control/incidents?'+p).then(function(d){if(!d||d.error)return;var incs=Array.isArray(d.incidents)?d.incidents:[];var stats=d.stats||{};st.incCount=stats.open||0;txt($('iOpen'),st.incCount);txt($('iCrit'),stats.critical||0);var aff=incs.reduce(function(a,i){return a+(i.affected_users||0)},0);txt($('iAffected'),aff>0?aff.toLocaleString():'—');var sla=incs.filter(function(i){return i.sla_breached}).length;txt($('iSla'),sla);var nb=$('incBadge');if(nb){if(st.incCount>0){nb.style.display='';txt(nb,st.incCount)}else nb.style.display='none'}st._allIncs=incs;filterIncSev(document.querySelector('[data-sev="'+st.incSevFilter+'"]')||document.querySelector('[data-sev="__all__"]'))}).catch(function(){})}
function renderIncList(incs){var list=$('incList');if(!list)return;list.innerHTML='';if(!incs.length){list.innerHTML='<div class="panel empty"><div>No incidents.</div><div class="hint">Click + New Incident to create one.</div></div>';return}incs.forEach(function(i){var sev=(i.severity||'P2').toLowerCase();var card=document.createElement('div');card.className='panel inc-card '+sev;var slaBadge=i.sla_breached?'<span class="badge sla">SLA BREACHED</span>':'';var affBadge=i.affected_users?'<span style="font-size:12px;color:var(--muted)">impacted users: '+i.affected_users+'</span>':'';card.innerHTML='<div class="inc-top"><span class="badge '+sev+'">'+i.severity+'</span><span class="inc-title">'+i.title+'</span>'+slaBadge+'<span class="badge '+(i.status==='resolved'?'ok':'warn')+'">'+i.status.replace('_',' ')+'</span></div><div class="inc-meta">'+affBadge+'<span>'+ago(i.created_at)+'</span>'+(i.project?'<span>'+i.project+'</span>':'')+'</div>';card.onclick=function(){openIncidentDrawer(i)};list.appendChild(card)})}
function filterIncSev(btn){if(!btn)return;document.querySelectorAll('[data-sev]').forEach(function(b){b.classList.toggle('active',b===btn)});st.incSevFilter=btn.getAttribute('data-sev')||'__all__';var incs=st._allIncs||[];if(st.incSevFilter!=='__all__'){incs=incs.filter(function(i){if(st.incSevFilter==='P0')return i.severity==='P0';if(st.incSevFilter==='P1')return i.severity==='P1';return i.severity!=='P0'&&i.severity!=='P1'})}renderIncList(incs)}
function filterIncTab(btn){document.querySelectorAll('[data-itab]').forEach(function(b){b.classList.toggle('active',b===btn)});var tab=btn.getAttribute('data-itab')||'all';var list=$('incList');var sloPanel=$('sloPanel');if(!sloPanel){sloPanel=document.createElement('div');sloPanel.id='sloPanel';sloPanel.style.marginTop='12px';if(list&&list.parentNode)list.parentNode.insertBefore(sloPanel,list.nextSibling)}if(tab==='slo'){if(list)list.style.display='none';sloPanel.style.display='';loadSloBudgets()}else{if(list)list.style.display='';sloPanel.style.display='none'}}
function loadSloBudgets(){var panel=$('sloPanel');if(!panel)return;panel.innerHTML='<div class="panel" style="padding:16px"><div class="section-title" style="margin-bottom:12px">SLO Error Budgets</div><div id="sloBudgetRows"></div></div>';authed('GET','/api/control/observability?window='+st.obsWindow).then(function(d){var rows=$('sloBudgetRows');if(!rows)return;if(!d||d.error){rows.innerHTML='<p style="color:var(--muted);font-size:13px">Unable to load SLO data.</p>';return}var svcs=Array.isArray(d.services)?d.services:[];if(!svcs.length){rows.innerHTML='<p style="color:var(--muted);font-size:13px">No services registered.</p>';return}rows.innerHTML='';svcs.forEach(function(s){var uptime=s.uptime_pct!=null?s.uptime_pct:(100-(s.error_rate||0));var target=s.slo_target||99.9;var budget=100-target;var used=Math.max(0,target-uptime);var pct=budget>0?Math.min(100,Math.round(used/budget*100)):0;var color=pct>=100?'var(--down)':pct>=80?'var(--warn)':'var(--ok)';var row=document.createElement('div');row.style.cssText='margin-bottom:14px';row.innerHTML='<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span>'+escHtml(s.name)+'</span><span style="color:'+color+'">'+pct+'% budget used (target '+target+'%)</span></div><div style="height:6px;border-radius:3px;background:var(--border);overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+color+';border-radius:3px;transition:width .3s"></div></div>';rows.appendChild(row)})}).catch(function(){var rows=$('sloBudgetRows');if(rows)rows.innerHTML='<p style="color:var(--muted);font-size:13px">Unable to load SLO data.</p>'})}
function openNewIncident(){$('incModal').classList.add('open')}
function closeModal(id){var m=$(id);if(m)m.classList.remove('open');if(id==='incModal'){if($('incTitle'))$('incTitle').value='';if($('incProject'))$('incProject').value='';if($('incAffected'))$('incAffected').value='';if($('incDetail'))$('incDetail').value='';if($('incSev'))$('incSev').value='P2'}if(id==='tokModal'){if($('tokName'))$('tokName').value='';if($('tokScope'))$('tokScope').value='read';if($('tokExpiry'))$('tokExpiry').value=''}if(id==='recordDeployModal'){if($('rdMessage'))$('rdMessage').value='';if($('rdProject'))$('rdProject').value='';if($('rdVersion'))$('rdVersion').value=''}}
function submitIncident(){var title=($('incTitle').value||'').trim();if(!title){alert('Title required');return}if(!gk){promptKey();return}authed('POST','/api/control/incidents',{org:st.org||'3Sixty Co.',title:title,severity:$('incSev').value,project:($('incProject').value||undefined),affected_users:parseInt($('incAffected').value)||undefined,detail:($('incDetail').value||undefined)}).then(function(d){if(d.error){alert('Error: '+d.error);return}closeModal('incModal');loadIncidents()})}
function openIncidentDrawer(inc){openDrawer();var statusOpts=['open','identified','in_progress','resolved'].map(function(s){return '<option value="'+s+'"'+(inc.status===s?' selected':'')+'>'+s.replace('_',' ')+'</option>'}).join('');$('drawerBody').innerHTML='<h2 style="font-family:\'DM Sans\';margin-bottom:12px">'+escHtml(inc.title)+'</h2><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px"><span class="badge '+inc.severity.toLowerCase()+'">'+inc.severity+'</span><span class="badge '+(inc.status==='resolved'?'ok':'warn')+'">'+inc.status.replace('_',' ')+'</span>'+(inc.sla_breached?'<span class="badge sla">SLA BREACHED</span>':'')+'</div><div class="kv-row"><span class="k">Created</span><span class="v">'+fmt(inc.created_at)+'</span></div><div class="kv-row"><span class="k">Project</span><span class="v">'+escHtml(inc.project||'—')+'</span></div><div class="kv-row"><span class="k">Affected</span><span class="v">'+(inc.affected_users||'—')+'</span></div><div class="kv-row" style="border:none"><span class="k">Detail</span></div><p style="font-size:13px;color:var(--muted);margin-top:6px">'+escHtml(inc.detail||'No detail provided.')+'</p><hr class="divider"><div class="kv-row" style="align-items:center"><span class="k">Update Status</span><select class="topbar-sel" id="incStatusUpdate">'+statusOpts+'</select><button class="btn" style="margin-left:8px" onclick="updateInc(\''+inc.id+'\')">Save</button></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button class="btn" onclick="resolveInc(\''+inc.id+'\')">Mark Resolved</button><button class="btn danger" onclick="deleteInc(\''+inc.id+'\')">Delete</button></div>'}
function updateInc(id){var sel=$('incStatusUpdate');if(!sel)return;var status=sel.value;if(!gk){promptKey();return}authed('PATCH','/api/control/incidents/'+id,{status:status}).then(function(d){if(d&&d.error){alert('Error: '+d.error);return}closeDrawer();loadIncidents()})}
function resolveInc(id){if(!gk){promptKey();return}authed('PATCH','/api/control/incidents/'+id,{status:'resolved'}).then(function(){closeDrawer();loadIncidents()})}
function deleteInc(id){if(!confirm('Delete incident?'))return;if(!gk){promptKey();return}authed('DELETE','/api/control/incidents/'+id).then(function(){closeDrawer();loadIncidents()})}
function setTimeWindow(btn){document.querySelectorAll('#timeSeg button').forEach(function(b){b.classList.toggle('active',b===btn)});st.obsWindow=parseInt(btn.getAttribute('data-w')||'86400000',10);loadObs()}
var obsTimer=null;var obsCdSec=30;
function startObsCd(){clearInterval(obsTimer);obsCdSec=30;var cd=$('obsCountdown');if(cd)cd.textContent='refreshing in 30s';obsTimer=setInterval(function(){obsCdSec--;var cd2=$('obsCountdown');if(cd2)cd2.textContent='refreshing in '+obsCdSec+'s';if(obsCdSec<=0){obsCdSec=30;loadObs()}},1000)}
function stopObsCd(){clearInterval(obsTimer);obsTimer=null;var cd=$('obsCountdown');if(cd)cd.textContent=''}
function setObsTab(btn){document.querySelectorAll('.obs-sub-btn').forEach(function(b){b.classList.toggle('active',b===btn)});var tab=btn.getAttribute('data-otab')||'metrics';setObsTabContent(tab)}
function setObsTabContent(tab){var mainContent=$('obsMainContent');if(mainContent)mainContent.style.display=tab==='metrics'?'':'none';if(tab==='cost'){loadObsCost()}else if(tab==='errors'){loadObsErrors()}else if(tab==='events'){loadObsEvents()}else if(tab==='traces'){var box=$('obsTraceMsg');if(box)box.style.display='';else renderObsTracesMsg()}else if(tab==='logs'){renderObsLogsLink()}}
function loadObsCost(){var el=$('obsMainContent');if(!el)return;el.style.display='';el.innerHTML='<div class="panel" style="padding:16px"><div class="section-title" style="margin-bottom:12px">AI + Infra Cost</div><div id="obsCostRows"></div></div>';var rows=$('obsCostRows');api('/api/control/cost?window='+st.obsWindow).then(function(d){if(!d||d.error){rows.innerHTML='<p style="color:var(--muted);font-size:13px">Unable to load cost data.</p>';return}rows.innerHTML='<div class="kv-row"><span class="k">Total Cost (window)</span><span class="v mono">'+(d.total_cost_usd!=null?'$'+Number(d.total_cost_usd).toFixed(4):'—')+'</span></div><div class="kv-row"><span class="k">Projected Monthly</span><span class="v mono">'+(d.projected_monthly_usd!=null?'$'+Number(d.projected_monthly_usd).toFixed(2):'—')+'</span></div><div class="kv-row"><span class="k">Tokens Used</span><span class="v mono">'+((d.total_tokens||0).toLocaleString())+'</span></div>'}).catch(function(){rows.innerHTML='<p style="color:var(--muted);font-size:13px">Unable to load cost data.</p>'})}
function loadObsErrors(){var el=$('obsMainContent');if(!el)return;el.style.display='';el.innerHTML='<div class="panel" style="padding:16px"><div class="section-title" style="margin-bottom:12px">Error Triage</div><div id="obsErrRows"></div></div>';var rows=$('obsErrRows');api('/api/control/stats?window='+st.obsWindow).then(function(d){if(!d||d.error){rows.innerHTML='<p style="color:var(--muted);font-size:13px">Unable to load error data.</p>';return}var byFeature=Array.isArray(d.by_feature)?d.by_feature:[];if(!byFeature.length){rows.innerHTML='<p style="color:var(--muted);font-size:13px">No errors in window.</p>';return}var t='<table style="width:100%;border-collapse:collapse"><thead><tr style="font-size:11px;color:var(--muted)"><th style="text-align:left;padding:6px 8px">Feature</th><th style="text-align:right;padding:6px 8px">Requests</th><th style="text-align:right;padding:6px 8px">Error Rate</th></tr></thead><tbody>';byFeature.filter(function(f){return (f.error_rate||0)>0}).forEach(function(f){var ec=(f.error_rate||0)>5?'var(--down)':(f.error_rate||0)>1?'var(--degraded)':'var(--healthy)';t+='<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px;font-size:13px">'+escHtml(f.feature||'—')+'</td><td style="text-align:right;padding:8px;font-size:13px">'+f.total+'</td><td style="text-align:right;padding:8px;font-size:13px;color:'+ec+'">'+f.error_rate+'%</td></tr>'});t+='</tbody></table>';rows.innerHTML=t}).catch(function(){rows.innerHTML='<p style="color:var(--muted);font-size:13px">Unable to load error data.</p>'})}
function loadObsEvents(){var el=$('obsMainContent');if(!el)return;el.style.display='';el.innerHTML='<div class="panel" style="padding:16px"><div class="section-title" style="margin-bottom:12px">Deploy Events</div><div id="obsEventsRows"></div></div>';var rows=$('obsEventsRows');api('/api/control/activity?limit=20').then(function(d){var acts=Array.isArray(d.activity)?d.activity:[];if(!acts.length){rows.innerHTML='<p style="color:var(--muted);font-size:13px">No deploy events in window.</p>';return}var t='';acts.filter(function(a){return a.kind==='deploy'}).forEach(function(a){t+='<div class="panel" style="padding:10px 12px;margin-bottom:8px"><div style="display:flex;gap:8px;align-items:center"><span class="badge p2">DEPLOY</span><span style="font-size:13px">'+escHtml(a.message||'')+'</span><span style="margin-left:auto;font-size:11px;color:var(--muted)">'+ago(a.created_at)+'</span></div>'+(a.project?'<div style="font-size:11px;color:var(--muted);margin-top:4px">'+escHtml(a.project)+'</div>':'')+'</div>'});rows.innerHTML=t||'<p style="color:var(--muted);font-size:13px">No deploy events found.</p>'}).catch(function(){rows.innerHTML='<p style="color:var(--muted);font-size:13px">Unable to load events.</p>'})}
function renderObsLogsLink(){var el=$('obsMainContent');if(!el)return;el.style.display='';el.innerHTML='<div class="panel" style="padding:24px;text-align:center"><div class="section-title" style="margin-bottom:8px">Live Log Tail</div><p style="color:var(--muted);font-size:13px;margin-bottom:14px">Log streaming is available on the Logs tab.</p><button class="btn primary" onclick="nav(document.querySelector(\'[data-tab=observability]\'));setTimeout(function(){var b=document.querySelector(\'[data-otab=logs]\');if(b){b.click()}},100)">Go to Logs →</button></div>'}
function renderObsTracesMsg(){var el=$('obsMainContent');if(!el)return;el.style.display='';el.innerHTML='<div class="panel" style="padding:24px" id="obsTraceMsg"><div class="section-title" style="margin-bottom:8px">Distributed Traces</div><p style="color:var(--muted);font-size:13px">Trace instrumentation is active on configured services. Connect a Jaeger or Zipkin backend to visualize spans here.</p></div>'}
function copyObsCode(btn){var block=btn.parentElement;var code=block.innerText.replace('Copy','').trim();navigator.clipboard.writeText(code).then(function(){btn.textContent='Copied!';setTimeout(function(){btn.textContent='Copy'},2000)}).catch(function(){})}
function toggleAlerts(){var f=$('alertsFlyout');if(f)f.classList.toggle('open')}
document.addEventListener('click',function(e){var w=$('alertsWrap');var f=$('alertsFlyout');if(f&&f.classList.contains('open')&&w&&!w.contains(e.target))f.classList.remove('open')});
function makeSpark(val,max,color){var ratio=max>0?Math.min(1,val/max):0;var bars='';for(var i=0;i<12;i++){var wave=Math.sin((i*0.8)+(ratio*3))*0.18;var h=Math.max(2,Math.round(Math.max(0,Math.min(1,ratio+wave))*28));bars+='<span style="height:'+h+'px;background:'+color+'"></span>'}return'<div class="spark-inline">'+bars+'</div>'}
function filterObsSvc(pill){document.querySelectorAll('.svc-pill').forEach(function(p){p.classList.toggle('active',p===pill)})}
function loadObs(){
  if($('obsBadge')){$('obsBadge').className='badge live';txt($('obsBadge'),'LIVE')}
  if(!obsTimer)startObsCd();
  authed('GET','/api/control/observability?window='+st.obsWindow).then(function(d){
    if(!d||d.error)return;
    var svcs=Array.isArray(d.services)?d.services:[];
    var s=d.summary||{};
    var cvg=s.instrumentation_coverage||{covered:3,total:9};
    var totalChecks=s.total_checks||0;
    var errRate=parseFloat(String(s.error_rate||0));
    var avgLat=Math.round(s.avg_latency_ms||0);
    var isEmpty=totalChecks===0&&!svcs.length;
    // #1 setup wizard
    var wiz=$('obsWizard');if(wiz)wiz.style.display=isEmpty?'':'none';
    // #2 partial signal banner — name services in overview but absent from obs
    var obsNames=new Set(svcs.map(function(sv){return sv.name}));
    var missing=st.services.filter(function(sv){return!obsNames.has(sv.name)&&sv.url});
    var partBanner=$('obsPartialBanner');
    if(partBanner){
      if(!isEmpty&&missing.length>0){partBanner.style.display='';txt($('obsPartialText'),missing[0].name+' has incomplete health signals — '+missing.length+' service'+(missing.length>1?'s':'')+' missing.');}
      else partBanner.style.display='none';
    }
    // #5 service pills with health dot color
    var pillBox=$('obsPills');
    if(pillBox){
      if(st.services.length>0||svcs.length>0){
        pillBox.style.display='';
        pillBox.innerHTML='<div class="svc-pill active" onclick="filterObsSvc(this)"><span class="pd" style="background:var(--accent)"></span>All</div>';
        var seen={};
        svcs.forEach(function(sv){if(seen[sv.name])return;seen[sv.name]=1;var err=sv.error_rate||0;var dot=err>5?'var(--down)':err>1?'var(--degraded)':'var(--healthy)';pillBox.innerHTML+='<div class="svc-pill" onclick="filterObsSvc(this)"><span class="pd" style="background:'+dot+'"></span>'+escapeHtml(sv.name)+'</div>';});
        st.services.forEach(function(sv){if(seen[sv.name])return;seen[sv.name]=1;var dot=sv.status==='healthy'?'var(--healthy)':sv.status==='degraded'?'var(--degraded)':'var(--down)';pillBox.innerHTML+='<div class="svc-pill" onclick="filterObsSvc(this)"><span class="pd" style="background:'+dot+'"></span>'+escapeHtml(sv.name)+'</div>';});
      } else pillBox.style.display='none';
    }
    // #4 metric cards with sparklines + trend arrows
    var mc=$('obsMetrics');mc.innerHTML='';
    var mDefs=[
      {mv:totalChecks||0,mk:'Health Checks',ms:'total probes',val:totalChecks,max:Math.max(totalChecks,1000),color:'var(--healthy)',trend:{dir:'flat',txt:'stable'}},
      {mv:errRate+'%',mk:'Error Rate',ms:'last window',val:errRate,max:10,color:errRate>5?'var(--down)':errRate>1?'var(--degraded)':'var(--healthy)',trend:{dir:errRate>1?'up':'flat',txt:errRate>0?errRate+'% error rate':'within SLO'}},
      {mv:avgLat?avgLat+'ms':'—',mk:'Avg Latency',ms:'p50 approx',val:avgLat,max:500,color:avgLat>300?'var(--down)':avgLat>100?'var(--degraded)':'var(--accent)',trend:{dir:avgLat>300?'up':'flat',txt:avgLat?avgLat+'ms p50':'no data'}},
      {mv:cvg.covered+'/'+cvg.total,mk:'Instrumented',ms:'services covered',val:cvg.covered,max:cvg.total||1,color:'var(--accent)',trend:{dir:cvg.covered<cvg.total?'flat':'down-good',txt:(cvg.total-cvg.covered)>0?(cvg.total-cvg.covered)+' gaps remaining':'fully covered'}}
    ];
    mDefs.forEach(function(c){var tCls=c.trend.dir==='up'?'up':c.trend.dir==='down-good'?'down-good':'flat';var tIco=c.trend.dir==='up'?'↑':c.trend.dir==='down-good'?'↓':'→';var el=document.createElement('div');el.className='metric-card';el.innerHTML='<div class="mv">'+c.mv+'</div><div class="mk">'+c.mk+'</div>'+makeSpark(c.val,c.max,c.color)+'<div class="metric-trend '+tCls+'"><span>'+tIco+'</span><span>'+c.trend.txt+'</span></div>';mc.appendChild(el)});
    // key metrics per service
    var km=$('obsKeyMetrics');km.innerHTML='';
    svcs.slice(0,3).forEach(function(sv){var el=document.createElement('div');el.className='metric-card';var lat=sv.p99_latency_ms||0;var lc=lat>300?'var(--down)':lat>150?'var(--degraded)':'var(--accent)';el.innerHTML='<div class="mv" style="color:'+lc+'">'+lat+'ms</div><div class="mk">P99 LATENCY</div>'+makeSpark(lat,500,lc)+'<div class="ms" style="margin-top:2px;color:var(--muted)">'+escapeHtml(sv.name)+'</div>';km.appendChild(el)});
    [{mv:errRate+'%',mk:'ERROR RATE',ms:svcs[0]?escapeHtml(svcs[0].name):'—',val:errRate,max:10,color:'var(--healthy)'},{mv:totalChecks||0,mk:'THROUGHPUT',ms:'req last window',val:totalChecks,max:Math.max(totalChecks,5000),color:'var(--accent)'},{mv:st.infraCost,mk:'AI TOKEN COST',ms:'last window',val:0,max:1,color:'var(--muted)'}].forEach(function(c){var el=document.createElement('div');el.className='metric-card';el.innerHTML='<div class="mv">'+c.mv+'</div><div class="mk">'+c.mk+'</div>'+makeSpark(c.val,c.max,c.color)+'<div class="ms" style="margin-top:2px;color:var(--muted)">'+c.ms+'</div>';km.appendChild(el)});
    // #9 per-service tables with comparison bars (replaces plain bar chart)
    var lt=$('latencyTable');lt.innerHTML='';
    if(svcs.length){
      var maxLat=Math.max.apply(null,svcs.map(function(sv){return sv.p99_latency_ms||0}).concat([1]));
      var maxErr2=Math.max.apply(null,svcs.map(function(sv){return sv.error_rate||0}).concat([0.1]));
      var tbl='<table style="width:100%;border-collapse:collapse"><thead><tr style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)"><th style="text-align:left;padding:6px 8px">Service</th><th style="text-align:right;padding:6px 8px;width:72px">P99</th><th style="padding:6px 8px">Comparison</th><th style="text-align:right;padding:6px 8px;width:64px">Err %</th></tr></thead><tbody>';
      svcs.forEach(function(sv){var lat=sv.p99_latency_ms||0;var pct=Math.round(lat/maxLat*100);var bc=lat>300?'var(--down)':lat>150?'var(--degraded)':'var(--accent)';var ec=sv.error_rate>5?'var(--down)':sv.error_rate>1?'var(--degraded)':'var(--healthy)';tbl+='<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px;font-size:13px">'+escapeHtml(sv.name)+'</td><td style="text-align:right;padding:8px;font-family:\'DM Sans\',sans-serif;font-size:13px;font-weight:600;color:'+bc+'">'+lat+'ms</td><td style="padding:8px 8px 8px 4px"><div class="inline-bar-wrap"><div class="inline-bar-bg"><div class="inline-bar-fill" style="width:'+pct+'%;background:'+bc+'"></div></div></div></td><td style="text-align:right;padding:8px;font-family:\'DM Sans\',sans-serif;font-size:13px;font-weight:600;color:'+ec+'">'+sv.error_rate+'%</td></tr>';});
      tbl+='</tbody></table>';
      // error rate sub-table
      tbl+='<div class="section-header" style="margin-top:14px"><span class="section-title">Error Rate Per Service (%)</span></div>';
      tbl+='<table style="width:100%;border-collapse:collapse"><thead><tr style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)"><th style="text-align:left;padding:6px 8px">Service</th><th style="text-align:right;padding:6px 8px;width:72px">Err %</th><th style="padding:6px 8px">Comparison</th></tr></thead><tbody>';
      svcs.forEach(function(sv){var er=sv.error_rate||0;var p2=Math.round(er/maxErr2*100);var ec2=er>5?'var(--down)':er>1?'var(--degraded)':'var(--healthy)';tbl+='<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px;font-size:13px">'+escapeHtml(sv.name)+'</td><td style="text-align:right;padding:8px;font-family:\'DM Sans\',sans-serif;font-size:13px;font-weight:600;color:'+ec2+'">'+er+'%</td><td style="padding:8px 8px 8px 4px"><div class="inline-bar-wrap"><div class="inline-bar-bg"><div class="inline-bar-fill" style="width:'+p2+'%;background:'+ec2+'"></div></div></div></td></tr>';});
      tbl+='</tbody></table>';
      lt.innerHTML=tbl;
    } else lt.innerHTML='<div class="empty" style="padding:30px 20px">No services probed in this window.<div class="hint">Widen the time range or trigger a health check.</div></div>';
    // #6 SLO rows with delta arrows
    var sloBox=$('sloRows');
    sloBox.innerHTML='<div class="slo-row" style="background:var(--panel2);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)"><span>SLO Target</span><span>Target</span><span>Actual</span><span>Status</span></div>';
    [{name:'P95 Latency',target:'≤300ms',actual:(avgLat||0)+'ms',ok:(avgLat||0)<=300,pct:Math.min(100,avgLat>0?Math.round(avgLat/300*100):0)},
     {name:'Error Rate',target:'<1%',actual:errRate+'%',ok:errRate<1,pct:Math.min(100,Math.round(errRate/1*100))},
     {name:'Throughput',target:'>500/min',actual:totalChecks||'—',ok:true,pct:Math.min(100,Math.round(totalChecks/500*100))}
    ].forEach(function(si){
      var headroom=100-si.pct;var deltaCls=si.pct>80?'near':si.pct>0?'safe':'ok';var deltaStr=si.pct>80?'↑ '+(headroom)+'% to limit':si.pct>0?'→ '+headroom+'% headroom':'→ no data';
      var row=document.createElement('div');row.className='slo-row';
      row.innerHTML='<span>'+si.name+'<span class="slo-delta '+deltaCls+'">'+deltaStr+'</span></span><span class="mono">'+si.target+'</span><span class="mono">'+si.actual+'</span><span class="badge '+(si.ok?'ok':'down')+'">'+(si.ok?'✓ PASS':'✗ FAIL')+'</span>';
      sloBox.appendChild(row);
    });
    // #8 signal coverage mini bars with percentages
    var sigBars=$('covSignalBars');
    if(sigBars){sigBars.innerHTML='';var metricsPct=Math.round((cvg.covered/Math.max(cvg.total,1))*100);var logsPct=totalChecks>0?Math.min(100,Math.round(totalChecks/50)):0;var eventsPct=svcs.length>0?Math.min(100,svcs.length*10):0;var sigData=[{k:'Metrics',pct:metricsPct},{k:'Traces',pct:0},{k:'Logs',pct:logsPct},{k:'Events',pct:eventsPct},{k:'Cost',pct:Math.round((cvg.covered/Math.max(cvg.total,1))*90)}];sigData.forEach(function(bar){var el=document.createElement('div');el.className='cov-signal-bar';el.innerHTML='<div class="csbg"><div class="csfill" style="height:'+bar.pct+'%"></div></div><div class="cslbl">'+bar.k+'</div><div class="cspct">'+bar.pct+'%</div>';sigBars.appendChild(el)})}
    // #3 instrumentation coverage with Set up CTAs
    txt($('coverageBadge'),cvg.covered+'/'+cvg.total);
    var cvgBox=$('coverageList');cvgBox.innerHTML='';
    var cvgDone=['Request latency histograms','Distributed trace propagation','Cost attribution tags'];
    var cvgMissing=[{name:'Structured JSON logs',navTab:'logs'},{name:'Error fingerprinting',navTab:'errors'},{name:'Deploy and incident events',navTab:'events'}];
    cvgDone.forEach(function(item){cvgBox.innerHTML+='<div class="coverage-row"><span style="color:var(--healthy);width:18px;text-align:center;flex-shrink:0">✓</span><span>'+item+'</span></div>';});
    cvgMissing.forEach(function(item){cvgBox.innerHTML+='<div class="coverage-row"><span style="color:var(--muted);width:18px;text-align:center;flex-shrink:0">○</span><span style="color:var(--muted)">'+item.name+'</span><button class="cov-setup-link" style="background:transparent;border:none;color:var(--accent);cursor:pointer;font-size:11px;margin-left:auto;padding:0" onclick="(function(){nav(document.querySelector(\'[data-tab=observability]\'));setTimeout(function(){var b=document.querySelector(\'[data-otab='+item.navTab+']\');if(b)b.click()},100)})()">View →</button></div>';});
    // #11 alerts badge + flyout content
    var totalGaps=cvg.total-cvg.covered;var incBadge=$('incBadge');var openIncs=incBadge?parseInt(incBadge.textContent||'0',10):0;var alertCount=openIncs+(totalGaps>0?1:0);var ab=$('alertsBadge');if(ab){if(alertCount>0){ab.style.display='';txt(ab,alertCount)}else ab.style.display='none'}var fl=$('alertsFlyoutList');if(fl){var items='';if(openIncs>0)items+='<div class="alerts-flyout-item"><span class="badge p1">INC</span><span>'+openIncs+' open incident'+(openIncs>1?'s':'')+'</span></div>';if(totalGaps>0)items+='<div class="alerts-flyout-item"><span class="badge warn">OBS</span><span>'+totalGaps+' instrumentation gap'+(totalGaps>1?'s':'')+' detected</span></div>';if(missing.length>0)items+='<div class="alerts-flyout-item"><span class="badge degraded">SIG</span><span>'+missing.length+' service'+(missing.length>1?'s':'')+' missing signals</span></div>';fl.innerHTML=items||'<div style="padding:14px;color:var(--muted);font-size:12px">No active alerts.</div>';}
    setTimeout(function(){if($('obsBadge')){$('obsBadge').className='badge idle';txt($('obsBadge'),'IDLE')}},2000);
  }).catch(function(){if($('obsBadge')){$('obsBadge').className='badge idle';txt($('obsBadge'),'IDLE')};stopObsCd()})}
function startLogPoll(){stopLogPoll();if(logPaused)return;logCountdownSec=Math.round((st.logInterval||30000)/1000);logTimer=setInterval(function(){if(!logPaused)loadLogs()},st.logInterval||30000);logCountdownTimer=setInterval(function(){if(logPaused)return;logCountdownSec--;if(logCountdownSec<=0)logCountdownSec=Math.round((st.logInterval||30000)/1000);txt($('logCountdown'),'next in '+logCountdownSec+'s')},1000)}
function stopLogPoll(){clearInterval(logTimer);clearInterval(logCountdownTimer);logTimer=null;logCountdownTimer=null}
function setLogInterval(){st.logInterval=parseInt(($('logIntervalSel')||{}).value||'30000',10);if(logTimer)startLogPoll()}
function loadLogs(){var svc=($('logSvcSel')||{}).value||ALL;var p=new URLSearchParams();p.set('limit','100');if(svc&&svc!==ALL)p.set('service',svc);var badge=$('logStatus');if(badge){badge.className='badge live';txt(badge,'LIVE')}authed('GET','/api/control/logs?'+p).then(function(d){if(!d||d.error){if(badge){badge.className='badge idle';txt(badge,'IDLE')}return}allLogs=Array.isArray(d.logs)?d.logs:[];var stats=d.stats||{};txt($('logCntAll'),stats.total||0);txt($('logCntOk'),stats.ok||0);txt($('logCntErr'),stats.errors||0);renderLogs();setTimeout(function(){if(badge){badge.className='badge idle';txt(badge,'IDLE')}},2000);var svcs=[...new Set(allLogs.map(function(l){return l.service_name||l.service_id}).filter(Boolean))];var sel=$('logSvcSel');if(sel&&sel.options.length<=1){svcs.forEach(function(sv){var o=document.createElement('option');o.value=sv;o.textContent=sv;sel.appendChild(o)})}}).catch(function(){if(badge){badge.className='badge idle';txt(badge,'IDLE')}})}
function filterLogTab(btn){document.querySelectorAll('[data-ltab]').forEach(function(b){b.classList.toggle('active',b===btn)});st.logTab=btn.getAttribute('data-ltab')||'all';renderLogs()}
function renderLogs(){var rows=$('logRows');if(!rows)return;var q=($('logSearch')||{}).value||'';var useRegex=($('regexChk')||{}).checked;var data=allLogs.filter(function(l){if(st.logTab==='ok'&&l.status!=='healthy')return false;if(st.logTab==='errors'&&l.status==='healthy')return false;if(!q)return true;var hay=(l.service_name||'')+(l.status||'')+(l.status_code||'')+(l.id||'');try{return useRegex?new RegExp(q,'i').test(hay):hay.toLowerCase().indexOf(q.toLowerCase())>=0}catch(e){return true}});rows.innerHTML='';if(!data.length){rows.innerHTML='<div style="color:var(--muted);padding:20px;text-align:center;font-size:13px">No log entries match filter.</div>';return}var svcColors={landing:'#e94560',underground:'#7c9ef7',stats:'#3fb950',memory:'#d29922',ev:'#ff9900'};data.slice(0,200).forEach(function(l){var sn=(l.service_name||l.service_id||'??').toLowerCase();var code=sn.slice(0,2).toUpperCase();var color=Object.keys(svcColors).reduce(function(acc,k){return sn.indexOf(k)>=0?svcColors[k]:acc},'#666');var st_ok=l.status==='healthy';var rowBg=st_ok?'':'rgba(248,81,73,.06)';var row=document.createElement('div');row.className='log-row';row.style.background=rowBg;var logText=new Date(l.checked_at).toLocaleString()+' '+sn+' '+l.status+' HTTP '+(l.status_code||'—')+' '+l.id;row.innerHTML='<div class="lc" style="font-size:11px">'+new Date(l.checked_at).toLocaleString()+'</div><div class="lc"><span class="svc-chip" style="color:'+color+';border:1px solid '+color+'40">'+code+'</span></div><div class="lc" style="font-size:11px">'+escHtml(sn)+'</div><div class="lc"><span class="badge '+(st_ok?'ok':'down')+'">'+l.status+'</span></div><div class="lc" style="font-size:11px">HTTP '+(l.status_code||'—')+' — '+(st_ok?'ok':'error')+'</div><div class="lc" style="font-size:10px;color:var(--muted)">'+escHtml(l.id||'')+'</div><div class="lc"><button style="background:transparent;border:1px solid var(--border);color:var(--muted);cursor:pointer;font-size:10px;padding:2px 6px;border-radius:3px" onclick="(function(){try{navigator.clipboard.writeText('+JSON.stringify(logText)+');}catch(e){}this.textContent=\'✓\';var b=this;setTimeout(function(){b.textContent=\'copy\'},1200)}).call(this)">copy</button></div>';rows.appendChild(row)});if(($('autoScrollChk')||{}).checked)rows.scrollTop=rows.scrollHeight}
function getCurrentFilteredLogs(){var q=($('logSearch')||{}).value||'';var useRegex=($('regexChk')||{}).checked;return allLogs.filter(function(l){if(st.logTab==='ok'&&l.status!=='healthy')return false;if(st.logTab==='errors'&&l.status==='healthy')return false;if(!q)return true;var hay=(l.service_name||'')+(l.status||'')+(l.status_code||'')+(l.id||'');try{return useRegex?new RegExp(q,'i').test(hay):hay.toLowerCase().indexOf(q.toLowerCase())>=0}catch(e){return true}})}
function toggleLogPause(){logPaused=!logPaused;var btn=$('logPauseBtn');if(btn)btn.textContent=logPaused?'▶ Resume':'⏸ Pause';if(logPaused){stopLogPoll()}else{startLogPoll();loadLogs()}}
var exportBtn=$('exportLogsBtn');if(exportBtn)exportBtn.onclick=function(){var logs=getCurrentFilteredLogs();if(!logs.length)return;var cols=['checked_at','service_name','status','status_code','id'];var esc=function(v){var s=v==null?'':String(v);return/[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};var csv=[cols.join(',')].concat(logs.map(function(l){return cols.map(function(k){return esc(l[k])}).join(',')})).join('\n');var a=document.createElement('a');a.href='data:text/csv,'+encodeURIComponent(csv);a.download='logs-filtered.csv';a.click()};
function loadActivity(){var p=new URLSearchParams();if(st.org)p.set('org',st.org);p.set('limit','50');api('/api/control/activity?'+p).then(function(d){var tb=$('activityRows');if(!tb)return;tb.innerHTML='';var acts=Array.isArray(d.activity)?d.activity:[];var filtered=acts.filter(function(a){return st.deployKindFilter==='__all__'||a.kind===st.deployKindFilter});if(!filtered.length){tb.innerHTML='<tr><td colspan="4" style="color:var(--muted);padding:20px;text-align:center">No activity.</td></tr>';return}filtered.forEach(function(a){var r=document.createElement('tr');r.style.cursor='pointer';r.onclick=function(){openActivityDrawer(a)};r.innerHTML='<td class="mono" style="font-size:11px">'+ago(a.created_at)+'</td><td><span class="badge p2">'+escHtml(a.kind||'')+'</span></td><td>'+escHtml(a.project||'—')+'</td><td>'+escHtml(a.message||'')+'</td>';tb.appendChild(r)})})}
function openActivityDrawer(a){openDrawer();$('drawerBody').innerHTML='<h2 style="font-family:\'DM Sans\';margin-bottom:12px">'+escHtml(a.message||'Activity')+'</h2><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px"><span class="badge p2">'+escHtml(a.kind||'')+'</span></div><div class="kv-row"><span class="k">Time</span><span class="v">'+fmt(a.created_at)+'</span></div><div class="kv-row"><span class="k">Project</span><span class="v">'+escHtml(a.project||'—')+'</span></div><div class="kv-row"><span class="k">Actor</span><span class="v">'+escHtml(a.actor||'—')+'</span></div>'+(a.detail?'<div class="kv-row" style="border:none"><span class="k">Detail</span></div><p style="font-size:13px;color:var(--muted);margin-top:6px">'+escHtml(a.detail)+'</p>':'')}
function filterDeployKind(btn){document.querySelectorAll('[data-dkind]').forEach(function(b){b.classList.toggle('active',b===btn)});st.deployKindFilter=btn.getAttribute('data-dkind')||'__all__';loadActivity()}
function openRecordDeploy(){var m=$('recordDeployModal');if(m)m.classList.add('open')}
function submitRecordDeploy(){var msg=($('rdMessage')||{}).value;var proj=($('rdProject')||{}).value;var ver=($('rdVersion')||{}).value;if(!msg||!msg.trim()){alert('Message required');return}if(!gk){promptKey();return}authed('POST','/api/control/activity',{org:st.org||'default',kind:'deploy',message:msg.trim(),project:proj||undefined,meta:ver?{version:ver}:undefined}).then(function(d){if(d&&d.error){alert('Error: '+d.error);return}closeModal('recordDeployModal');loadActivity()})}}
function switchAccessTab(btn){document.querySelectorAll('[data-atab]').forEach(function(b){b.classList.toggle('active',b===btn)});['access','audit','tokens'].forEach(function(t){var el=$('atab-'+t);if(el)el.style.display='none'});var tab=btn.getAttribute('data-atab')||'access';var panel=$('atab-'+tab);if(panel)panel.style.display='';if(tab==='audit')loadAudit();if(tab==='tokens')loadTokens()}
function sessErr(msg){var el=$('aSessErr');if(!el)return;el.style.display='';el.style.color='var(--down)';el.style.borderColor='rgba(248,81,73,.25)';el.style.background='rgba(248,81,73,.08)';txt(el,msg)}
function sessInfo(msg){var el=$('aSessErr');if(!el)return;el.style.display='';el.style.color='var(--muted)';el.style.borderColor='var(--border)';el.style.background='var(--panel2)';txt(el,msg)}
function clearSessErr(){var el=$('aSessErr');if(el)el.style.display='none'}
function renderSession(d){if(!d)return;txt($('aIdentity'),d.identity||'Unknown');txt($('aActorName'),d.actor||'—');txt($('aProvider'),d.auth_provider||'—');txt($('aRiskVal'),d.access_risk_score||'—');var roleEl=$('aRole');var newRole=d.role||'viewer';txt(roleEl,newRole);roleEl.className='badge '+(newRole);st.currentRole=newRole;var mfaEl=$('aMfa');var mfaBanner=$('mfaBanner');if(d.mfa_status==='missing'){mfaEl.className='badge down';txt(mfaEl,'NO MFA SIGNAL');if(mfaBanner)mfaBanner.style.display=''}else if(d.mfa_status==='verified'){mfaEl.className='badge ok';txt(mfaEl,'VERIFIED');if(mfaBanner)mfaBanner.style.display='none'}else{mfaEl.className='badge warn';txt(mfaEl,'UNKNOWN')}
var state=d.session_state||(d.session_expires_at&&d.session_expires_at>Date.now()?'active':'expired');var expEl=$('aExpiry');var idEl=$('aIdle');var stEl=$('aSessState');
if(state==='active'){if(stEl){stEl.className='badge ok';txt(stEl,'● SESSION ACTIVE')}if(expEl){expEl.style.color='var(--healthy,#3fb950)';txt(expEl,fmt(d.session_expires_at))}if(idEl){idEl.style.color='';txt(idEl,'Idle: '+(d.idle_minutes||0)+'m')}clearSessErr()}
else if(state==='unauthenticated'||state==='no_session'){if(stEl){stEl.className='badge down';txt(stEl,'✗ NO SESSION')}var noKey=!gk;if(expEl){expEl.style.color='var(--muted)';txt(expEl,'—')}if(idEl){idEl.style.color='';txt(idEl,'—')}if(noKey){sessErr('No gateway key set. Click "Set Gateway Key" to authenticate.')}else{sessInfo('Starting session…')}}
else if(state==='idle'){if(stEl){stEl.className='badge warn';txt(stEl,'⚠ IDLE')}if(expEl){expEl.style.color='var(--warn,#d29922)';txt(expEl,fmt(d.session_expires_at))}if(idEl){idEl.style.color='var(--warn,#d29922)';txt(idEl,'Idle: '+(d.idle_minutes||0)+'m — session will expire soon')}sessInfo('Session idle for '+(d.idle_minutes||0)+'m. Click Extend Session to stay active.')}
else{if(stEl){stEl.className='badge down';txt(stEl,'✗ EXPIRED')}if(expEl){expEl.style.color='var(--down)';txt(expEl,'Expired — '+fmt(d.session_expires_at))}if(idEl){idEl.style.color='var(--down)';txt(idEl,'Idle: '+(d.idle_minutes||0)+'m (timed out)')}sessInfo('Session expired. Click Extend Session to start a new one.')}
if(state==='active'&&d.session_expires_at){startSessCountdown(d.session_expires_at)}else{if(sessCountdownTimer){clearInterval(sessCountdownTimer);sessCountdownTimer=null}var cdEl=$('sessCountdown');if(cdEl)cdEl.textContent=''}}
var _autoExtendPending=false;
function loadAccess(){var headers=gk?{'Authorization':'Bearer '+gk}:{};fetch('/api/control/access/session',{headers:headers}).then(function(r){return r.json()}).then(function(d){
  var state=d&&d.session_state;
  // Auto-extend: if we have a key but no active session, silently start one on first load.
  if(gk&&(state==='no_session'||state==='unauthenticated'||state==='expired')&&!_autoExtendPending){
    _autoExtendPending=true;
    authed('POST','/api/control/access/extend-session').then(function(r){
      _autoExtendPending=false;
      if(r&&r.ok){clearSessErr();loadAccess();}
      else{renderSession(d);}
    }).catch(function(){_autoExtendPending=false;renderSession(d);});
    return;
  }
  renderSession(d);
}).catch(function(){});renderPermMatrix()}
function startSessPoll(){stopSessPoll();sessTimer=setInterval(function(){var ac=$('atab-access');var tab=$('tab-access');if((ac&&ac.style.display!=='none')&&(tab&&tab.style.display!=='none')){loadAccess()}},60000)}
function stopSessPoll(){if(sessTimer){clearInterval(sessTimer);sessTimer=null}if(sessCountdownTimer){clearInterval(sessCountdownTimer);sessCountdownTimer=null}var cdEl=$('sessCountdown');if(cdEl)cdEl.textContent=''}
function startSessCountdown(expiresAt){if(sessCountdownTimer)clearInterval(sessCountdownTimer);sessCountdownTimer=setInterval(function(){var now=Date.now();var exp=typeof expiresAt==='number'?expiresAt:new Date(expiresAt).getTime();var diff=exp-now;var cdEl=$('sessCountdown');if(!cdEl){clearInterval(sessCountdownTimer);sessCountdownTimer=null;return}if(diff<=0){cdEl.textContent='Session expired';cdEl.style.color='var(--down)';clearInterval(sessCountdownTimer);sessCountdownTimer=null;return}var mins=Math.floor(diff/60000);var secs=Math.floor((diff%60000)/1000);cdEl.textContent='Expires in '+mins+'m '+secs+'s';cdEl.style.color=diff<300000?'var(--warn)':'var(--muted)'},1000)}
var PERMS=[{section:'Viewer Permissions'},{name:'Status',desc:'Read service status and registry data.',req:'Viewer',v:true,o:true,a:true},{name:'Metrics',desc:'Read live infra metrics and health checks.',req:'Viewer',v:true,o:true,a:true},{name:'Traces',desc:'Read request traces and diagnostic spans.',req:'Viewer',v:true,o:true,a:true},{name:'Audit log',desc:'Read access-control and infra audit entries.',req:'Viewer',v:true,o:true,a:true},{section:'Operator Permissions'},{name:'Restart',desc:'Restart managed services through infra controls.',req:'Operator',v:false,o:true,a:true},{name:'Rollback',desc:'Trigger guarded deploy rollback requests.',req:'Operator',v:false,o:true,a:true},{name:'Metrics ingest',desc:'Write service metric samples.',req:'Operator',v:false,o:true,a:true},{name:'Trace ingest',desc:'Write service trace events.',req:'Operator',v:false,o:true,a:true},{section:'Admin Permissions'},{name:'Config write',desc:'Change guarded infra configuration.',req:'Admin',v:false,o:false,a:true},{name:'Tokens',desc:'Issue and revoke service tokens.',req:'Admin',v:false,o:false,a:true},{name:'Delete services',desc:'Remove services from registry.',req:'Admin',v:false,o:false,a:true},{name:'Incident manage',desc:'Create, update, delete incidents.',req:'Admin',v:false,o:false,a:true}];
function renderPermMatrix(filter){var previewRoleVal=$('previewRoleOverlay')?($('previewRoleOverlay').textContent||'').toLowerCase():'';var activeRole=previewRoleVal||st.currentRole||'viewer';var tb=$('permBody');if(!tb)return;tb.innerHTML='';var q=(filter||'').toLowerCase();PERMS.forEach(function(p){if(p.section){if(q&&!p.section.toLowerCase().includes(q))return;tb.innerHTML+='<tr><td colspan="4" style="background:var(--panel2);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:700;padding:6px 10px;border-bottom:1px solid var(--border)">'+p.section+'</td></tr>';return}if(q&&!(p.name+p.desc).toLowerCase().includes(q))return;var g='<span style="color:var(--healthy);font-size:15px">●</span>',o='<span style="color:var(--border2);font-size:15px">○</span>';var myGrant=(activeRole==='admin'&&p.a)||(activeRole==='operator'&&p.o)||p.v;var rowStyle=myGrant?'background:rgba(63,185,80,.06)':'';tb.innerHTML+='<tr style="'+rowStyle+'"><td><div style="font-weight:500;font-size:13px">'+escHtml(p.name)+'</div><div style="font-size:11px;color:var(--muted);margin-top:2px">'+escHtml(p.desc)+'</div><div style="font-size:10px;color:var(--muted);margin-top:2px">Requires: '+p.req+'</div></td><td style="text-align:center">'+(p.v?g:o)+'</td><td style="text-align:center">'+(p.o?g:o)+'</td><td style="text-align:center">'+(p.a?g:o)+'</td></tr>'})}
function previewRole(sel){var role=(sel&&sel.value)||'viewer';var overlay=$('previewRoleOverlay');if(!overlay){overlay=document.createElement('div');overlay.id='previewRoleOverlay';overlay.style.cssText='display:none';document.body.appendChild(overlay)}overlay.textContent=role;var banner=$('previewRoleBanner');if(!banner){banner=document.createElement('div');banner.id='previewRoleBanner';banner.style.cssText='position:fixed;top:60px;left:50%;transform:translateX(-50%);background:var(--panel2);border:1px solid var(--accent);border-radius:6px;padding:8px 18px;font-size:13px;z-index:999;display:flex;gap:10px;align-items:center';banner.innerHTML='Previewing as <strong id="previewRoleLabel">'+escHtml(role)+'</strong><button class="btn ghost" style="font-size:11px;padding:3px 8px" onclick="previewRole(null)">Exit Preview</button>';document.body.appendChild(banner)}else{var lbl=$('previewRoleLabel');if(lbl)lbl.textContent=role}if(!role||role==='exit'){overlay.textContent='';if(banner)banner.style.display='none'}else{banner.style.display='flex'}renderPermMatrix(($('permFilter')||{}).value||'')}
function filterPerms(){renderPermMatrix(($('permFilter')||{}).value||'')}
function exportPermCsv(){var rows=[['Permission','Viewer','Operator','Admin']];PERMS.filter(function(p){return !p.section}).forEach(function(p){rows.push([p.name,p.v?'granted':'off',p.o?'granted':'off',p.a?'granted':'off'])});var csv=rows.map(function(r){return r.map(function(v){return'"'+v+'"'}).join(',')}).join('\n');var a=document.createElement('a');a.href='data:text/csv,'+encodeURIComponent(csv);a.download='permissions.csv';a.click()}
function copySession(){var info='Actor: '+(($('aActorName')||{}).textContent||'')+'\nRole: '+(($('aRole')||{}).textContent||'')+'\nMFA: '+(($('aMfa')||{}).textContent||'')+'\nExpiry: '+(($('aExpiry')||{}).textContent||'');navigator.clipboard.writeText(info).catch(function(){})}
function setGatewayKey(){if(promptKey()){_autoExtendPending=false;loadAccess();}}
function extendSession(retried){if(!gk){if(!promptKey())return}authed('POST','/api/control/access/extend-session').then(function(d){if(d&&d.ok){clearSessErr();loadAccess()}else if(d&&(d.error==='unauthorized'||d.error==='token_expired')&&!retried){if(promptKey())extendSession(true);else sessErr('Failed to extend session — gateway key required.')}else{sessErr('Failed to extend session'+(d&&d.error?' — '+d.error:'.'))}}).catch(function(){sessErr('Failed to extend session — network error.')})}
function renewSession(retried){if(!gk){if(!promptKey())return}authed('POST','/api/control/access/renew-session').then(function(d){if(d&&d.ok){clearSessErr();loadAccess()}else if(d&&(d.error==='unauthorized'||d.error==='token_expired')&&!retried){if(promptKey())renewSession(true);else sessErr('Failed to renew session — gateway key required.')}else{sessErr('Failed to renew session'+(d&&d.error?' — '+d.error:'.'))}}).catch(function(){sessErr('Failed to renew session — network error.')})}
function forceLogout(){if(!confirm('Force logout this session?'))return;if(!gk){promptKey();return}authed('POST','/api/control/access/logout').then(function(d){if(d&&d.ok){sessInfo('Session invalidated. Click Renew Session to start a new one.');loadAccess()}else{sessErr('Failed to log out'+(d&&d.error?' — '+d.error:'.'))}}).catch(function(){sessErr('Failed to log out — network error.')})}
function loadAudit(){var p=new URLSearchParams();if(st.org)p.set('org',st.org);p.set('limit','50');authed('GET','/api/control/access/audit?'+p).then(function(d){var tb=$('auditRows');tb.innerHTML='';var entries=Array.isArray(d.entries)?d.entries:[];if(!entries.length){tb.innerHTML='<tr><td colspan="5" style="color:var(--muted);padding:20px;text-align:center">No audit entries.</td></tr>';return}entries.forEach(function(e){tb.innerHTML+='<tr><td class="mono" style="font-size:11px">'+ago(e.created_at)+'</td><td><span class="badge p2">'+e.kind+'</span></td><td>'+(e.org||'—')+'</td><td>'+(e.project||'—')+'</td><td style="font-size:12px">'+e.message+'</td></tr>'})})}
function loadTokens(){if(!gk){$('tokenRows').innerHTML='<tr><td colspan="7" style="color:var(--muted);padding:16px;text-align:center"><button class="btn" onclick="promptKey()">Enter key to view tokens</button></td></tr>';return}var p=new URLSearchParams();if(st.org)p.set('org',st.org);authed('GET','/api/control/tokens?'+p).then(function(d){var tb=$('tokenRows');tb.innerHTML='';var tokens=Array.isArray(d.tokens)?d.tokens:[];if(!tokens.length){tb.innerHTML='<tr><td colspan="7" style="color:var(--muted);padding:20px;text-align:center">No tokens. Create one above.</td></tr>';return}tokens.forEach(function(t){var exp=t.expires_at?fmt(t.expires_at):'Never';var expStyle=t.expires_at&&t.expires_at<Date.now()?'style="color:var(--down)"':'';tb.innerHTML+='<tr><td>'+t.name+'</td><td>'+t.org+'</td><td><span class="badge viewer">'+t.scope+'</span></td><td class="mono" style="font-size:11px">'+fmt(t.created_at)+'</td><td class="mono" style="font-size:11px" '+expStyle+'>'+exp+'</td><td class="mono" style="font-size:11px">'+(t.last_used?fmt(t.last_used):'Never')+'</td><td><button class="btn danger" style="font-size:11px;padding:4px 8px" onclick="revokeToken(\''+t.id+'\')">Revoke</button></td></tr>'})})}
function openNewToken(){if(!gk){promptKey();return}$('tokModal').classList.add('open')}
function submitToken(){var name=($('tokName').value||'').trim();if(!name){alert('Name required');return}var exp=parseInt(($('tokExpiry').value||''))||undefined;authed('POST','/api/control/tokens',{org:st.org||'3Sixty Co.',name:name,scope:$('tokScope').value,expires_in_days:exp}).then(function(d){if(d.error){alert('Error: '+d.error);return}closeModal('tokModal');txt($('tokRevealVal'),d.token||'');$('tokRevealModal').classList.add('open');loadTokens()})}
function revokeToken(id){if(!confirm('Revoke token?'))return;authed('DELETE','/api/control/tokens/'+id).then(function(){loadTokens()})}
function openDrawer(){$('drawer').classList.add('open');$('scrim').classList.add('open')}
function closeDrawer(){$('drawer').classList.remove('open');$('scrim').classList.remove('open')}
function openService(id){openDrawer();var db=$('drawerBody');db.innerHTML='<h2 style="font-family:\'DM Sans\'">Loading…</h2>';api('/api/control/services/'+id).then(function(d){if(!d||!d.service){db.innerHTML='<h2>Not found</h2>';return}var s=d.service;var checks=(d.checks||[]).slice().reverse();var spark='';if(checks.length){var max=Math.max.apply(null,checks.map(function(c){return c.latency_ms||0}).concat([1]));spark='<div class="spark">'+checks.map(function(c){return'<span style="height:'+Math.max(2,Math.round((c.latency_ms||0)/max*36))+'px;background:'+(c.status==='healthy'?'var(--accent)':'var(--down)')+'"></span>'}).join('')+'</div>'}db.innerHTML='<h2 style="font-family:\'DM Sans\';margin-bottom:10px">'+s.name+'</h2><span class="badge '+s.status+'">'+s.status+'</span>'+spark+'<div class="kv-row"><span class="k">Uptime</span><span class="v mono">'+(typeof d.uptime==='number'?d.uptime+'%':'—')+'</span></div><div class="kv-row"><span class="k">Project</span><span class="v">'+s.project+'</span></div><div class="kv-row"><span class="k">Region</span><span class="v">'+s.region+'</span></div><div class="kv-row"><span class="k">Kind</span><span class="v">'+s.kind+'</span></div><div class="kv-row"><span class="k">Latency</span><span class="v mono">'+(s.latency_ms!=null?s.latency_ms+'ms':'—')+'</span></div><div class="kv-row"><span class="k">Last check</span><span class="v mono">'+ago(s.last_check)+'</span></div><div class="kv-row" style="border:none"><span class="k">URL</span><span class="v mono" style="font-size:11px">'+(s.url||'— (local)')+'</span></div>'})}
$('exportBtn').onclick=function(){var p=new URLSearchParams();if(st.org)p.set('org',st.org);if(st.project!==ALL)p.set('project',st.project);if(st.region!==ALL)p.set('region',st.region);if(st.status&&st.status!==ALL)p.set('status',st.status);if(st.q)p.set('q',st.q);p.set('format','csv');location.href='/api/control/export?'+p};
$('refreshBtn').onclick=function(){load()};
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeDrawer()});
function startAutoRefresh(){clearInterval(window._arTimer);var interval=parseInt(($('refreshIntervalSel')||{}).value||'30000',10);if(autoRefreshPaused)return;window._arTimer=setInterval(function(){updateFresh();load()},interval);}
startAutoRefresh();
$('refreshIntervalSel').onchange=function(){startAutoRefresh()};
$('pauseBtn').onclick=function(){autoRefreshPaused=!autoRefreshPaused;clearInterval(window._arTimer);$('pauseBtn').textContent=autoRefreshPaused?'▶ Resume':'⏸ Pause';if(!autoRefreshPaused)startAutoRefresh()};
function escHtml(s){var d=document.createElement('div');d.appendChild(document.createTextNode(s==null?'':String(s)));return d.innerHTML}
function renderMd(s){if(!s)return'';var h=escHtml(s);h=h.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');h=h.replace(/\*([^*]+)\*/g,'<em>$1</em>');h=h.replace(new RegExp('\x60([^\x60]+)\x60','g'),'<code style="background:var(--panel2);padding:1px 5px;border-radius:3px;font-size:0.9em">$1</code>');h=h.replace(/\n/g,'<br>');return h}
var aiMsgs=[];
function loadAiAssistant(){var ks=$('aiKeyStatus');if(ks){ks.textContent=gk?'set':'no key';ks.style.color=gk?'var(--healthy)':'var(--degraded)';}var chat=$('aiChat');if(chat&&aiMsgs.length>0){chat.innerHTML='';aiMsgs.forEach(function(m){appendAiMsg(m.role,m.content)})}updateAiSuggestedPrompts()}
function clearAiChat(){aiMsgs=[];var chat=$('aiChat');if(chat)chat.innerHTML='';if(aiAbortController){aiAbortController.abort();aiAbortController=null}try{localStorage.removeItem('ai_chat_history')}catch(e){}}
function aiStop(){if(aiAbortController){aiAbortController.abort();aiAbortController=null}var stopBtn=$('aiStopBtn');if(stopBtn)stopBtn.style.display='none'}
function updateAiSuggestedPrompts(){var sugBox=$('aiSuggestedPrompts');if(!sugBox)return;var downs=st.services.filter(function(s){return s.status==='down'||s.status==='degraded'});var sugs=[];if(downs.length>0)sugs.push('What is causing '+escHtml(downs[0].name)+' to be '+downs[0].status+'?');if(st.incCount>0)sugs.push('Summarise the '+st.incCount+' open incident'+(st.incCount>1?'s':'')+' and suggest next steps.');sugs.push('What services have the highest error rates right now?');sugs.push('Recommend infra cost optimizations based on current usage.');sugBox.innerHTML='';sugs.slice(0,4).forEach(function(s){var btn=document.createElement('button');btn.className='btn ghost';btn.style.cssText='font-size:11px;text-align:left;white-space:normal;padding:5px 10px';btn.textContent=s;btn.onclick=function(){var inp=$('aiInput');if(inp){inp.value=s;inp.dispatchEvent(new Event('input'))}aiSend()};sugBox.appendChild(btn)})}
function aiKeydown(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();aiSend();}}
function aiAppend(role,content){aiMsgs.push({role:role,content:content});try{localStorage.setItem('ai_chat_history',JSON.stringify(aiMsgs.slice(-20)))}catch(e){}var el=$('aiMessages');var empty=$('aiEmpty');if(empty)empty.style.display='none';var div=document.createElement('div');div.className='ai-msg '+role;var bubble=document.createElement('div');bubble.className='ai-bubble';bubble.innerHTML=role==='assistant'?renderMd(content):escHtml(content);var footer=document.createElement('div');footer.style.cssText='display:flex;gap:8px;align-items:center;margin-top:4px;opacity:0.7';var words=content.split(/\s+/).length;var tokEst=Math.round(words*1.3);footer.innerHTML='<span style="font-size:10px;color:var(--muted)">~'+tokEst+' tokens</span>';var copyBtn=document.createElement('button');copyBtn.style.cssText='background:transparent;border:1px solid var(--border);color:var(--muted);cursor:pointer;font-size:10px;padding:1px 6px;border-radius:3px';copyBtn.textContent='copy';copyBtn.onclick=function(){try{navigator.clipboard.writeText(content)}catch(e){}copyBtn.textContent='✓';setTimeout(function(){copyBtn.textContent='copy'},1200)};footer.appendChild(copyBtn);div.appendChild(bubble);div.appendChild(footer);el.appendChild(div);el.scrollTop=el.scrollHeight;}
function appendAiMsg(role,content){var el=$('aiMessages');if(!el)return;var empty=$('aiEmpty');if(empty)empty.style.display='none';var div=document.createElement('div');div.className='ai-msg '+role;var bubble=document.createElement('div');bubble.className='ai-bubble';bubble.innerHTML=role==='assistant'?renderMd(content):escHtml(content);div.appendChild(bubble);el.appendChild(div);el.scrollTop=el.scrollHeight;}
function aiSend(){if(!gk){promptKey();return;}var inp=$('aiInput');var text=(inp.value||'').trim();if(!text)return;inp.value='';inp.style.height='';aiAppend('user',text);var btn=$('aiSend');btn.disabled=true;var stopBtn=$('aiStopBtn');if(stopBtn)stopBtn.style.display='';var modelSel=$('aiModelSel');var model=modelSel?modelSel.value:'anthropic/claude-haiku-4.5';var msgEl=$('aiMessages');var typingDiv=document.createElement('div');typingDiv.className='ai-msg assistant';typingDiv.id='aiTyping';var typingBubble=document.createElement('div');typingBubble.className='ai-typing';typingBubble.innerHTML='<span></span><span></span><span></span>';typingDiv.appendChild(typingBubble);msgEl.appendChild(typingDiv);msgEl.scrollTop=msgEl.scrollHeight;if(aiAbortController)aiAbortController.abort();aiAbortController=new AbortController();var signal=aiAbortController.signal;fetch('/v1/chat/completions',{method:'POST',signal:signal,headers:{'Content-Type':'application/json','Authorization':'Bearer '+gk},body:JSON.stringify({model:model,messages:aiMsgs,max_tokens:1024,stream:true})}).then(function(r){var typing=document.getElementById('aiTyping');if(typing)typing.remove();if(!r.ok){return r.json().then(function(d){btn.disabled=false;if(stopBtn)stopBtn.style.display='none';aiAbortController=null;aiAppend('assistant','Error: '+(d.error&&d.error.message?d.error.message:r.status))})}var reader=r.body.getReader();var decoder=new TextDecoder();var accum='';var streamDiv=document.createElement('div');streamDiv.className='ai-msg assistant';var streamBubble=document.createElement('div');streamBubble.className='ai-bubble';streamDiv.appendChild(streamBubble);msgEl.appendChild(streamDiv);function pump(){return reader.read().then(function(res){if(res.done||signal.aborted){btn.disabled=false;if(stopBtn)stopBtn.style.display='none';aiAbortController=null;if(accum){aiMsgs.push({role:'assistant',content:accum});try{localStorage.setItem('ai_chat_history',JSON.stringify(aiMsgs.slice(-20)))}catch(e){}}var footer=document.createElement('div');footer.style.cssText='display:flex;gap:8px;align-items:center;margin-top:4px;opacity:0.7';var words=accum.split(/\s+/).length;footer.innerHTML='<span style="font-size:10px;color:var(--muted)">~'+Math.round(words*1.3)+' tokens</span>';var copyBtn=document.createElement('button');copyBtn.style.cssText='background:transparent;border:1px solid var(--border);color:var(--muted);cursor:pointer;font-size:10px;padding:1px 6px;border-radius:3px';copyBtn.textContent='copy';var captured=accum;copyBtn.onclick=function(){try{navigator.clipboard.writeText(captured)}catch(e){}copyBtn.textContent='✓';setTimeout(function(){copyBtn.textContent='copy'},1200)};footer.appendChild(copyBtn);streamDiv.appendChild(footer);return}var chunk=decoder.decode(res.value,{stream:true});var lines=chunk.split('\n');for(var li=0;li<lines.length;li++){var line=lines[li].trim();if(!line||line==='data: [DONE]')continue;if(line.slice(0,6)==='data: '){try{var evt=JSON.parse(line.slice(6));var delta=evt.choices&&evt.choices[0]&&evt.choices[0].delta&&evt.choices[0].delta.content;if(delta){accum+=delta;streamBubble.innerHTML=renderMd(accum);msgEl.scrollTop=msgEl.scrollHeight}}catch(e){}}}return pump()}).catch(function(e){if(e.name==='AbortError')return;btn.disabled=false;if(stopBtn)stopBtn.style.display='none';aiAbortController=null;var typing2=document.getElementById('aiTyping');if(typing2)typing2.remove();aiAppend('assistant','Network error: '+e.message)})}pump()}).catch(function(e){var typing3=document.getElementById('aiTyping');if(typing3)typing3.remove();btn.disabled=false;if(stopBtn)stopBtn.style.display='none';aiAbortController=null;if(e.name!=='AbortError')aiAppend('assistant','Network error: '+e.message)});}
function sug(topic){nav(document.querySelector('[data-tab="ai-assistant"]'));var ctx='Infra context: health_score='+(st.summary&&st.summary.score!=null?st.summary.score:0)+'%, services='+(st.summary&&st.summary.total||0)+', healthy='+(st.summary&&st.summary.healthy||0)+', degraded='+(st.summary&&st.summary.degraded||0)+', down='+(st.summary&&st.summary.down||0)+', cost='+st.infraCost+'.';var inp=$('aiInput');if(inp){inp.value=topic+' '+ctx;inp.dispatchEvent(new Event('input'));aiSend();}}
function loadTopology(){var b=$('topologyBody');if(!b)return;var topFil=$('topologyFilter');var filterText=topFil?(topFil.value||'').toLowerCase():'';var svcs=st.services.filter(function(s){if(!filterText)return true;return (s.name+s.project+s.kind).toLowerCase().indexOf(filterText)>=0});if(!svcs.length){b.innerHTML='<div class="panel empty"><div>'+(filterText?'No services match filter.':'No services registered.')+'</div></div>';return}var allHealthy=svcs.every(function(s){return s.status==='healthy'});var rollupBadge=allHealthy?'<span class="badge ok">All Healthy</span>':(svcs.some(function(s){return s.status==='down'})?'<span class="badge down">Service Down</span>':'<span class="badge degraded">Degraded</span>');var byProj={};svcs.forEach(function(s){if(!byProj[s.project])byProj[s.project]=[];byProj[s.project].push(s)});b.innerHTML='<div style="margin-bottom:10px;display:flex;gap:8px;align-items:center"><span style="font-size:13px;color:var(--muted)">Health rollup:</span>'+rollupBadge+'</div>';Object.keys(byProj).sort().forEach(function(proj){var g=document.createElement('div');g.className='panel';g.style.cssText='padding:16px;margin-bottom:12px';var hdr=document.createElement('div');hdr.className='section-header';var title=document.createElement('span');title.className='section-title';title.textContent=proj;hdr.appendChild(title);var cnt=document.createElement('span');cnt.className='badge';cnt.style.marginLeft='8px';cnt.textContent=byProj[proj].length+' svc';hdr.appendChild(cnt);g.appendChild(hdr);var row=document.createElement('div');row.style.cssText='display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:10px';byProj[proj].forEach(function(s,i){if(i>0){var arrowColor=byProj[proj][i-1].status==='down'?'var(--down)':byProj[proj][i-1].status==='degraded'?'var(--degraded)':'var(--muted)';var a=document.createElement('span');a.style.cssText='font-size:16px;user-select:none;color:'+arrowColor;a.textContent='→';row.appendChild(a)}var node=document.createElement('div');node.className='panel';node.style.cssText='padding:10px 14px;cursor:pointer;min-width:120px;text-align:center;transition:border-color .15s;border-left:3px solid '+(s.status==='healthy'?'var(--healthy)':s.status==='degraded'?'var(--degraded)':'var(--down)');node.onmouseenter=function(){this.style.borderColor='var(--accent)'};node.onmouseleave=function(){this.style.borderLeftColor=(s.status==='healthy'?'var(--healthy)':s.status==='degraded'?'var(--degraded)':'var(--down)')};node.onclick=function(){openService(s.id)};node.innerHTML='<div style="font-size:12px;font-weight:600;margin-bottom:6px">'+escHtml(s.name)+'</div><span class="badge '+s.status+'">'+s.status+'</span><div style="font-size:10px;color:var(--muted);margin-top:5px">'+escHtml(s.kind)+(s.url?'<br><span style="color:var(--accent);font-size:9px">● public</span>':'<br><span style="color:var(--muted);font-size:9px">○ local</span>')+'</div>';row.appendChild(node)});g.appendChild(row);b.appendChild(g)})}
qsInit();load();
})();
</script>
</body>
</html>`;
