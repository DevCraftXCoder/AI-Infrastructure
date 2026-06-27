-- Backfill correct environment values and seed the projects table.
-- Only drop-pane-sandbox is a true sandbox; everything else is production.
UPDATE services SET environment = 'sandbox' WHERE id = 'svc_ds_sandbox';

-- Seed projects table with 3Sixty Co. real project metadata.
INSERT OR IGNORE INTO projects (id, org, name, environment, type, owner, repo, deploy_target, description, created_at, updated_at) VALUES
  ('proj_dropstream', '3Sixty Co.', 'DropStream',  'production', 'platform', 'DevCraftXCoder', 'turdpusher360/drop_stream',      'cloudflare-workers', 'PaneDrop — real-time pane aggregator on CF Workers',                              1780000000000, 1780000000000),
  ('proj_sic',        '3Sixty Co.', 'SIC',         'production', 'tool',     'DevCraftXCoder', 'DevCraftXCoder/SIC',              'local',              'AI pentesting MCP framework — 85 security tools, 12+ agents',                    1780000000000, 1780000000000),
  ('proj_underground','3Sixty Co.', 'Underground',  'production', 'platform', 'DevCraftXCoder', 'DevCraftXCoder/Underground-Social','cloudflare-workers', 'Edge-native social music platform for underground artists',                      1780000000000, 1780000000000),
  ('proj_ev_betta',   '3Sixty Co.', 'EV Betta',    'production', 'tool',     'DevCraftXCoder', 'DevCraftXCoder/EV-Betta',         'cloudflare-workers', 'Sports picks EV calculator — CF Workers + D1 + PM2 scraper',                   1780000000000, 1780000000000),
  ('proj_finos',      '3Sixty Co.', 'Finos',       'production', 'platform', 'DevCraftXCoder', NULL,                              'cloudflare-workers', 'AI Financial OS — web + desktop app (pnpm monorepo)',                            1780000000000, 1780000000000),
  ('proj_ai_gateway', '3Sixty Co.', 'AI Gateway',  'production', 'api',      'DevCraftXCoder', 'DevCraftXCoder/AI-Infrastructure','cloudflare-workers', 'OAI-compatible LLM gateway + service health control plane',                     1780000000000, 1780000000000);
