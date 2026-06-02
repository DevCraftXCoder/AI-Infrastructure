/**
 * session.ts
 * Real, persisted session lifecycle for the control-plane dashboard.
 *
 * Sessions are D1 rows keyed by caller_hash (SHA-256 hex of the bearer
 * credential — the same identity verifyAuth derives). This replaces the
 * stateless "session_expires_at = now + 8h" fiction with enforced absolute
 * expiry + idle timeout, auditable extend/renew/logout events.
 *
 * The static GATEWAY_KEY (or a per-service token) remains the API credential
 * for all /api/control/* calls. A session is a tracked lifecycle object layered
 * on that identity — not a replacement auth scheme.
 */
import type { Env } from "./types.js";
import { logActivity } from "./registry.js";

export const SESSION_TTL_MS = 8 * 3600 * 1000;   // absolute hard expiry: 8h
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;   // inactivity window: 30m
const AUDIT_ORG = "3Sixty Co.";

export type SessionState = "active" | "idle" | "expired" | "revoked";

export interface SessionRow {
  id: string;
  caller_hash: string;
  actor: string;
  created_at: number;
  expires_at: number;
  last_seen: number;
  idle_timeout_ms: number;
  extend_count: number;
  revoked: number;
}

export interface SessionView {
  session_id: string;
  session_state: SessionState;
  session_expires_at: number;   // absolute expiry (ms epoch)
  idle_expires_at: number;      // last_seen + idle_timeout (ms epoch)
  idle_minutes: number;         // whole minutes since last_seen
  created_at: number;
  extend_count: number;
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function newId(): string {
  return "sess_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

/** Pure classifier — never touches D1. */
export function evaluate(row: SessionRow, now: number): { state: SessionState; idle_minutes: number } {
  const idle_minutes = Math.max(0, Math.floor((now - row.last_seen) / 60000));
  if (row.revoked === 1) return { state: "revoked", idle_minutes };
  if (now >= row.expires_at) return { state: "expired", idle_minutes };
  if (now - row.last_seen >= row.idle_timeout_ms) return { state: "idle", idle_minutes };
  return { state: "active", idle_minutes };
}

function view(row: SessionRow, state: SessionState, idle_minutes: number): SessionView {
  return {
    session_id: row.id,
    session_state: state,
    session_expires_at: row.expires_at,
    idle_expires_at: row.last_seen + row.idle_timeout_ms,
    idle_minutes,
    created_at: row.created_at,
    extend_count: row.extend_count,
  };
}

async function liveRow(env: Env, callerHash: string, now: number): Promise<SessionRow | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT * FROM sessions WHERE caller_hash = ? AND revoked = 0 ORDER BY created_at DESC LIMIT 1"
    ).bind(callerHash).first<SessionRow>();
    if (!row) return null;
    const { state } = evaluate(row, now);
    return state === "active" || state === "idle" ? row : null;
  } catch {
    return null;
  }
}

async function revokeLive(env: Env, callerHash: string, now: number): Promise<void> {
  try {
    await env.DB.prepare(
      "UPDATE sessions SET revoked = 1 WHERE caller_hash = ? AND revoked = 0 AND expires_at > ?"
    ).bind(callerHash, now).run();
  } catch { /* best-effort */ }
}

async function mint(env: Env, callerHash: string, actor: string, now: number): Promise<SessionRow> {
  const row: SessionRow = {
    id: newId(),
    caller_hash: callerHash,
    actor,
    created_at: now,
    expires_at: now + SESSION_TTL_MS,
    last_seen: now,
    idle_timeout_ms: IDLE_TIMEOUT_MS,
    extend_count: 0,
    revoked: 0,
  };
  // No try/catch — let D1 errors propagate to the route handler so callers
  // never receive a phantom "active" session for a row that wasn't persisted.
  const result = await env.DB.prepare(
    "INSERT INTO sessions (id, caller_hash, actor, created_at, expires_at, last_seen, idle_timeout_ms, extend_count, revoked) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind(row.id, row.caller_hash, row.actor, row.created_at, row.expires_at, row.last_seen, row.idle_timeout_ms, row.extend_count, row.revoked).run();
  if (!result.success) throw new Error("session_insert_failed");
  return row;
}

/**
 * Read-only session query — NEVER writes (no last_seen bump, no mint, no revoke).
 *
 * The 60s dashboard poll uses this so the poll itself cannot keep a session alive.
 * Idle timeout fires correctly after 30m of no explicit Extend actions.
 * Returns null when no session exists for the caller (first load, post-logout).
 */
export async function readSession(env: Env, callerHash: string, now: number): Promise<SessionView | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT * FROM sessions WHERE caller_hash = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(callerHash).first<SessionRow>();
    if (!row) return null;
    const { state, idle_minutes } = evaluate(row, now);
    return view(row, state, idle_minutes);
  } catch { return null; }
}

/** Deliberate Extend: roll absolute expiry forward and reset idle. Also the
 *  only way to start a new session (mint) for a caller with no live session.
 *  `actor` should be a short opaque identifier derived from callerHash, not a
 *  human name, so the audit trail can distinguish credentials. */
export async function extend(env: Env, callerHash: string, actor: string, now: number): Promise<SessionView> {
  const live = await liveRow(env, callerHash, now);
  if (live) {
    const expires_at = now + SESSION_TTL_MS;
    // AND revoked = 0 guard: prevents a concurrent poll-revoke from silently
    // accepting an extend that arrived in the same D1 transaction window.
    const result = await env.DB.prepare(
      "UPDATE sessions SET expires_at = ?, last_seen = ?, extend_count = extend_count + 1 WHERE id = ? AND revoked = 0"
    ).bind(expires_at, now, live.id).run();
    if ((result.meta?.changes ?? 0) > 0) {
      live.expires_at = expires_at; live.last_seen = now; live.extend_count += 1;
      await logActivity(env, { org: AUDIT_ORG, kind: "session.extend", message: `Session extended by ${actor}`, detail: `+8h, extend #${live.extend_count}` });
      return view(live, "active", 0);
    }
    // 0 changes = row was concurrently revoked; fall through to mint fresh.
  }
  const fresh = await mint(env, callerHash, actor, now);
  await logActivity(env, { org: AUDIT_ORG, kind: "session.extend", message: `Session (re)started by ${actor}`, detail: live ? "concurrent-revoke, minted fresh" : "no prior session" });
  return view(fresh, "active", 0);
}

/** Renew: rotate to a brand-new session (revoke prior), re-assert identity. */
export async function renew(env: Env, callerHash: string, actor: string, now: number): Promise<SessionView> {
  await revokeLive(env, callerHash, now);
  const fresh = await mint(env, callerHash, actor, now);
  await logActivity(env, { org: AUDIT_ORG, kind: "session.renew", message: `Session renewed (rotated) by ${actor}`, detail: fresh.id });
  return view(fresh, "active", 0);
}

/** Logout: revoke every live session for this caller. */
export async function revokeAll(env: Env, callerHash: string, actor: string, now: number): Promise<void> {
  await revokeLive(env, callerHash, now);
  await logActivity(env, { org: AUDIT_ORG, kind: "session.logout", message: `Session(s) invalidated by ${actor}`, detail: null });
}
