import type { Env, Service, ServiceStatus, ActivityRow } from "./types.js";

const DEGRADED_MS = 800;          // latency above this = degraded
const CHECK_TIMEOUT_MS = 5000;
const ALL = "__all__";

function uid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

/** A url is auto-pingable only if it's a public http(s) endpoint (edge can't reach localhost). */
function pingable(url: string | null): url is string {
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return !/(localhost|127\.0\.0\.1|\[::1\])/i.test(url);
}

// ---- reads -------------------------------------------------------------

export async function listOrgs(env: Env): Promise<string[]> {
  const r = await env.DB.prepare("SELECT DISTINCT org FROM services ORDER BY org").all<{ org: string }>();
  return (r.results ?? []).map(x => x.org);
}

export async function listProjects(env: Env, org: string): Promise<string[]> {
  const r = await env.DB.prepare("SELECT DISTINCT project FROM services WHERE org = ? ORDER BY project")
    .bind(org).all<{ project: string }>();
  return (r.results ?? []).map(x => x.project);
}

export async function listRegions(env: Env, org: string, project: string): Promise<string[]> {
  let sql = "SELECT DISTINCT region FROM services WHERE org = ?";
  const binds: string[] = [org];
  if (project && project !== ALL) { sql += " AND project = ?"; binds.push(project); }
  sql += " ORDER BY region";
  const r = await env.DB.prepare(sql).bind(...binds).all<{ region: string }>();
  return (r.results ?? []).map(x => x.region);
}

export interface Filter { org?: string; project?: string; region?: string; status?: string; q?: string }

export async function listServices(env: Env, f: Filter): Promise<Service[]> {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (f.org && f.org !== ALL) { where.push("org = ?"); binds.push(f.org); }
  if (f.project && f.project !== ALL) { where.push("project = ?"); binds.push(f.project); }
  if (f.region && f.region !== ALL) { where.push("region = ?"); binds.push(f.region); }
  if (f.status && f.status !== ALL) { where.push("status = ?"); binds.push(f.status); }
  if (f.q) { where.push("(name LIKE ? OR project LIKE ? OR kind LIKE ?)"); const like = `%${f.q}%`; binds.push(like, like, like); }
  const sql = `SELECT * FROM services ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY project, name LIMIT 2000`;
  const r = await env.DB.prepare(sql).bind(...binds).all<Service>();
  return r.results ?? [];
}

export interface Summary {
  total: number; healthy: number; degraded: number; down: number; unknown: number;
  score: number; freshest: number | null; stalest: number | null;
}

export function summarize(services: Service[]): Summary {
  const s: Summary = { total: services.length, healthy: 0, degraded: 0, down: 0, unknown: 0, score: 0, freshest: null, stalest: null };
  for (const svc of services) {
    if (svc.status === "healthy") s.healthy++;
    else if (svc.status === "degraded") s.degraded++;
    else if (svc.status === "down") s.down++;
    else s.unknown++;
    if (svc.last_check != null) {
      s.freshest = s.freshest == null ? svc.last_check : Math.max(s.freshest, svc.last_check);
      s.stalest = s.stalest == null ? svc.last_check : Math.min(s.stalest, svc.last_check);
    }
  }
  // weighted: healthy=1, degraded=0.5, down/unknown=0
  s.score = s.total === 0 ? 0 : Math.round(((s.healthy + s.degraded * 0.5) / s.total) * 100);
  return s;
}

