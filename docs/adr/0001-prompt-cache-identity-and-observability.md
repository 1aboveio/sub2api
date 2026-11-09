# 0001. Prompt-cache identity and request-id observability

Status: accepted, 2026-11-09.

## Context

Sub2API forwards OpenAI-compatible traffic to ChatGPT/Codex OAuth accounts. Users
report low prompt-cache hit rates, and until now the gateway could not say why:
it recorded neither the session a request belonged to nor any upstream identifier,
so "the upstream declined the write", "the write went somewhere the next request
did not reach" and "the client changed its prefix" all looked the same.

The upstream behaviour that matters (OpenAI prompt-caching guide, GPT-5.6-class
models):

- Cache identity is the request body's `prompt_cache_key`. Session headers are a
  routing hint for account selection, not a cache key.
- `prompt_cache_options.ttl` sets a **minimum** lifetime: `30m` by default, `12h`
  optional at a higher write price. Reads refresh the window; entries may live
  longer than the minimum. The minimum governs cache-read pricing, not a promise
  that a request will reuse stored state.
- Cached state lives on individual machines. Traffic above roughly 15 requests per
  minute can overflow to another machine, and a request only reuses an entry that
  is present on the machine it reaches.
- The minimum cacheable prefix is 1,024 visible input tokens for these models.

## Findings that shaped the decision

1. **Cache identity comes only from the body key.** Repeating the same prefix with
   the same `prompt_cache_key` hits; removing the key always produced
   `cached_tokens = 0`, with no dependence on the `session_id` header. The gateway
   must therefore not invent or rewrite the key.
2. **Caddy silently drops underscore headers.** Caddy up to and including 2.11.4
   discards request headers whose names contain `_` — no option, no log line — so
   the `session_id` that clients such as pi send never reached the application.
   Caddy 2.11.5 added `expected_underscore_headers`; anything reverse-proxying
   those clients needs it, and Cloudflare is not the cause.
3. **The upstream header name was projected away.** `extra.upstream_request_id_header`
   is an account setting, but the scheduler builds a narrow account projection and
   only whitelisted extras survive it, so the configured name was dropped before
   the upstream call was made.
4. **Pure-SSE ChatGPT/Codex responses carry no request-id header.** The `X-Request-Id`
   the gateway returns is generated locally. The only identifier the upstream
   actually yields is the response id (`resp_…`), which also matches what clients
   record as their `responseId`.

## Decision

- Keep cache identity exactly as the client sends it. Do not synthesise, rewrite or
  rotate `prompt_cache_key`, and do not treat the session header as a cache key.
- Preserve configured account extras through the scheduler projection so
  `extra.upstream_request_id_header` survives (see `#7`).
- Record `usage_logs.upstream_request_id` from the configured header when the
  upstream returns one, and fall back to the response id otherwise (see `#8`).
- Do **not** add `prompt_cache_options`, `prompt_cache_retention` or prewarm
  plumbing to the forwarded request. Codex, the reference client for these
  accounts, never sends them (every production call site passes `None` for the TTL,
  and its "prewarm" is a WebSocket connection reuse, not a prompt-cache write), and
  the Codex transform strips them so requests match what Codex sends. Revisit only
  if the upstream is shown to honour an explicit TTL through this path.
- Fork releases use `v<upstream>-patch.N`. The patch number is what a deployment
  pins; the upstream baseline must stay visible in the tag.

## Consequences

- `usage_logs.session_id` and `usage_logs.upstream_request_id` are populated for
  HTTP traffic, so cache questions become measurable per session and per upstream
  response instead of being inferred from aggregates. The
  `idx_usage_logs_upstream_request_id` index now grows.
- WebSocket-mode forwarding still leaves `upstream_request_id` NULL by design; the
  events that would carry an id are not the HTTP response.
- Because the gateway keeps no per-request `prompt_cache_key` or `cached_tokens`
  columns, distinguishing "write rejected" from "written on another machine" still
  needs an additional field. That is a follow-up, not part of this decision.
- Client-side warming remains a client concern: the gateway can keep a cache warm
  only by seeing requests, and warming traffic still lands on whichever machine the
  load balancer picks.
