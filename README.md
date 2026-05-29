# AI Infrastructure

OpenAI-compatible LLM gateway and service health control plane on Cloudflare Workers. TypeScript + Hono, zero cold starts.

## Stack

TypeScript · Hono · Cloudflare Workers · D1 · Workers Rate Limiting API · OpenRouter

## Usage

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "X-Feature: my-app" \
  -H "Content-Type: application/json" \
  -d '{ "model": "anthropic/claude-sonnet-4-6", "messages": [{ "role": "user", "content": "Hello" }] }'
```
