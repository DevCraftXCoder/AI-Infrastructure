-- Seed the 3Sixty Co. org so the control-plane shows data out of the box.
-- Projects are the real product lines. NOTE: "SIC" is the project; "sic-billing" is a
-- service inside it (previously mislabeled as a "SIC Billing" project).
-- Timestamps use a fixed base (ms); the health-check cron overwrites last_check/status live.
-- Re-runnable: INSERT OR IGNORE keys on the (org, project, region, name) unique index.

-- DropStream
INSERT OR IGNORE INTO services (id, org, project, region, name, kind, url, status, latency_ms, version, last_check, created_at, updated_at) VALUES
  ('svc_ds_pane',    '3Sixty Co.', 'DropStream', 'global', 'drop-pane',          'worker', 'https://drop-pane.frxncois.workers.dev/health',         'healthy',  84,  'v1.4.0', 1780000000000, 1780000000000, 1780000000000),
  ('svc_ds_sandbox', '3Sixty Co.', 'DropStream', 'global', 'drop-pane-sandbox',  'worker', 'https://drop-pane-sandbox.frxncois.workers.dev/health', 'healthy',  91,  'v1.4.0', 1780000000000, 1780000000000, 1780000000000),
  ('svc_ds_sync',    '3Sixty Co.', 'DropStream', 'local',  'dropstream-sync',    'cron',   NULL,                                                     'healthy',  NULL,'v1.0.0', 1780000000000, 1780000000000, 1780000000000);

-- SIC (Security Intelligence Center)
INSERT OR IGNORE INTO services (id, org, project, region, name, kind, url, status, latency_ms, version, last_check, created_at, updated_at) VALUES
  ('svc_sic_server',  '3Sixty Co.', 'SIC', 'local',  'sic-server',  'service', NULL, 'healthy',  NULL, 'v6.0.0', 1780000000000, 1780000000000, 1780000000000),
  ('svc_sic_billing', '3Sixty Co.', 'SIC', 'local',  'sic-billing', 'api',     NULL, 'healthy',  NULL, 'v6.0.0', 1780000000000, 1780000000000, 1780000000000),
  ('svc_sic_mcp',     '3Sixty Co.', 'SIC', 'local',  'sic-mcp',     'service', NULL, 'degraded', NULL, 'v6.0.0', 1780000000000, 1780000000000, 1780000000000);

-- Underground
INSERT OR IGNORE INTO services (id, org, project, region, name, kind, url, status, latency_ms, version, last_check, created_at, updated_at) VALUES
  ('svc_ug_api',      '3Sixty Co.', 'Underground', 'global', 'underground-api',  'worker',  'https://underground-api.frxncois.workers.dev/health', 'healthy', 72,   'v2.1.0', 1780000000000, 1780000000000, 1780000000000),
  ('svc_ug_landing',  '3Sixty Co.', 'Underground', 'global', 'francois-landing', 'worker',  'https://francois-landing.frxncois.workers.dev',       'healthy', 110,  'v2.1.0', 1780000000000, 1780000000000, 1780000000000),
  ('svc_ug_memory',   '3Sixty Co.', 'Underground', 'global', 'memory-mcp',       'worker',  'https://frxncois-memory.frxncois.workers.dev/health', 'healthy', 65,   'v1.2.0', 1780000000000, 1780000000000, 1780000000000),
  ('svc_ug_stats',    '3Sixty Co.', 'Underground', 'local',  'stats-server',     'service', NULL,                                                  'healthy', NULL, 'v1.0.0', 1780000000000, 1780000000000, 1780000000000);

-- EV Betta
INSERT OR IGNORE INTO services (id, org, project, region, name, kind, url, status, latency_ms, version, last_check, created_at, updated_at) VALUES
  ('svc_ev_worker',  '3Sixty Co.', 'EV Betta', 'global', 'ev-betta-worker',  'worker', 'https://ev-betta-worker.frxncois.workers.dev/health', 'healthy', 88,   'v1.8.0', 1780000000000, 1780000000000, 1780000000000),
  ('svc_ev_scraper', '3Sixty Co.', 'EV Betta', 'local',  'ev-betta-scraper', 'cron',   NULL,                                                  'healthy', NULL, 'v1.8.0', 1780000000000, 1780000000000, 1780000000000),
  ('svc_ev_ui',      '3Sixty Co.', 'EV Betta', 'global', 'ev-betta-ui',      'static', NULL,                                                  'healthy', NULL, 'v1.8.0', 1780000000000, 1780000000000, 1780000000000);

-- Finos
INSERT OR IGNORE INTO services (id, org, project, region, name, kind, url, status, latency_ms, version, last_check, created_at, updated_at) VALUES
  ('svc_fn_web', '3Sixty Co.', 'Finos', 'global', 'finos-web', 'worker', 'https://finos-web.frxncois.workers.dev', 'healthy', 134, 'v0.1.0', 1780000000000, 1780000000000, 1780000000000),
  ('svc_fn_api', '3Sixty Co.', 'Finos', 'global', 'finos-api', 'worker', 'https://finos-api.frxncois.workers.dev/health', 'healthy', 79, 'v0.1.0', 1780000000000, 1780000000000, 1780000000000);

-- AI Gateway (this worker — self-registers with its own /health endpoint so the sweep probes it)
INSERT OR IGNORE INTO services (id, org, project, region, name, kind, url, status, latency_ms, version, last_check, created_at, updated_at) VALUES
  ('svc_ai_gateway', '3Sixty Co.', 'AI Gateway', 'global', 'ai-gateway', 'worker', 'https://ai-gateway.frxncois.workers.dev/health', 'healthy', NULL, 'v1.0.0', 1780000000000, 1780000000000, 1780000000000);

-- Seed activity feed
INSERT OR IGNORE INTO activity (id, org, project, service_id, kind, message, detail, created_at) VALUES
  ('act_seed_1', '3Sixty Co.', 'DropStream',  'svc_ds_pane',     'register', 'Registered drop-pane in control-plane',        NULL,                                  1780000000000),
  ('act_seed_2', '3Sixty Co.', 'SIC',         'svc_sic_mcp',     'status_change', 'sic-mcp degraded',                        '{"from":"healthy","to":"degraded"}',  1779996400000),
  ('act_seed_3', '3Sixty Co.', 'Underground', 'svc_ug_api',      'deploy',   'underground-api deployed v2.1.0',              '{"version":"v2.1.0"}',                1779990000000),
  ('act_seed_4', '3Sixty Co.', 'EV Betta',    'svc_ev_worker',   'deploy',   'ev-betta-worker deployed v1.8.0',             '{"version":"v1.8.0"}',                1779986400000),
  ('act_seed_5', '3Sixty Co.', 'AI Gateway',  'svc_ai_gateway',  'register', 'Registered ai-gateway in control-plane',       NULL,                                  1779982800000);
