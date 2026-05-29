CREATE TABLE IF NOT EXISTS safety_log (
  id TEXT PRIMARY KEY, feature TEXT NOT NULL, phase TEXT NOT NULL,
  outcome TEXT NOT NULL, reason TEXT, excerpt TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sl_created ON safety_log (created_at);
CREATE INDEX IF NOT EXISTS idx_sl_feature ON safety_log (feature, created_at DESC);
