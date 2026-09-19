# Protect Integration API fixtures

Captured live on 2026-09-18 from a UDM-SE running **Protect 7.2.105** at
`https://192.168.50.1/proxy/protect/integration/v1` with `X-API-KEY`.
Redacted fields: `mac`, `guid`, `hosts`, `host`. Device ids and names are real.

| File | Endpoint | Notes |
|---|---|---|
| meta_info.json | GET /meta/info | `{"applicationVersion":"7.2.105"}` |
| sensors.json | GET /sensors | one UFP-SENSE, `mountType: "garage"`, has `openStatusChangedAt` (epoch ms) |
| sensor_by_id.json | GET /sensors/{id} | same shape as list element |
| relays.json | GET /relays | USL-Relay-US; `outputs[].id` is a **number** (0, 1); pulse output has `type: "garageDoor"`, `pulseDuration: 100` |
| relay_by_id.json | GET /relays/{id} | same shape |
| cameras.json | GET /cameras | full list; `smartDetectSettings.objectTypes` includes `vehicle` |
| cameras_garage_driveway.json | filtered | interior "Garage (G4 Instant)" + "Driveway (G5 Dome)" |
| nvrs.json | GET /nvrs | UDM-PRO-SE |
| chimes.json | GET /chimes | unused |

Observed but not fixtures:
- Response header `ratelimit-policy: "10-in-1sec"` — the console enforces 10 requests/second per key.
- `GET /subscribe/events` and `/subscribe/devices` → 404 on 7.2.105 (no WebSocket feed on this build).
- `/openapi.json`, `/docs`, `/swagger.json` → 404.
- `POST /relays/{id}/outputs/{outputId}/activate` has **not** been exercised (would move the real door);
  its response shape is unknown and treated as opaque by the client until captured with `LIVE_DOOR_TESTS=1`.
- Alarm Manager webhook payloads are not yet captured; `alarm-manager/` will hold them once real events fire.
