-- Migration 006: request_id on cost_ledger + is_active flag on service_tokens
-- request_id: correlates a cost_ledger entry with a specific upstream call.
-- is_active:  explicit revocation flag for service tokens (NULL = active, 0 = revoked, 1 = active).

ALTER TABLE cost_ledger ADD COLUMN request_id TEXT;
CREATE INDEX IF NOT EXISTS idx_cl_request_id ON cost_ledger (request_id);

ALTER TABLE service_tokens ADD COLUMN is_active INTEGER DEFAULT 1;
