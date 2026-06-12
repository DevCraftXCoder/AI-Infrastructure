-- Fix sic-mcp seed status from degraded to healthy (local service, no URL to probe)
UPDATE services SET status = 'healthy', updated_at = 1780000001000 WHERE id = 'svc_sic_mcp';
