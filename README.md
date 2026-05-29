# AI Infrastructure

OpenAI-compatible LLM gateway and service health control plane on Cloudflare Workers. TypeScript + Hono, zero cold starts.

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
```

**3. Set secrets**
```bash
wrangler secret put GATEWAY_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put PERSPECTIVE_API_KEY  # optional
```

**4. Update wrangler.toml** — set `HTTP_REFERER` and `X_TITLE`

**5. Deploy**
```bash
npm install && npm run deploy
```

## Usage

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "X-Feature: my-app" \
  -H "Content-Type: application/json" \
  -d '{ "model": "anthropic/claude-sonnet-4-6", "messages": [{ "role": "user", "content": "Hello" }] }'
```
