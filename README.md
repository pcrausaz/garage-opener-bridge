# Garage Opener bridge

The service behind [**Garage Opener**](https://garageopener.app), a smart garage door built on a UniFi
Protect relay and a garage-mounted door sensor. It talks to your Protect console, keeps the door state
machine, serves the iOS app, and runs the alert rules whether or not a phone is awake.

**Every command is verified against the door sensor.** The relay is fired, then the sensor is read: *open*
means the door is open, not that a relay clicked. When the door doesn't do what it was asked, the API says so
rather than reporting success.

```
ghcr.io/pcrausaz/garage-opener-bridge
```

Node 22, TypeScript strict, Fastify, SQLite. Multi-arch (amd64, arm64).

## Running it

Start at **https://garageopener.app/self-hosting** — the full guide, including the Protect API key, the relay
and sensor setup, certificates and remote access. The short version:

```bash
cp selfhost/.env.example .env    # fill in the five values at the top
docker compose -f selfhost/docker-compose.yml up -d
curl -s localhost:8787/healthz
```

You do **not** put an admin token into the app. While no phone has joined, the bridge prints a single-use
invite link at startup; paste that into the app's Family → Join.

## What it does

| | |
|---|---|
| Door | State machine on the sensor, verified open/close/stop, direction memory for a door stopped part-way |
| Alerts | Open too long, nightly check, vehicle-in-garage heuristic, hold-open to silence them |
| Family | One-time invites, per-member tokens, rename and revoke, an activity log that names people |
| Integrations | Bonjour discovery, Alarm Manager webhooks in, ntfy and HMAC-signed webhooks out, SSE event stream |
| Mock mode | An in-memory simulator with no console and no credentials, per-token isolated |

The HTTP API is `contract/bridge.openapi.yaml`. A test diffs it against the routes the server actually
registers, so the spec cannot quietly fall behind the implementation.

## Development

```bash
pnpm install
pnpm test          # OpenAPI lint + generated-types drift check + unit, integration, contract and e2e suites
pnpm typecheck
BRIDGE_MODE=mock BRIDGE_TOKENS=demo-token-123 pnpm dev    # mock mode on :8787
```

`pnpm test:live` runs read-only checks against a real console and is opt-in; it is never run in CI. No test
touches real hardware.

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Changes to the API mean editing the spec and running
`pnpm contract:generate`.

## Security

A review was carried out before this repository was published:
[`docs/security-review.md`](docs/security-review.md). It is published in full, including what was accepted
rather than fixed. Reporting: [`SECURITY.md`](SECURITY.md).

Two things matter most if you run this: **generate `BRIDGE_TOKENS`** (it opens your garage door), and **don't
port-forward the bridge** — use a VPN, tunnel or reverse proxy.

## What isn't here

The **iOS and watchOS app** is closed source. The **cloud-alerts service** is too: it holds no credential to
anyone's console, cannot actuate anything, and nobody can self-host it, since pushes need the app's APNs key.
What it stores is set out at https://garageopener.app/privacy.

Out of scope by design: more than one door per bridge, relays other than UniFi Protect's, Home Assistant.

## Licence

[Apache-2.0](LICENSE). Please read [`NOTICE`](NOTICE): the code is free to fork and redistribute, the name
**Garage Opener**, the icon and `garageopener.app` are not.

"UniFi" and "UniFi Protect" are trademarks of Ubiquiti Inc. This project is not affiliated with, endorsed by
or sponsored by Ubiquiti.
