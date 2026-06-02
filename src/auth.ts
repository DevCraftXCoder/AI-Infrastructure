import type { Context, Next } from "hono";
import type { Env, Variables } from "./types.js";

type Ctx = { Bindings: Env; Variables: Variables };

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyAuth(c: Context<Ctx>, next: Next): Promise<Response | void> {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return c.json({ error: "unauthorized" }, 401);

  const token = header.slice(7);
  const enc = new TextEncoder();
  const tokenHashBuf = await crypto.subtle.digest("SHA-256", enc.encode(token));

  // ── 1. Master gateway key (bypasses per-service token check) ───────────────
  if (c.env.GATEWAY_KEY) {
    const masterHashBuf = await crypto.subtle.digest("SHA-256", enc.encode(c.env.GATEWAY_KEY));
    if (crypto.subtle.timingSafeEqual(tokenHashBuf, masterHashBuf)) {
      c.set("callerHash", toHex(tokenHashBuf));
      return next();
    }
  }

  // ── 2. Per-service token — look up SHA-256 hash in D1 service_tokens table ─
  const tokenHash = toHex(tokenHashBuf);
  let row: { id: string; is_active: number | null; expires_at: number | null } | null = null;
  try {
    row = await c.env.DB.prepare(
      "SELECT id, is_active, expires_at FROM service_tokens WHERE token_hash = ? LIMIT 1"
    ).bind(tokenHash).first<{ id: string; is_active: number | null; expires_at: number | null }>();
  } catch { /* D1 error — fall through to 401 */ }

  if (!row) return c.json({ error: "unauthorized" }, 401);

  // Reject if explicitly deactivated
  if (row.is_active === 0) return c.json({ error: "unauthorized" }, 401);

  // Reject if expired
  if (row.expires_at !== null && row.expires_at < Date.now()) return c.json({ error: "token_expired" }, 401);

  // Update last_used asynchronously — best-effort, never block the response
  c.executionCtx.waitUntil(
    c.env.DB.prepare("UPDATE service_tokens SET last_used = ? WHERE id = ?")
      .bind(Date.now(), row.id).run().catch(() => {})
  );

  c.set("callerHash", tokenHash);
  return next();
}
