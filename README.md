# AI Infrastructure

OpenAI-compatible LLM gateway **and control-plane dashboard** on Cloudflare Workers. Multi-provider routing with automatic fallback, prompt-cache injection, per-caller rate limiting, D1 cost tracking, content safety filtering, plus a service-health control plane (org → project → region) with live health checks. TypeScript + Hono, zero cold starts.

## Features

### LLM Gateway
- **OpenAI-compatible** — drop-in for any OpenAI SDK client (`/v1/chat/completions`)
- **Provider cascade** — OpenRouter primary → configurable fallback model on 5xx
- **Rate limiting** — Cloudflare Workers Rate Limiting API, keyed on bearer token hash
- **Prompt caching** — auto-injects Anthropic cache breakpoints on large system messages
- **Cost ledger** — D1 row per request tracking tokens, latency, cache hit/miss
- **Content safety** — sync blocklist + optional Perspective API toxicity classification
- **Scheduled cleanup** — nightly 30-day TTL purge on safety logs

### Control-Plane Dashboard (served at `/`)
A loginless ops overview of service health across the org. Filter by **org → project → region → status**, free-text search, and three density modes (Comfortable / Compact / Ops Mode).

- **Service registry** — D1-backed registry of every service (worker/api/cron/db/static), grouped org → project → region
- **Live health checks** — 5-min cron pings each public health URL, classifies `healthy`/`degraded`/`down`, records latency history
- **Health summary** — weighted score + grade, status counts, control-plane freshness ("last check N ago")
- **Activity / What Changed** — feed of deploys, status transitions, registrations
- **Service detail drawer** — latency sparkline + recent check history + metadata
- **Deep-linkable filters** — every filter combination is in the URL (`?org=&project=&region=&view=`)
- **CSV/JSON export** of the filtered set, **API Docs** panel, auto-refresh

#### Control-plane API
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/api/control/overview?org=&project=&region=&status=&q=` | — | Filters + dropdown options + filtered services + summary (one shot) |
| GET | `/api/control/orgs` · `/projects?org=` · `/regions?org=&project=` | — | Dropdown sources |
| GET | `/api/control/activity?org=&project=&limit=` | — | Recent activity / What Changed |
| GET | `/api/control/services/:id` | — | Detail + health-check history |
| GET | `/api/control/export?format=csv\|json` | — | Export filtered set |
| GET | `/api/control/docs` | — | Machine-readable endpoint list |
| POST | `/api/control/services` | 🔒 Bearer | Register/update a service `{org,project,region?,name,kind?,url?,version?,status?}` |
| DELETE | `/api/control/services/:id` | 🔒 Bearer | Remove a service |
| POST | `/api/control/health-check` | 🔒 Bearer | Trigger an immediate health sweep |

> **Org/project taxonomy:** `SIC` is a *project*; `sic-billing` is a *service* inside it (it was previously mislabeled as a "SIC Billing" project). Projects under `3Sixty Co.`: DropStream, SIC, Underground, EV Betta, Finos, AI Gateway.

## Stack

TypeScript · Hono · Cloudflare Workers · D1 · Workers Rate Limiting API · OpenRouter

## Setup

**1. Create D1 database**
```bash
wrangler d1 create ai-gateway-db
# paste the database_id into wrangler.toml
```

**2. Apply migrations**
```bash
wrangler d1 execute ai-gateway-db --remote --file migrations/001-cost-ledger.sql
wrangler d1 execute ai-gateway-db --remote --file migrations/002-safety-log.sql
wrangler d1 execute ai-gateway-db --remote --file migrations/003-service-registry.sql
wrangler d1 execute ai-gateway-db --remote --file migrations/004-seed-3sixtyco.sql
```

**3. Set secrets**
```bash
wrangler secret put GATEWAY_KEY        # your API key for clients
wrangler secret put OPENROUTER_API_KEY # from openrouter.ai
wrangler secret put PERSPECTIVE_API_KEY # optional — Google Perspective API
```

**4. Update wrangler.toml** — set `HTTP_REFERER` and `X_TITLE`

**5. Deploy**
```bash
pnpm install && pnpm deploy
```

## Usage

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "X-Feature: my-app" \
  -H "Content-Type: application/json" \
  -d '{ "model": "anthropic/claude-sonnet-4-6", "messages": [{ "role": "user", "content": "Hello" }] }'
```

`X-Feature` is required — used for per-feature cost attribution in the ledger.

Streaming supported: add `"stream": true` to the request body.

## Cost Queries

```sql
SELECT feature, model, COUNT(*) as requests,
       SUM(input_tokens) as total_input, SUM(output_tokens) as total_output,
       AVG(latency_ms) as avg_latency, cache_status
FROM cost_ledger GROUP BY feature, model, cache_status ORDER BY requests DESC;
```
