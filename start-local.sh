#!/bin/bash
# ── Swarm Mind Prediction Oracle — Local Multi-Process Launch ──
# Coordinator + 3 independent prediction agents + dashboard.
# Uses local `claude` CLI as the LLM (no API key required).

set -e
cd "$(dirname "$0")"

# Load base env from .env
export $(grep -v '^#' .env | xargs) 2>/dev/null || true

# Force claude-cli LLM (overridable from .env)
export LLM_PROVIDER=${LLM_PROVIDER:-claude-cli}
export ANTHROPIC_MODEL=${ANTHROPIC_MODEL:-sonnet}

echo "╔═══════════════════════════════════════════════════════╗"
echo "║   SWARM MIND  ·  Polymarket Prediction Oracle          ║"
echo "║   Nakamoto · Szabo · Finney  ·  commit-reveal · Ed25519 ║"
echo "║   LLM: claude CLI (Claude Code OAuth, no API key)      ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

# ── Build ─────────────────────────────────────────────
echo "[1/5] Building TypeScript..."
npx tsc 2>&1 | tail -10
if [ ! -f dist/agents/runner.js ]; then
  echo "  ✗ build failed — dist/agents/runner.js missing"
  exit 1
fi
echo "  ✓ build ok"

# ── Coordinator / Dashboard ───────────────────────────
echo "[2/5] Starting Coordinator + Dashboard on :3000..."
AGENT_URLS=http://localhost:3001,http://localhost:3002,http://localhost:3003 \
DASHBOARD_PORT=3000 \
LLM_PROVIDER=$LLM_PROVIDER \
ANTHROPIC_MODEL=$ANTHROPIC_MODEL \
node dist/dashboard/server-multi.js 2>&1 | sed 's/^/\x1b[32m[Coord]   \x1b[0m/' &
DASH_PID=$!

sleep 2

# ── Agent Nakamoto (Technical) ────────────────────────
echo "[3/5] Starting Agent Nakamoto (Technical) on :3001..."
AGENT_INDEX=0 \
AGENT_PORT=3001 \
DB_PATH=./swarm-nakamoto.db \
PEER_URLS=http://localhost:3002,http://localhost:3003 \
COORDINATOR_URL=http://localhost:3000 \
LLM_PROVIDER=$LLM_PROVIDER \
ANTHROPIC_MODEL=$ANTHROPIC_MODEL \
node dist/agents/runner.js 2>&1 | sed 's/^/\x1b[36m[Nakamoto]\x1b[0m /' &
NAKAMOTO_PID=$!

sleep 1

# ── Agent Szabo (Macro) ───────────────────────────────
echo "[4/5] Starting Agent Szabo (Macro) on :3002..."
AGENT_INDEX=1 \
AGENT_PORT=3002 \
DB_PATH=./swarm-szabo.db \
PEER_URLS=http://localhost:3001,http://localhost:3003 \
COORDINATOR_URL=http://localhost:3000 \
LLM_PROVIDER=$LLM_PROVIDER \
ANTHROPIC_MODEL=$ANTHROPIC_MODEL \
node dist/agents/runner.js 2>&1 | sed 's/^/\x1b[35m[Szabo]   \x1b[0m/' &
SZABO_PID=$!

sleep 1

# ── Agent Finney (On-chain) ───────────────────────────
echo "[5/5] Starting Agent Finney (On-chain) on :3003..."
AGENT_INDEX=2 \
AGENT_PORT=3003 \
DB_PATH=./swarm-finney.db \
PEER_URLS=http://localhost:3001,http://localhost:3002 \
COORDINATOR_URL=http://localhost:3000 \
LLM_PROVIDER=$LLM_PROVIDER \
ANTHROPIC_MODEL=$ANTHROPIC_MODEL \
node dist/agents/runner.js 2>&1 | sed 's/^/\x1b[33m[Finney]  \x1b[0m/' &
FINNEY_PID=$!

sleep 2

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Dashboard       →  http://localhost:3000"
echo "  Coordinator API →  http://localhost:3000/api/coordinator"
echo "  Oracle API      →  http://localhost:3000/api/oracle"
echo "  Nakamoto        →  http://localhost:3001/oracle"
echo "  Szabo           →  http://localhost:3002/oracle"
echo "  Finney          →  http://localhost:3003/oracle"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Press Ctrl+C to stop everything."

# Cleanup on exit
trap "echo 'Shutting down...'; kill $NAKAMOTO_PID $SZABO_PID $FINNEY_PID $DASH_PID 2>/dev/null; exit 0" INT TERM

wait