export async function listActivity(env: Env, f: Filter, limit = 20): Promise<ActivityRow[]> {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (f.org && f.org !== ALL) { where.push("org = ?"); binds.push(f.org); }
  if (f.project && f.project !== ALL) { where.push("project = ?"); binds.push(f.project); }
  const sql = `SELECT * FROM activity ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
  binds.push(Math.min(Math.max(limit, 1), 100));
  const r = await env.DB.prepare(sql).bind(...binds).all<ActivityRow>();
  return r.results ?? [];
}

export async function getService(env: Env, id: string): Promise<Service | null> {
  return env.DB.prepare("SELECT * FROM services WHERE id = ?").bind(id).first<Service>();
}

export interface HealthCheckRow { id: string; service_id: string; status: string; latency_ms: number | null; status_code: number | null; checked_at: number }

export async function recentChecks(env: Env, serviceId: string, limit = 30): Promise<HealthCheckRow[]> {
  const r = await env.DB.prepare("SELECT * FROM health_checks WHERE service_id = ? ORDER BY checked_at DESC LIMIT ?")
    .bind(serviceId, Math.min(Math.max(limit, 1), 100)).all<HealthCheckRow>();
  return r.results ?? [];
}

// ---- writes ------------------------------------------------------------

export interface UpsertInput {
  org: string; project: string; region?: string; name: string;
  kind?: string; url?: string | null; version?: string | null; status?: ServiceStatus;
}

export async function upsertService(env: Env, i: UpsertInput): Promise<Service> {
  const now = Date.now();
  const region = i.region ?? "global";
  const existing = await env.DB.prepare("SELECT * FROM services WHERE org = ? AND project = ? AND region = ? AND name = ?")
    .bind(i.org, i.project, region, i.name).first<Service>();

  if (existing) {
    await env.DB.prepare(
      "UPDATE services SET kind = ?, url = ?, version = ?, status = ?, updated_at = ? WHERE id = ?"
    ).bind(i.kind ?? existing.kind, i.url ?? existing.url, i.version ?? existing.version, i.status ?? existing.status, now, existing.id).run();
    return (await getService(env, existing.id))!;
  }

  const id = "svc_" + uid();
  await env.DB.prepare(
    "INSERT INTO services (id, org, project, region, name, kind, url, status, latency_ms, version, last_check, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(id, i.org, i.project, region, i.name, i.kind ?? "worker", i.url ?? null, i.status ?? "unknown", null, i.version ?? null, null, now, now).run();
  await logActivity(env, { org: i.org, project: i.project, service_id: id, kind: "register", message: `Registered ${i.name} in control-plane` });
  return (await getService(env, id))!;
}

export async function deleteService(env: Env, id: string): Promise<boolean> {
  const svc = await getService(env, id);
  if (!svc) return false;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM health_checks WHERE service_id = ?").bind(id),
    env.DB.prepare("DELETE FROM services WHERE id = ?").bind(id),
  ]);
  await logActivity(env, { org: svc.org, project: svc.project, service_id: id, kind: "config", message: `Removed ${svc.name} from control-plane` });
  return true;
}

export interface ActivityInput { org: string; project?: string | null; service_id?: string | null; kind: string; message: string; detail?: string | null }

export async function logActivity(env: Env, a: ActivityInput): Promise<void> {
  try {
    await env.DB.prepare("INSERT INTO activity (id, org, project, service_id, kind, message, detail, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind("act_" + uid(), a.org, a.project ?? null, a.service_id ?? null, a.kind, a.message, a.detail ?? null, Date.now()).run();
  } catch { /* activity logging is non-critical */ }
}

// ---- health-check engine ----------------------------------------------

function classify(statusCode: number | null, latency: number, ok: boolean): ServiceStatus {
  if (!ok || statusCode == null) return "down";
  if (statusCode >= 500) return "down";
  if (statusCode >= 400 && statusCode < 500) return "degraded"; // 4xx = misconfigured endpoint (degraded, not down — avoids mass Discord alerts on URL changes)
  if (latency > DEGRADED_MS) return "degraded";
  return "healthy";
}

async function pingOne(env: Env, svc: Service, ctx: ExecutionContext): Promise<void> {
  const t0 = Date.now();
  let statusCode: number | null = null;
  let ok = false;
  try {
    const resp = await fetch(svc.url as string, { method: "GET", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    statusCode = resp.status;
    ok = true;
  } catch { ok = false; }
  const latency = Date.now() - t0;
  const next = classify(statusCode, latency, ok);
  const now = Date.now();

  if (next !== svc.status) {
    await logActivity(env, {
      org: svc.org, project: svc.project, service_id: svc.id, kind: "status_change",
      message: `${svc.name} ${svc.status} → ${next}`, detail: JSON.stringify({ from: svc.status, to: next }),
    });
    // Discord alert: only fire on transitions INTO down or degraded (not out of them).
    // Wrapped in ctx.waitUntil so it survives even if the health sweep completes quickly.
    if ((next === "down" || next === "degraded") && env.DISCORD_WEBHOOK_URL) {
      const emoji = next === "down" ? "🔴" : "🟡";
      ctx.waitUntil(
        fetch(env.DISCORD_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            embeds: [{
              title: `${emoji} ${svc.name} is ${next}`,
              description: `**${svc.org} / ${svc.project}** — ${svc.region}\nPrevious: **${svc.status}** → Now: **${next}**${ok ? `\nLatency: ${latency}ms  Status code: ${statusCode}` : "\nFailed to connect"}`,
              color: next === "down" ? 0xe94560 : 0xd29922,
              timestamp: new Date(now).toISOString(),
            }],
          }),
          signal: AbortSignal.timeout(4000),
        }).catch(() => {})
      );
    }
  }

  await env.DB.batch([
    env.DB.prepare("UPDATE services SET status = ?, latency_ms = ?, last_check = ?, updated_at = ? WHERE id = ?")
      .bind(next, ok ? latency : null, now, now, svc.id),
    env.DB.prepare("INSERT INTO health_checks (id, service_id, status, latency_ms, status_code, checked_at) VALUES (?,?,?,?,?,?)")
      .bind("hc_" + uid(), svc.id, next, ok ? latency : null, statusCode, now),
  ]);
}

/** Compute uptime % from last N health_checks rows (0-100). */
export async function uptimePercent(env: Env, serviceId: string, windowSize = 100): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) as up FROM (SELECT status FROM health_checks WHERE service_id = ? ORDER BY checked_at DESC LIMIT ?)"
  ).bind(serviceId, windowSize).first<{ total: number; up: number }>();
  if (!r || r.total === 0) return 100;
  return Math.round((r.up / r.total) * 100);
}

/** Manually set status for services the cron can't reach (local/no-url). */
export async function updateServiceStatus(env: Env, id: string, status: ServiceStatus): Promise<Service | null> {
  const svc = await getService(env, id);
  if (!svc) return null;
  const now = Date.now();
  await env.DB.prepare("UPDATE services SET status = ?, last_check = ?, updated_at = ? WHERE id = ?").bind(status, now, now, id).run();
  if (status !== svc.status) {
    await logActivity(env, {
      org: svc.org, project: svc.project, service_id: id, kind: "status_change",
      message: `${svc.name} manually set ${svc.status} → ${status}`, detail: JSON.stringify({ from: svc.status, to: status, manual: true }),
    });
  }
  return getService(env, id);
}

/** Ingest an external event (deploy, config change) into the activity feed. Bearer-gated. */
export async function ingestEvent(env: Env, input: { org: string; project?: string | null; service?: string | null; kind: string; message: string; detail?: string | null }): Promise<void> {
  let serviceId: string | null = null;
  if (input.service && input.org && input.project) {
    const r = await env.DB.prepare("SELECT id FROM services WHERE org = ? AND project = ? AND name = ?")
      .bind(input.org, input.project, input.service).first<{ id: string }>();
    if (r) { serviceId = r.id; }
  }
  // Auto-update service version on deploy events that include a version in detail JSON.
  if (input.kind === "deploy" && serviceId && input.detail) {
    try {
      const det = JSON.parse(input.detail) as { version?: string };
      if (det.version) {
        await env.DB.prepare("UPDATE services SET version = ?, updated_at = ? WHERE id = ?")
          .bind(det.version, Date.now(), serviceId).run();
      }
    } catch { /* ignore malformed detail */ }
  }
  await logActivity(env, { org: input.org, project: input.project ?? null, service_id: serviceId, kind: input.kind, message: input.message, detail: input.detail ?? null });
}

/** Pings every service with a public health URL. Returns how many were checked.
 *  `ctx` is optional — pass it from the scheduled handler so Discord alerts are
 *  wrapped in waitUntil. The manual /api/control/health-check route omits it. */
export async function runHealthChecks(env: Env, ctx?: ExecutionContext): Promise<number> {
  const r = await env.DB.prepare("SELECT * FROM services WHERE url IS NOT NULL").all<Service>();
  const targets = (r.results ?? []).filter(s => pingable(s.url));
  // Build a no-op ctx shim when called without an ExecutionContext (manual HTTP trigger).
  const safeCtx = ctx ?? { waitUntil: (p: Promise<unknown>) => { p.catch(() => {}); }, passThroughOnException: () => {} } as unknown as ExecutionContext;
  await Promise.allSettled(targets.map(s => pingOne(env, s, safeCtx)));
  return targets.length;
}
