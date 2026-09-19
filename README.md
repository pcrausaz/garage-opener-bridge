# garage-opener bridge

Self-hosted bridge between the app and a UniFi Protect console: a USL-Relay output in **Pulse** mode presses the
opener button, a garage-mounted all-in-one sensor is the **only** source of door state. Ships as one Docker image
that runs either against a real console (`BRIDGE_MODE=live`) or as an in-memory simulator (`BRIDGE_MODE=mock`,
used by the public App Review bridge and the app's Demo mode).

## Running

```bash
# live (NAS): see deploy/stack/garage-opener/docker-compose.yml
docker run -p 8787:8787 -v garage-data:/data \
  -e PROTECT_URL=https://192.168.50.1 -e PROTECT_API_KEY=… -e PROTECT_TLS=insecure \
  -e BRIDGE_TOKENS=$(openssl rand -hex 24) -e WEBHOOK_SECRET=$(openssl rand -hex 16) \
  -e RELAY_PULSE_MODE=emulated -e RELAY_PULSE_MS=800 \
  -e TZ=America/Chicago ghcr.io/pcrausaz/garage-opener-bridge:latest

# mock (review bridge / local demo)
docker run -p 8787:8787 -e BRIDGE_MODE=mock ghcr.io/pcrausaz/garage-opener-bridge:latest
curl -H 'Authorization: Bearer demo-anything' localhost:8787/v1/state
```

## Configuration

Environment variables (or the same keys nested in `CONFIG_FILE` YAML; env wins):

| Variable | Default | Notes |
|---|---|---|
| `BRIDGE_MODE` | `live` | `live` \| `mock` |
| `PROTECT_URL`, `PROTECT_API_KEY` | — | required in live mode (Protect → Integrations → API key) |
| `PROTECT_TLS` | `insecure` | `insecure` \| `fingerprint:<sha256>` \| `system` |
| `BRIDGE_TOKENS` | — | comma-separated bearer tokens (≥ 8 chars); required in live mode |
| `WEBHOOK_SECRET` | — | ≥ 16 chars; Alarm Manager URL is `…/v1/webhooks/alarm-manager/<secret>` |
| `MOCK_TOKEN_PREFIX` | `demo-` | mock mode also accepts any token with this prefix (isolated state per token, 60 min idle expiry) |
| `DOOR_RELAY_ID`, `DOOR_OUTPUT_ID`, `DOOR_SENSOR_ID` | auto | auto-paired when exactly one pulse output + one garage sensor exist; else required |
| `DOOR_INTERIOR_CAMERA_ID`, `DOOR_DRIVEWAY_CAMERA_ID` | auto | cameras with vehicle smart detection named *Garage* / *Driveway* |
| `DOOR_TRAVEL_SECONDS` / `DOOR_VERIFY_AFTER_SECONDS` | `15` / `3` | verification happens after the sum |
| `RELAY_PULSE_MODE` / `RELAY_PULSE_MS` / `RELAY_RELEASE_MS` | `native` / `500` / `300` | **Use `emulated` for the USL-Relay on Protect 7.2.x**: `activate` toggles the output (on, then off on the next call), so a press is on → wait `RELAY_PULSE_MS` (800 recommended for this hardware) → off, with a release first if the output is already on. `native` = one activate, for hardware whose output really pulses. See ADR-0010. |
| `POLL_MOVING_MS` / `POLL_IDLE_MS` | `2000` / `15000` | sensor polling |
| `ALERT_OPEN_TOO_LONG_MINUTES` | `15` | rule 1 |
| `ALERT_NIGHTLY_TIME` / `ALERT_NIGHTLY_AUTOCLOSE` / `TZ` | `22:00` / `false` / `UTC` | rule 2 |
| `ALERT_VEHICLE_GRACE_SECONDS` / `ALERT_VEHICLE_DOOR_OPEN_MINUTES` | `120` / `5` | rule 3 (camera heuristic) |
| `FEATURES_LPR`, `LPR_KNOWN_PLATES`, `LPR_DEPART_GRACE_MINUTES`, `LPR_UNDO_SECONDS` | `false`, —, `3`, `60` | LPR engine; inert unless enabled (always on in mock with plate `DEMO123`) |
| `NTFY_URL`, `NTFY_TOPIC`, `NTFY_TOKEN` | — | ntfy transport; with `PUBLIC_URL` the notification gets *Close now* / *Hold 2h* buttons |
| `EVENTS_WEBHOOK_URL`, `EVENTS_WEBHOOK_SECRET` | — | outbound events, `X-Garage-Signature: sha256=<HMAC hex of body>` |
| `DATA_DIR` | `./data` | SQLite audit log + state (`bridge.db`) |
| `HOST`, `PORT`, `LOG_LEVEL`, `LOG_PRETTY`, `VALIDATE_RESPONSES` | `0.0.0.0`, `8787`, `info`, `false`, `false` | |

## HTTP API

Spec: `packages/contract/bridge.openapi.yaml` (the server validates bodies with it). Bearer auth on `/v1/*`;
60 req/min per token, door commands 10/min.

| Route | Purpose |
|---|---|
| `GET /healthz` | liveness; `ready:false` + `lastError` (and `ok:false`) while live-mode startup is still retrying (2 s → 60 s backoff); API routes answer 503 `protect_unavailable` until ready |
| `GET /v1/state` | door state machine (`CLOSED OPENING OPEN CLOSING UNKNOWN STUCK`), hold, sensor, relay (record refreshed from the console on every poll; `outputStuck` when the pulse output stays on > max(2 × pulseDuration, 3 s)), vehicle |
| `POST /v1/door/open|close|toggle?wait=true&source=app` | idempotent, single-flight (409 while moving), verified (`ok:false` + `STUCK` if the sensor never confirms); `ok:false` + `error: relay_output_stuck` with no activation while the relay output is stuck on; `wait=false` → 202 |
| `POST /v1/auto-actions/{id}/undo` | reverse an LPR auto-action within its 60 s window (`autoActionId` from the alert); 404 `undo_expired` afterwards |
| `POST /v1/hold {minutes}` / `DELETE /v1/hold` | hold-open suppresses every alert rule |
| `GET /v1/events` | SSE: `state`, `command`, `alert`, `hold`, `vehicle`, `heartbeat` (token via header or `?token=`) |
| `GET /v1/audit?limit&before` | newest-first audit log |
| `GET /v1/discovery` | relays / sensors / cameras + suggested and current mapping |
| `POST|GET /v1/webhooks/alarm-manager/{secret}` | Alarm Manager target; thumbnails discarded; wrong secret → 404 |
| `POST /v1/mock/{vehicle-arrived,vehicle-left,plate-seen,reverse-next-close,reset}` | simulator controls (mock only) |

Outbound event envelope: `{ id, type, at, data }` with `type` ∈ `door.state door.command alert hold vehicle auto-action`.

## Tests

`pnpm test` runs unit (state machine, rules, LPR, HMAC, config, classifier), integration against a fixture-backed
mock Protect server, contract tests (every response validated against the OpenAPI, route list diffed against the
spec), and mock-mode e2e over real HTTP (open→verify, stuck path, SSE, per-token isolation, hold suppression,
signed outbound events). `pnpm test:live` runs read-only checks against the real console and never activates the relay.
