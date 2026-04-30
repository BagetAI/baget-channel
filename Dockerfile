# Baget × NanoClaw — Railway runtime image.
#
# Two binaries side-by-side:
#   - Node 20 runs the host (src/index.ts → dist/index.js after tsc).
#   - Bun runs the agent runner (container/agent-runner/src/index.ts) per
#     spawned session in single-process mode. The agent runner uses
#     `bun:sqlite` directly, so we can't run it under Node — but the host
#     uses `better-sqlite3` (CommonJS, native bindings), so we can't run
#     it under Bun either. Hence both runtimes in one image.
#
# Build:
#   docker build -t baget-channel:latest .
# Run (Railway sets these env vars from the dashboard):
#   docker run --rm \
#     -e RUNTIME=single-process \
#     -e ANTHROPIC_API_KEY=... \
#     -e TELEGRAM_BOT_TOKEN=... \
#     -e TELEGRAM_WEBHOOK_SECRET=... \
#     -e BAGET_ADMIN_TOKEN=... \
#     -e BAGET_TELEGRAM_BOT_USERNAME=baget_team_bot \
#     -p 3001:3001 -p 8443:8443 \
#     baget-channel:latest

# ── Stage 1: build TS → dist/ ──
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# pnpm + tsc need package files only at first to leverage layer caching.
COPY package.json package-lock.json* ./
COPY tsconfig.json ./
RUN npm install

# Copy sources after deps so a code-only change skips the install layer.
COPY src ./src
COPY container ./container
RUN npm run build

# ── Stage 2: runtime ──
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# Install bun for the agent-runner spawns. Pinned to a known-good
# version — bumping Bun is a deliberate change because the agent-runner's
# bun:sqlite + bun:test usage tends to drift on Bun majors.
ARG BUN_VERSION=1.1.45
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}" \
    && mv /root/.bun/bin/bun /usr/local/bin/bun \
    && apt-get purge -y curl unzip \
    && rm -rf /var/lib/apt/lists/* /root/.bun

# Copy production node_modules + built host code + agent-runner source
# (bun runs the .ts directly — no compile step for the runner).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY container ./container
COPY setup ./setup
COPY package.json ./

# Pre-create groups/ + data/ — first request to provision a Baget
# agent_group needs them present. Made world-writable so the runtime
# user can land new folders.
RUN mkdir -p groups data && chmod 0777 groups data

# Single public port. Railway sets PORT and routes its public ingress
# there. The host listens on PORT (falls back to BAGET_ADMIN_PORT → 8443
# for local Docker runs). The Telegram webhook route is mounted on the
# same listener via registerExtraRoute() — no second port needed.
EXPOSE 8443

# Drop privileges. node:20-bookworm-slim ships a `node` user (uid 1000).
USER node

ENV RUNTIME=single-process
ENV NODE_ENV=production

# Run the host. Migrations run automatically on startup.
CMD ["node", "dist/index.js"]
