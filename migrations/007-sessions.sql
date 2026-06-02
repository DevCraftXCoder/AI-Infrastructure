-- Migration 007: real session lifecycle store
-- Replaces the stateless "session_expires_at = now+8h" fiction in dashboard-extra.ts
-- with persisted, idle-enforced, auditable sessions keyed by caller_hash
-- (SHA-256 hex of the bearer credential — the same identity verifyAuth derives).

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  caller_hash TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'unknown',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,                       -- absolute hard expiry
  last_seen INTEGER NOT NULL,                         -- bumped on each authenticated poll
  idle_timeout_ms INTEGER NOT NULL DEFAULT 1800000,  -- 30 min inactivity window
  extend_count INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_caller ON sessions(caller_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
