# Changelog

All notable changes to `ai-gateway` are documented here.

## [Unreleased]

## [1.0.0] — 2026-06-25

### Added
- OAI-compatible `/v1/chat/completions` endpoint
- OpenRouter → Workers AI fallback provider cascade
- Per-request UUID tracking and cost ledger (D1)
- Safety layer: blocklist + Perspective API soft-flag
- Service registry with 5-minute health sweep cron
- TTL cleanup cron (3 AM UTC)
- Incident management schema (migration 005)
- Session support schema (migration 007)
- CF Rate Limiter binding (60 req/min per token)
- Dashboard and metrics routes
- InfraTab integration components (francois-landing)
