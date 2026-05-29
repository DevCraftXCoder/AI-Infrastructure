CREATE TABLE IF NOT EXISTS cost_ledger (
  id TEXT PRIMARY KEY, feature TEXT NOT NULL, model TEXT NOT NULL,
  was_fallback INTEGER DEFAULT 0, input_tokens INTEGER, output_tokens INTEGER,
  cache_status TEXT, latency_ms INTEGER NOT NULL, status_code INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cl_feature ON cost_ledger (feature, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cl_created ON cost_ledger (created_at DESC);
