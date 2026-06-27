-- Add environment classification to services (production | staging | sandbox | dev).
-- Existing rows default to 'production' which is correct for all currently seeded services;
-- migration 010 corrects the sandbox service.
ALTER TABLE services ADD COLUMN environment TEXT NOT NULL DEFAULT 'production';

-- Projects metadata table: org-level grouping with classification, ownership, and deploy target.
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  org          TEXT NOT NULL,
  name         TEXT NOT NULL,
  environment  TEXT NOT NULL DEFAULT 'production',  -- production | staging | sandbox | dev
  type         TEXT NOT NULL DEFAULT 'service',     -- service | tool | api | game | platform
  owner        TEXT,
  repo         TEXT,
  deploy_target TEXT,                               -- cloudflare-workers | local | docker | pm2
  description  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proj_unique ON projects (org, name);
CREATE INDEX IF NOT EXISTS idx_proj_org ON projects (org);
