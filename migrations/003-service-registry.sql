-- Control-plane service registry: orgs > projects > services, with health + activity.
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  project TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'global',
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'worker',        -- worker | api | cron | db | static | service
  url TEXT,                                    -- health endpoint (pinged by cron)
  status TEXT NOT NULL DEFAULT 'unknown',      -- healthy | degraded | down | unknown
  latency_ms INTEGER,
  version TEXT,
  last_check INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_svc_filter ON services (org, project, region);
CREATE INDEX IF NOT EXISTS idx_svc_status ON services (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_svc_unique ON services (org, project, region, name);

-- Recent activity + "What Changed" feed (single table, discriminated by kind).
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  project TEXT,
  service_id TEXT,
  kind TEXT NOT NULL,                          -- deploy | status_change | register | check | config
  message TEXT NOT NULL,
  detail TEXT,                                 -- optional JSON (e.g. {"from":"healthy","to":"down"})
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_act_org ON activity (org, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_act_created ON activity (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_act_service ON activity (service_id, created_at DESC);

-- Health-check history (latency sparkline + uptime in Ops Mode / detail drawer).
CREATE TABLE IF NOT EXISTS health_checks (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  status_code INTEGER,
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hc_service ON health_checks (service_id, checked_at DESC);
