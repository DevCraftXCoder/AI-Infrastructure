# AI Infrastructure

OpenAI-compatible LLM gateway and service health control plane on Cloudflare Workers. TypeScript + Hono, zero cold starts.

## Stack

| Layer | Technology | Details |
|-------|-----------|---------|
| Runtime | Cloudflare Workers | Edge-native, globally distributed, zero cold starts |
| Framework | Hono v4 + TypeScript | Lightweight request routing, CORS, middleware |
| Database | Cloudflare D1 (SQLite) | Cost ledger, safety log, service registry |
| Rate Limiting | Workers Rate Limiting API | 60 req/min per caller (cross-isolate, durable) |
| Primary Provider | OpenRouter | Routes to any model via OpenAI-compatible API |
| Fallback Model | Claude Haiku 4.5 | Automatic failover when primary provider fails |
| Safety — Input | Sync blocklist | Blocks before forwarding; logs to D1 safety_log |
| Safety — Output | Perspective API | Async soft-flag on response content (non-blocking) |
| Prompt Cache | Anthropic cache breakpoints | Auto-injects `cache_control: ephemeral` on system messages >4 KB |
| Cron | 2 triggers | Every 5 min: service health sweeps · 3 AM UTC: TTL purges |
| Telemetry | D1 cost_ledger | Tracks model, tokens, latency, cache hit/miss, fallback flag per request |

### D1 Schema

- **cost_ledger** — per-request log: feature, model, tokens, cache status, latency, status code. 30-day TTL.
- **safety_log** — blocked/flagged content: phase (input/output), reason, excerpt. 30-day TTL.
- **service_registry** — control-plane: orgs → projects → services with live health status, region, last check.

### Control Plane

Dashboard served at `/` with a service health registry organized by org → project → region. The 5-minute cron sweeps all registered service endpoints and updates D1 health status in real time.