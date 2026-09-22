# garage-opener-bridge — working notes

Node 22 + TypeScript strict, Fastify 5, zod 4, pino, better-sqlite3, undici. ESM (`.js` import suffixes).

**This is the public repository** (Apache-2.0). The iOS app and the cloud-alerts Worker live in a separate
private repo and are not published; don't reference them as if a reader can see them.

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm test            # OpenAPI lint + generated-types drift check + unit/integration/contract/e2e (≈35 s)
pnpm typecheck
pnpm test:live       # read-only against a real console; needs LIVE_DOOR_TESTS=1 (set by the script) and .env
BRIDGE_MODE=mock BRIDGE_TOKENS=demo-token-123 WEBHOOK_SECRET=0123456789abcdef pnpm dev
pnpm dev             # live mode; source .env first: set -a; . ./.env; set +a
docker build -t garage-opener-bridge:dev .
```

The OpenAPI spec is `contract/bridge.openapi.yaml`; `src/contract.ts` is generated from it and checked in.
Edit the spec, run `pnpm contract:generate`, commit both — `pnpm test` fails if they have drifted.

Layout: `contract/bridge.openapi.yaml` (the API, checked by a test against the live route list) · `src/config.ts` (zod, env→path map) · `src/protect/` (types from fixtures, HTTP client with TLS modes + 8 req/s gate, in-memory simulator) · `src/discovery.ts` · `src/door/` (pure state machine + LiveDoorService) · `src/hold.ts` · `src/alerts/` (rules 1–3, vehicle heuristic, nightly schedule) · `src/lpr/` · `src/notify/` (ntfy, HMAC webhook, Notifier) · `src/members.ts` (admin/member tokens, invites) · `src/bonjour.ts` (`_garage-opener._tcp`) · `src/instance.ts` (composition, startWithRetry) · `src/mock/registry.ts` (per-token mock instances) · `src/http/` (Fastify routes, contract validator, SSE).

Rules: never activate the real relay from tests; fixtures in `test/fixtures/protect/` are the type source of truth (captured from a real console; device ids in them are opaque LAN object ids, not secrets); `alarm-manager/synthetic-*.json` are guesses until real payloads are captured. Response validation against the OpenAPI runs when `VALIDATE_RESPONSES=1` (on in tests).
