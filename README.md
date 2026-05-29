# AI Infrastructure

OpenAI-compatible LLM gateway on Cloudflare Workers. Multi-provider routing with automatic fallback, prompt-cache injection, per-caller rate limiting, D1 cost tracking, and content safety filtering. TypeScript + Hono, zero cold starts.

## Features

- **OpenAI-compatible** — drop-in for any OpenAI SDK client (`/v1/chat/completions`)
- **Provider cascade** — OpenRouter primary → configurable fallback model on 5xx
- **Rate limiting** — Cloudflare Workers Rate Limiting API, keyed on bearer token hash
- **Prompt caching** — auto-injects Anthropic cache breakpoints on large system messages
- **Cost ledger** — D1 row per request tracking tokens, latency, cache hit/miss
- **Content safety** — sync blocklist + optional Perspective API toxicity classification
- **Scheduled cleanup** — nightly 30-day TTL purge on safety logs

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
