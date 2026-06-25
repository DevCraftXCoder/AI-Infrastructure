# CLAUDE.md — AI Infrastructure

CF Worker `ai-gateway` — OAI-compatible LLM gateway + service health control plane.

## Commands

```bash
npm run dev        # wrangler dev
npm run deploy     # wrangler deploy
npm run typecheck  # tsc --noEmit
npm run lint       # biome check src/
npm run test       # vitest run
```

## Key Facts

- Worker name: `ai-gateway`
- Live: `https://ai-gateway.frxncois.workers.dev`
- D1: `ai-gateway-db` (id `5e69e8ef-3f8d-4ffe-b676-be07fe0dc2a6`)
- Rate limiter: `GATEWAY_RATE_LIMITER` namespace 1 (60 req/min)
- Provider cascade: OpenRouter → Workers AI fallback (`FALLBACK_MODEL`)
- Crons: `*/5 * * * *` (health sweeps), `0 3 * * *` (TTL cleanup)
- Auth: `GATEWAY_KEY` secret — SHA-256 digest + timing-safe compare

## Secrets (set via `wrangler secret put`)

- `GATEWAY_KEY` — bearer token for all `/v1/*` and `/dashboard` routes
- `OPENROUTER_API_KEY` — primary LLM provider
- `PERSPECTIVE_API_KEY` — optional, for safety soft-flag

## Migrations

Apply in order via `wrangler d1 execute ai-gateway-db --remote --file <file>`:

1. `migrations/001-cost-ledger.sql`
2. `migrations/002-safety-log.sql`
3. `migrations/003-service-registry.sql`
4. `migrations/004-*.sql`
5. `migrations/005-incidents-tokens.sql`
6. `migrations/006-*.sql`
7. `migrations/007-sessions.sql`

## Architecture

```
src/index.ts       — Hono app entry, route mounting, cron handler
src/auth.ts        — verifyAuth middleware (GATEWAY_KEY + per-token)
src/providers.ts   — OpenRouter → fallback cascade
src/safety.ts      — blocklist + Perspective API soft-flag
src/registry.ts    — service registry CRUD
src/dashboard.ts   — dashboard + metrics routes
```
