# ── Build stage ─────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

# Build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY agents/ ./agents/
COPY dashboard/ ./dashboard/
RUN npm run build

# ── Runtime stage ───────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app

# bash + jq for the entrypoint stub; ca-certificates for HTTPS to Polymarket;
# install the claude CLI globally so the agents' subprocess wrapper can spawn it.
RUN apt-get update && apt-get install -y --no-install-recommends bash jq ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g @anthropic-ai/claude-code && \
    claude --version

COPY --from=builder /app/dist          ./dist
COPY --from=builder /app/node_modules  ./node_modules
COPY --from=builder /app/package.json  ./package.json
COPY dashboard/index.html              ./dashboard/index.html
COPY dashboard/architecture.png        ./dashboard/architecture.png
COPY scripts/start-railway.sh          ./scripts/start-railway.sh
RUN chmod +x ./scripts/start-railway.sh

# Ephemeral SQLite + onboarding stub. Railway disallows the VOLUME directive
# (https://docs.railway.com/reference/volumes) — the start script just mkdirs /data.
RUN mkdir -p /data

# Railway sets $PORT; the script reads it. Locally defaults to 3000.
ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

CMD ["./scripts/start-railway.sh"]
