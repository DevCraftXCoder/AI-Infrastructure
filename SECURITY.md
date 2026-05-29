# Security

## Reporting

To report a security vulnerability, open a GitHub issue marked **[SECURITY]** or email directly.

## Design

- Bearer tokens are compared via SHA-256 + `timingSafeEqual` — no timing side-channels
- Rate limit key is server-derived from the token hash — callers cannot spoof budget by rotating headers
- `GATEWAY_KEY` is never logged or exposed in responses
- Content safety runs on every request — blocklist sync, Perspective API async
- D1 safety log has a 30-day TTL enforced nightly by a scheduled Worker
