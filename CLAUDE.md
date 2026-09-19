# bridge — working notes

Node 22 + TypeScript strict, Fastify 5, zod 4, pino, better-sqlite3, undici. ESM (`.js` import suffixes).

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
pnpm --filter @garage-opener/bridge test          # unit + integration + contract + e2e (≈35 s)
pnpm --filter @garage-opener/bridge typecheck
pnpm --filter @garage-opener/bridge test:live     # read-only against the real console; needs LIVE_DOOR_TESTS=1 (set by the script) and ../.env
BRIDGE_MODE=mock BRIDGE_TOKENS=demo-token-123 WEBHOOK_SECRET=0123456789abcdef pnpm --filter @garage-opener/bridge dev
pnpm --filter @garage-opener/bridge dev           # live mode, reads ../.env via CONFIG/env (source it first: set -a; . ../.env; set +a)
docker build -f bridge/Dockerfile -t garage-opener-bridge:dev .   # from repo root
```

Layout: `src/config.ts` (zod, env→path map) · `src/protect/` (types from fixtures, HTTP client with TLS modes + 8 req/s gate, in-memory simulator) · `src/discovery.ts` · `src/door/` (pure state machine + LiveDoorService) · `src/hold.ts` · `src/alerts/` (rules 1–3, vehicle heuristic, nightly schedule) · `src/lpr/` · `src/notify/` (ntfy, HMAC webhook, Notifier) · `src/instance.ts` (composition) · `src/mock/registry.ts` (per-token mock instances) · `src/http/` (Fastify routes, contract validator, SSE).

Rules: never activate the real relay from tests; fixtures in `test/fixtures/protect/` are the type source of truth; `alarm-manager/synthetic-*.json` are guesses until real payloads are captured. Response validation against the OpenAPI runs when `VALIDATE_RESPONSES=1` (on in tests).
