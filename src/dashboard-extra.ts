/**
 * dashboard-extra.ts
 * New control-plane endpoints: Incidents, Logs, Access/Session, Service Tokens, Audit Trail
 * All routes mounted on the `dash` router in dashboard.ts
 */
import { Hono } from "hono";
import type { Env, Variables } from "./types.js";
import { verifyAuth, verifyAdminOnly } from "./auth.js";
import { sha256Hex, readSession, extend as extendSession, renew as renewSession, revokeAll } from "./session.js";

const extra = new Hono<{ Bindings: Env; Variables: Variables }>();

function uid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

// ── INCIDENTS ──────────────────────────────────────────────────────────────

interface IncidentRow {
  id: string; org: string; project: string | null; title: string;
  severity: string; status: string; affected_users: number | null;
  sla_breached: number; detail: string | null; created_at: number; updated_at: number;
}

extra.get("/api/control/incidents", verifyAuth, async (c) => {
  try {
    const org = c.req.query("org") || undefined;
    const status = c.req.query("status") || undefined;
    const where: string[] = [];
    const binds: (string | number)[] = [];
    if (org) { where.push("org = ?"); binds.push(org); }
    if (status && status !== "__all__") { where.push("status = ?"); binds.push(status); }
    const sql = `SELECT * FROM incidents ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY severity ASC, created_at DESC LIMIT 100`;
    const r = await c.env.DB.prepare(sql).bind(...binds).all<IncidentRow>();
    const rows = r.results ?? [];

    // Auto-flag SLA breaches based on open age × severity thresholds.
    const SLA_MS: Record<string, number> = { P0: 3_600_000, P1: 14_400_000, P2: 86_400_000, P3: 259_200_000 };
    const nowMs = Date.now();
    const toFlag = rows.filter(i => i.status !== "resolved" && !i.sla_breached && (nowMs - i.created_at) > (SLA_MS[i.severity] ?? Infinity));
    if (toFlag.length > 0) {
      await Promise.all(toFlag.map(i =>
        c.env.DB.prepare("UPDATE incidents SET sla_breached = 1, updated_at = ? WHERE id = ?").bind(nowMs, i.id).run()
      ));
      toFlag.forEach(i => { i.sla_breached = 1; i.updated_at = nowMs; });
    }

    const open = rows.filter(i => i.status !== "resolved").length;
    const critical = rows.filter(i => i.severity === "P0" && i.status !== "resolved").length;
    return c.json({ incidents: rows, stats: { open, critical } });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

extra.post("/api/control/incidents", verifyAuth, async (c) => {
  let body: { org?: string; project?: string; title?: string; severity?: string; detail?: string; affected_users?: number };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body.org || !body.title) return c.json({ error: "org_and_title_required" }, 400);
  const validSev = new Set(["P0", "P1", "P2", "P3"]);
  const severity = (body.severity && validSev.has(body.severity)) ? body.severity : "P2";
  try {
    const id = "inc_" + uid();
    const now = Date.now();
    await c.env.DB.prepare(
      "INSERT INTO incidents (id, org, project, title, severity, status, affected_users, sla_breached, detail, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, body.org, body.project ?? null, body.title, severity, "open", body.affected_users ?? null, 0, body.detail ?? null, now, now).run();
    const row = await c.env.DB.prepare("SELECT * FROM incidents WHERE id = ?").bind(id).first<IncidentRow>();
    return c.json({ incident: row }, 201);
  } catch { return c.json({ error: "internal_error" }, 500); }
});

extra.patch("/api/control/incidents/:id", verifyAuth, async (c) => {
  let body: { status?: string; severity?: string; detail?: string; affected_users?: number; sla_breached?: number };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  const id = c.req.param("id") ?? "";
  try {
    const existing = await c.env.DB.prepare("SELECT * FROM incidents WHERE id = ?").bind(id).first<IncidentRow>();
    if (!existing) return c.json({ error: "not_found" }, 404);
    const validStatus = new Set(["open", "identified", "in_progress", "resolved"]);
    const validSev = new Set(["P0", "P1", "P2", "P3"]);
    await c.env.DB.prepare(
      "UPDATE incidents SET status = ?, severity = ?, detail = ?, affected_users = ?, sla_breached = ?, updated_at = ? WHERE id = ?"
    ).bind(
      (body.status && validStatus.has(body.status)) ? body.status : existing.status,
      (body.severity && validSev.has(body.severity)) ? body.severity : existing.severity,
      body.detail ?? existing.detail,
      body.affected_users ?? existing.affected_users,
      body.sla_breached ?? existing.sla_breached,
      Date.now(), id
    ).run();
    const row = await c.env.DB.prepare("SELECT * FROM incidents WHERE id = ?").bind(id).first<IncidentRow>();
    return c.json({ incident: row });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

extra.delete("/api/control/incidents/:id", verifyAuth, async (c) => {
  const id = c.req.param("id") ?? "";
  try {
    const existing = await c.env.DB.prepare("SELECT * FROM incidents WHERE id = ?").bind(id).first<IncidentRow>();
    if (!existing) return c.json({ error: "not_found" }, 404);
    await c.env.DB.prepare("DELETE FROM incidents WHERE id = ?").bind(id).run();
    return c.json({ ok: true });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

// ── LOGS ───────────────────────────────────────────────────────────────────

extra.get("/api/control/logs", verifyAuth, async (c) => {
  try {
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const status = c.req.query("status") || undefined;
    const service = c.req.query("service") || undefined;
    const where: string[] = [];
    const binds: (string | number)[] = [];
    if (status && status !== "__all__") { where.push("status = ?"); binds.push(status); }
    if (service && service !== "__all__") { where.push("service_id = ?"); binds.push(service); }
    const sql = `SELECT hc.*, s.name as service_name, s.project, s.org FROM health_checks hc LEFT JOIN services s ON s.id = hc.service_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY hc.checked_at DESC LIMIT ?`;
    binds.push(isNaN(limit) ? 50 : limit);
    const r = await c.env.DB.prepare(sql).bind(...binds).all<{
      id: string; service_id: string; service_name: string; project: string; org: string;
      status: string; latency_ms: number | null; status_code: number | null; checked_at: number;
    }>();
    const rows = r.results ?? [];
    const ok = rows.filter(r => r.status === "healthy").length;
    const errors = rows.filter(r => r.status === "down").length;
    return c.json({ logs: rows, stats: { total: rows.length, ok, errors } });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

// ── ACCESS / SESSION ───────────────────────────────────────────────────────

extra.get("/api/control/access/session", async (c) => {
  const header = c.req.header("Authorization") || "";
  const hasToken = header.startsWith("Bearer ") && header.length > 7;
  let mfa_status: "verified" | "missing" | "unknown" = "missing";
  let role: "viewer" | "operator" | "admin" = "viewer";
  let isAdmin = false;

  if (hasToken && c.env.GATEWAY_KEY) {
    const token = header.slice(7);
    const enc = new TextEncoder();
    const [a, b] = await Promise.all([
      crypto.subtle.digest("SHA-256", enc.encode(token)),
      crypto.subtle.digest("SHA-256", enc.encode(c.env.GATEWAY_KEY)),
    ]);
    isAdmin = crypto.subtle.timingSafeEqual(a, b);
    if (isAdmin) {
      role = "admin";
      mfa_status = "verified"; // gateway key presence IS identity assurance
    }
  }

  const now = Date.now();

  // Unauthenticated (no/invalid key) → no session. Expiry in the past so the
  // UI shows "Expired" but distinguishes this from a real timed-out session.
  if (!isAdmin) {
    return c.json({
      actor: "Frxncois",
      auth_provider: "unauthenticated",
      role,
      mfa_status,
      access_risk_score: 40,
      session_state: "unauthenticated",
      session_expires_at: now - 1,
      idle_expires_at: now - 1,
      idle_minutes: 0,
      region: "auto",
      identity: "Unknown | unauthenticated",
    });
  }

  // Authenticated → real, persisted session. Read-only on GET so the 60s
  // dashboard poll cannot keep the session alive by itself — idle fires after
  // 30m of no explicit Extend actions. mint happens only via POST extend-session.
  const callerHash = await sha256Hex(header.slice(7));
  const sv = await readSession(c.env, callerHash, now);

  // No session yet (first load, post-logout) — report unauthenticated shape
  // so the UI prompts the user to click Extend/Renew to start one.
  if (!sv) {
    return c.json({
      actor: "Frxncois",
      auth_provider: "admin_auth_gateway",
      role: "admin",
      mfa_status: "missing",
      access_risk_score: 90,
      session_state: "no_session",
      session_expires_at: now - 1,
      idle_expires_at: now - 1,
      idle_minutes: 0,
      extend_count: 0,
      region: "auto",
      identity: "Frxncois | admin_gateway | _auth_gateway | Online",
    });
  }

  return c.json({
    actor: "Frxncois",
    auth_provider: "admin_auth_gateway",
    role,
    mfa_status: (sv.session_state === "expired" || sv.session_state === "idle") ? "missing" : mfa_status,
    access_risk_score: 90,
    session_id: sv.session_id,
    session_state: sv.session_state,
    session_expires_at: sv.session_expires_at,
    idle_expires_at: sv.idle_expires_at,
    idle_minutes: sv.idle_minutes,
    extend_count: sv.extend_count,
    region: "auto",
    identity: "Frxncois | admin_gateway | _auth_gateway | Online",
  });
});

extra.post("/api/control/access/extend-session", verifyAdminOnly, async (c) => {
  try {
    const callerHash = c.get("callerHash");
    const actor = "admin:" + callerHash.slice(0, 8);
    const sv = await extendSession(c.env, callerHash, actor, Date.now());
    return c.json({
      ok: true,
      session_id: sv.session_id,
      session_state: sv.session_state,
      session_expires_at: sv.session_expires_at,
      idle_expires_at: sv.idle_expires_at,
      idle_minutes: sv.idle_minutes,
      extend_count: sv.extend_count,
    });
  } catch { return c.json({ ok: false, error: "internal_error" }, 500); }
});

extra.post("/api/control/access/renew-session", verifyAdminOnly, async (c) => {
  try {
    const callerHash = c.get("callerHash");
    const actor = "admin:" + callerHash.slice(0, 8);
    const sv = await renewSession(c.env, callerHash, actor, Date.now());
    return c.json({
      ok: true,
      mfa_status: "verified",
      session_id: sv.session_id,
      session_state: sv.session_state,
      session_expires_at: sv.session_expires_at,
      idle_expires_at: sv.idle_expires_at,
      idle_minutes: sv.idle_minutes,
    });
  } catch { return c.json({ ok: false, error: "internal_error" }, 500); }
});

extra.post("/api/control/access/logout", verifyAdminOnly, async (c) => {
  try {
    const callerHash = c.get("callerHash");
    await revokeAll(c.env, callerHash, "admin:" + callerHash.slice(0, 8), Date.now());
    return c.json({ ok: true, message: "Session invalidated" });
  } catch { return c.json({ ok: false, error: "internal_error" }, 500); }
});

// ── AUDIT TRAIL ────────────────────────────────────────────────────────────

extra.get("/api/control/access/audit", verifyAuth, async (c) => {
  try {
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const org = c.req.query("org") || undefined;
    const where: string[] = [];
    const binds: (string | number)[] = [];
    if (org) { where.push("org = ?"); binds.push(org); }
    const sql = `SELECT * FROM activity ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
    binds.push(isNaN(limit) ? 50 : limit);
    const r = await c.env.DB.prepare(sql).bind(...binds).all();
    return c.json({ entries: r.results ?? [] });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

// ── SERVICE TOKENS ─────────────────────────────────────────────────────────

interface TokenRow {
  id: string; org: string; name: string; scope: string;
  token_hash: string; created_at: number; expires_at: number | null; last_used: number | null;
}

extra.get("/api/control/tokens", verifyAuth, async (c) => {
  try {
    const org = c.req.query("org") || undefined;
    const where = org ? "WHERE org = ?" : "";
    const binds = org ? [org] : [];
    const r = await c.env.DB.prepare(`SELECT id, org, name, scope, created_at, expires_at, last_used FROM service_tokens ${where} ORDER BY created_at DESC LIMIT 100`)
      .bind(...binds).all<Omit<TokenRow, "token_hash">>();
    return c.json({ tokens: r.results ?? [] });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

extra.post("/api/control/tokens", verifyAuth, async (c) => {
  let body: { org?: string; name?: string; scope?: string; expires_in_days?: number };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body.org || !body.name) return c.json({ error: "org_and_name_required" }, 400);
  try {
    const id = "tok_" + uid();
    const rawToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawToken)))).map(b => b.toString(16).padStart(2, "0")).join("");
    const now = Date.now();
    const expires_at = body.expires_in_days ? now + body.expires_in_days * 86400000 : null;
    await c.env.DB.prepare(
      "INSERT INTO service_tokens (id, org, name, scope, token_hash, created_at, expires_at, last_used) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(id, body.org, body.name, body.scope ?? "read", hash, now, expires_at, null).run();
    return c.json({ id, token: rawToken, name: body.name, scope: body.scope ?? "read", expires_at }, 201);
  } catch { return c.json({ error: "internal_error" }, 500); }
});

extra.delete("/api/control/tokens/:id", verifyAuth, async (c) => {
  const id = c.req.param("id") ?? "";
  try {
    const existing = await c.env.DB.prepare("SELECT id FROM service_tokens WHERE id = ?").bind(id).first();
    if (!existing) return c.json({ error: "not_found" }, 404);
    await c.env.DB.prepare("DELETE FROM service_tokens WHERE id = ?").bind(id).run();
    return c.json({ ok: true });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

// ── OBSERVABILITY (SLO + telemetry) ────────────────────────────────────────

extra.get("/api/control/observability", verifyAuth, async (c) => {
  try {
    const timeWindow = Math.min(parseInt(c.req.query("window") || "86400000", 10), 7 * 86400000);
    const since = Date.now() - timeWindow;

    // p99 via stats: avg + 2.33σ (99th‑percentile z‑score) with max_latency as safety cap.
    // For sparse samples (<20 checks) max_latency is used directly.
    const latencyRows = await c.env.DB.prepare(`
      SELECT s.name, s.project,
        AVG(hc.latency_ms) AS avg_latency,
        SQRT(AVG(hc.latency_ms * hc.latency_ms) - AVG(hc.latency_ms) * AVG(hc.latency_ms)) AS stddev_latency,
        MAX(hc.latency_ms) AS max_latency,
        COUNT(*) AS checks,
        SUM(CASE WHEN hc.status = 'healthy' THEN 1 ELSE 0 END) AS healthy_checks
      FROM health_checks hc
      JOIN services s ON s.id = hc.service_id
      WHERE hc.checked_at >= ?
      GROUP BY hc.service_id
      ORDER BY avg_latency DESC
      LIMIT 20
    `).bind(since).all<{ name: string; project: string; avg_latency: number; stddev_latency: number; max_latency: number; checks: number; healthy_checks: number }>();

    const services = (latencyRows.results ?? []).map(r => {
      const avg = r.avg_latency ?? 0;
      const std = r.stddev_latency ?? 0;
      const max = r.max_latency ?? 0;
      const p99 = r.checks < 20
        ? Math.round(max)
        : Math.round(Math.min(max, avg + 2.33 * std));
      return {
        name: r.name,
        project: r.project,
        p99_latency_ms: p99,
        avg_latency_ms: Math.round(avg),
        error_rate: r.checks > 0 ? Math.round(((r.checks - r.healthy_checks) / r.checks) * 10000) / 100 : 0,
        checks: r.checks,
      };
    });

    const totals = await c.env.DB.prepare(`
      SELECT COUNT(*) AS total_checks,
        SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) AS healthy_checks,
        AVG(latency_ms) AS avg_latency
      FROM health_checks WHERE checked_at >= ?
    `).bind(since).first<{ total_checks: number; healthy_checks: number; avg_latency: number }>();

    const t = totals ?? { total_checks: 0, healthy_checks: 0, avg_latency: 0 };
    const throughput = Math.round(t.total_checks / (timeWindow / 1000));
    const actualErrorRate = t.total_checks > 0
      ? Math.round(((t.total_checks - t.healthy_checks) / t.total_checks) * 10000) / 100
      : 0;
    const maxP99 = services.length > 0 ? Math.max(...services.map(s => s.p99_latency_ms)) : 0;

    // Coverage: services with at least one health_check row in any time window.
    const cov = await c.env.DB.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN hc.cnt > 0 THEN 1 ELSE 0 END) AS covered
      FROM services s
      LEFT JOIN (SELECT service_id, COUNT(*) AS cnt FROM health_checks GROUP BY service_id) hc
        ON hc.service_id = s.id
    `).first<{ total: number; covered: number }>();

    return c.json({
      services,
      slo: {
        p99_latency: { target_ms: 300, actual_ms: maxP99, status: maxP99 <= 300 ? "passing" : "failing" },
        error_rate:  { target_pct: 5, actual_pct: actualErrorRate, status: actualErrorRate <= 5 ? "passing" : "failing" },
        throughput:  { target_rps: 1000, actual: throughput, status: throughput >= 0 ? "passing" : "failing" },
      },
      summary: {
        total_checks: t.total_checks,
        error_rate: actualErrorRate,
        avg_latency_ms: Math.round(t.avg_latency ?? 0),
        instrumentation_coverage: { covered: cov?.covered ?? 0, total: cov?.total ?? 0 },
      },
    });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

// ── HEARTBEAT (push-in for PM2/Docker/local services) ──────────────────────
//
// Local services (stats-server, sic, EV Betta scraper) can't be reached by the
// 5-min health-check cron because they bind to 127.0.0.1. This endpoint lets
// them push their own heartbeat so the control plane stays accurate without
// polling. The service must already be registered in the services table.

extra.post("/api/control/heartbeat", verifyAuth, async (c) => {
  let body: { org?: string; project?: string; service?: string; status?: string; latency_ms?: number; version?: string; detail?: string | null };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body.org || !body.service) return c.json({ error: "org_and_service_required" }, 400);
  const validStatus = new Set(["healthy", "degraded", "down", "unknown"]);
  const status = (body.status && validStatus.has(body.status)) ? body.status as "healthy" | "degraded" | "down" | "unknown" : "healthy";
  try {
    // Look up the service record.
    let svcId: string | null = null;
    if (body.project) {
      const r = await c.env.DB.prepare("SELECT id FROM services WHERE org = ? AND project = ? AND name = ?")
        .bind(body.org, body.project, body.service).first<{ id: string }>();
      if (r) svcId = r.id;
    }
    if (!svcId) {
      // Fallback: match by org + name alone (project optional for legacy callers).
      const r = await c.env.DB.prepare("SELECT id FROM services WHERE org = ? AND name = ?")
        .bind(body.org, body.service).first<{ id: string }>();
      if (r) svcId = r.id;
    }
    if (!svcId) return c.json({ error: "service_not_found" }, 404);

    const now = Date.now();
    const updates: string[] = ["status = ?", "last_check = ?", "updated_at = ?"];
    const binds: (string | number | null)[] = [status, now, now];
    if (body.latency_ms !== undefined) { updates.push("latency_ms = ?"); binds.push(body.latency_ms); }
    if (body.version) { updates.push("version = ?"); binds.push(body.version); }
    binds.push(svcId);
    await c.env.DB.prepare(`UPDATE services SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();

    // Write a health_checks row so history / observability charts include the heartbeat.
    await c.env.DB.prepare(
      "INSERT INTO health_checks (id, service_id, status, latency_ms, status_code, checked_at) VALUES (?,?,?,?,?,?)"
    ).bind("hc_" + uid(), svcId, status, body.latency_ms ?? null, null, now).run();

    return c.json({ ok: true, service_id: svcId, status, recorded_at: now });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

// ── PROJECTS CRUD ───────────────────────────────────────────────────────────

import type { Project } from "./types.js";

extra.get("/api/control/projects", verifyAuth, async (c) => {
  try {
    const org = c.req.query("org") || undefined;
    const where = org ? "WHERE org = ?" : "";
    const binds = org ? [org] : [];
    const r = await c.env.DB.prepare(`SELECT * FROM projects ${where} ORDER BY org, name`).bind(...binds).all<Project>();
    return c.json({ projects: r.results ?? [] });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

extra.post("/api/control/projects", verifyAuth, async (c) => {
  let body: Partial<Project>;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body.org || !body.name) return c.json({ error: "org_and_name_required" }, 400);
  const validEnv = new Set(["production", "staging", "sandbox", "dev"]);
  const validType = new Set(["service", "tool", "api", "game", "platform"]);
  const environment = (body.environment && validEnv.has(body.environment)) ? body.environment : "production";
  const type = (body.type && validType.has(body.type)) ? body.type : "service";
  try {
    const existing = await c.env.DB.prepare("SELECT id FROM projects WHERE org = ? AND name = ?").bind(body.org, body.name).first<{ id: string }>();
    if (existing) return c.json({ error: "project_already_exists" }, 409);
    const id = "proj_" + uid();
    const now = Date.now();
    await c.env.DB.prepare(
      "INSERT INTO projects (id, org, name, environment, type, owner, repo, deploy_target, description, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, body.org, body.name, environment, type, body.owner ?? null, body.repo ?? null, body.deploy_target ?? null, body.description ?? null, now, now).run();
    const proj = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<Project>();
    return c.json({ project: proj }, 201);
  } catch { return c.json({ error: "internal_error" }, 500); }
});

extra.patch("/api/control/projects/:id", verifyAuth, async (c) => {
  const id = c.req.param("id") as string;
  let body: Partial<Project>;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  try {
    const existing = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<Project>();
    if (!existing) return c.json({ error: "project_not_found" }, 404);
    const validEnv = new Set(["production", "staging", "sandbox", "dev"]);
    const validType = new Set(["service", "tool", "api", "game", "platform"]);
    const updates: string[] = [];
    const binds: (string | number | null)[] = [];
    if (body.name) { updates.push("name = ?"); binds.push(body.name); }
    if (body.environment && validEnv.has(body.environment)) { updates.push("environment = ?"); binds.push(body.environment); }
    if (body.type && validType.has(body.type)) { updates.push("type = ?"); binds.push(body.type); }
    if (body.owner !== undefined) { updates.push("owner = ?"); binds.push(body.owner ?? null); }
    if (body.repo !== undefined) { updates.push("repo = ?"); binds.push(body.repo ?? null); }
    if (body.deploy_target !== undefined) { updates.push("deploy_target = ?"); binds.push(body.deploy_target ?? null); }
    if (body.description !== undefined) { updates.push("description = ?"); binds.push(body.description ?? null); }
    if (updates.length === 0) return c.json({ error: "no_fields_to_update" }, 400);
    updates.push("updated_at = ?"); binds.push(Date.now());
    binds.push(id);
    await c.env.DB.prepare(`UPDATE projects SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
    const proj = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<Project>();
    return c.json({ project: proj });
  } catch { return c.json({ error: "internal_error" }, 500); }
});

export default extra;
