# Changelog — Garage Opener bridge

Image: `ghcr.io/pcrausaz/garage-opener-bridge`. The version is reported by `GET /healthz`.

`latest` is the default for self-hosters (ADR-0019). Docker never updates a running container on its own, so
it means "the current release, the next time you pull". Pin an exact `X.Y.Z` if you want upgrades to be a
decision rather than a side effect of pulling, and **do** pin if anything auto-pulls for you.

This project is pre-1.0, so a minor bump may change behaviour. **Read this file before you pull.** Anything
that requires you to touch your configuration is called out under **Action required**, and the bridge refuses
to start with a message that names the fix rather than running in a degraded state.

## 0.5.1 — 2026-09-21

- Fixed: the image did not carry `LICENSE` and `NOTICE`. Apache-2.0 section 4(a) requires the licence to
  travel with a redistribution, and the container image is one. Both are now at `/app/`:
  `docker run --rm --entrypoint cat ghcr.io/pcrausaz/garage-opener-bridge:0.5.1 /app/NOTICE`

## 0.5.0 — 2026-09-21

First release from the public repository.

### Security
Findings from the review carried out before the image was made public
(`docs/security-review.md`). None was remotely exploitable without a credential; all were weak
defaults a self-hoster would have inherited, or ways to exhaust the process.

- **Admin tokens must now be at least 24 characters**, and obvious values (`changeme`, `garage`, …) or
  low-entropy strings are refused at startup. Generate one with `openssl rand -hex 24`.
- **`PROTECT_TLS=insecure` is refused when `PROTECT_URL` is not a LAN address.** On a LAN it remains the
  default; pointed across the internet it would expose your Protect API key to anyone on the path. Use
  `PROTECT_TLS=fingerprint:<sha256>`.
- **Failed authentication is throttled** — 30 per minute per address, after which the answer is `429`. A
  valid token from the same address is never affected, so a household behind one tunnel cannot be locked
  out by an attacker.
- **`/v1/events` streams are capped** at 8 per token and 64 in total (`SSE_MAX_PER_TOKEN`, `SSE_MAX_TOTAL`),
  and a stream torn down by a network error now releases its listeners.
- **`/healthz` is rate limited** (120/min per address); it previously had no limit at all.
- **The activity CSV export neutralises spreadsheet formulas.** A member name or `?source=` value beginning
  `=`, `+`, `-` or `@` was written unescaped and would execute when the owner opened the file in Excel or
  Numbers.

### Added
- **First-run pairing.** While no phone has joined, the bridge prints a single-use invite link at startup, so
  you never copy your `BRIDGE_TOKENS` value into the app. Paste the link — or just the code — into
  Family → Join. Restart for a fresh one; set `PAIRING_BANNER=false` to suppress it.
- **`TRUST_PROXY`** (default off). Set it when a reverse proxy or tunnel you control sits in front and sets
  `X-Forwarded-For`. Without it, every request appears to come from the proxy, which collapsed the per-address
  limits on invite claims (5/min) and the Alarm Manager webhook into one bucket for your whole household.
- A self-hosting reference `docker-compose.yml` and `.env.example` under `bridge/selfhost/`.

### Action required
- If any `BRIDGE_TOKENS` entry is shorter than 24 characters the bridge will not start. Replace it with
  `openssl rand -hex 24` and re-pair. Family member tokens are unaffected.
- If `PROTECT_URL` points at a public hostname with `PROTECT_TLS=insecure`, the bridge will not start.
  Capture the console's fingerprint (`docs/setup/protect-api-key.md`) and use `fingerprint:<sha256>`.

## 0.4.1 — 2026-09-21
- Fixed: a stop part-way desynced the door when the sensor edge lagged the press, so the next press reversed
  into `STUCK`. The direction memory now survives a late edge (#5, ADR-0015).

## 0.4.0 — 2026-09-21
- Added: **stop the door part-way**, and remember which way it was travelling so the next command is the one
  you meant. The tilt sensor reports the same contact for a stopped door as for a fully open one, so the
  direction has to be remembered rather than read (ADR-0015).
- Added: the activity log became usable — filtering by kind, paging, and CSV export at `/v1/audit.csv`.

## 0.3.1 — 2026-09-21
- Fixed: `reset` in mock mode settled the door instead of merely refreshing it.

## 0.3.0 — 2026-09-20
- Changed: the emulated press defaults to 800 ms, and the mock relay now toggles exactly like a real
  USL-Relay on Protect 7.2.x (ADR-0010).
- Added: invite names and member rename, so the Family list and the activity log show people, not devices.

## 0.2.0 — 2026-09-19
- Added: **family invites and member tokens** — another phone joins with a one-time code instead of being
  handed an admin token (ADR-0011). `/v1/invites`, `/v1/invites/{code}/claim`, `/v1/members`.
- Added: Bonjour advertising on `_garage-opener._tcp`, including the bridge URL in the TXT record, so the app
  finds the bridge without anyone typing an address (ADR-0012). Needs host networking under Docker.

## 0.1.2 — 2026-09-19
- Added: state-aware emulated press for relays whose `activate` toggles rather than pulses; the bridge
  detects an output left stuck on and refuses rather than pressing again.

## 0.1.1 — 2026-09-19
- Fixed: certificate pinning failed on resumed TLS sessions, where Node returns an empty peer certificate, so
  every connection after the first failed the check.
- Changed: the bridge listens before it talks to the console and retries startup with backoff, so a console
  that is slow or briefly unreachable no longer takes the port down. `/healthz` reports `ready: false`
  meanwhile.
- Changed: configuration errors name the environment variable that caused them, with secrets redacted.

## 0.1.0 — 2026-09-18
First image: Protect adapter, door state machine on the sensor, verified open/close through the relay, alert
rules, ntfy and HMAC-signed webhooks, licence-plate rules with undo, and a mock mode that drives an in-memory
simulator for App Review.
