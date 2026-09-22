# syntax=docker/dockerfile:1.7
# Multi-arch (linux/amd64, linux/arm64). Build from the repo root:
#   docker build -t ghcr.io/pcrausaz/garage-opener-bridge:dev .
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /repo/node_modules /app/node_modules
COPY --from=build --chown=node:node /repo/package.json /app/package.json
COPY --from=build --chown=node:node /repo/dist /app/dist
# Read at runtime by src/http/validation.ts (VALIDATE_RESPONSES) and by the contract tests.
COPY --from=build --chown=node:node /repo/contract /app/contract
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "dist/main.js"]
