-- Migration 005: incidents table + service_tokens table
-- Required by dashboard-extra.ts endpoints /api/control/incidents and /api/control/tokens

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  project TEXT,
  title TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'P2' CHECK(severity IN ('P0','P1','P2','P3')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','identified','in_progress','resolved')),
  affected_users INTEGER,
  sla_breached INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incidents_org ON incidents(org);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at DESC);

CREATE TABLE IF NOT EXISTS service_tokens (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'read',
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tokens_org ON service_tokens(org);
CREATE INDEX IF NOT EXISTS idx_tokens_created ON service_tokens(created_at DESC);
