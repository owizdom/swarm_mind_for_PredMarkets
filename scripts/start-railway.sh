#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
#  Swarm Mind — Container Entrypoint (Railway / Docker)
#
#  Runs the coordinator + 3 prediction agents in a single container.
#  Uses the local `claude` CLI subprocess as the LLM, authenticated via
#  CLAUDE_CODE_OAUTH_TOKEN (long-lived OAuth token from `claude setup-token`).
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── 1. Onboarding stub for the claude CLI ─────────────────────────────────
# Without this, claude tries to run the interactive theme/onboarding flow
# on first launch even when CLAUDE_CODE_OAUTH_TOKEN is set.
# (Anthropic GitHub issue #8938)
mkdir -p "$HOME/.claude"
if [ ! -f "$HOME/.claude.json" ]; then
  echo '{"hasCompletedOnboarding": true}' > "$HOME/.claude.json"
  chmod 600 "$HOME/.claude.json"
fi

# ── 2. Sanity-check the OAuth token is present ────────────────────────────
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo ""
  echo "  ╔══════════════════════════════════════════════════════════════╗"
  echo "  ║  WARNING: CLAUDE_CODE_OAUTH_TOKEN is not set.                ║"
  echo "  ║                                                              ║"
  echo "  ║  Generate one locally with:  claude setup-token              ║"
  echo "  ║  Then set it as a Railway env var.                           ║"
  echo "  ║                                                              ║"
  echo "  ║  Without it, all LLM calls will fail and agents will use     ║"
  echo "  ║  the deterministic fallback (market-price-derived answer).   ║"
  echo "  ╚══════════════════════════════════════════════════════════════╝"
  echo ""
fi

# ── 3. SQLite data dir ────────────────────────────────────────────────────
DB_DIR="${DB_DIR:-/data}"
mkdir -p "$DB_DIR"

# ── 4. Ports ──────────────────────────────────────────────────────────────
# Railway sets $PORT for the public-facing service. Internal agent ports
# stay fixed (3001-3003) and are not exposed publicly.
DASHBOARD_PORT="${PORT:-${DASHBOARD_PORT:-3000}}"
AGENT_BASE_PORT=3001
P1=$AGENT_BASE_PORT
P2=$((AGENT_BASE_PORT + 1))
P3=$((AGENT_BASE_PORT + 2))

# ── 5. Environment defaults ───────────────────────────────────────────────
export NODE_ENV="${NODE_ENV:-production}"
export LLM_PROVIDER="${LLM_PROVIDER:-claude-cli}"
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-sonnet}"
# Slower cycle cadence for long-running deploys: ~25 cycles/hour instead of ~45.
# Each cycle still does ~4 LLM calls so this gives Max 20x's 5h window plenty of headroom.
export EXPLORE_STEPS="${EXPLORE_STEPS:-30}"
export SYNC_INTERVAL_MS="${SYNC_INTERVAL_MS:-2500}"
# Per-agent token budget reset every cycle (see agent.ts:resetForNewCycle).
# This is a safety ceiling per cycle, not cumulative.
export TOKEN_BUDGET_PER_AGENT="${TOKEN_BUDGET_PER_AGENT:-200000}"

# ── 6. Process management ─────────────────────────────────────────────────
pids=()
cleanup() {
  echo "[start] shutting down…"
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

start_agent() {
  local index=$1 port=$2 name=$3 peers=$4
  echo "[start] $name on :$port"
  AGENT_INDEX="$index" \
  AGENT_PORT="$port" \
  DB_PATH="$DB_DIR/swarm-${name,,}.db" \
  PEER_URLS="$peers" \
  COORDINATOR_URL="http://127.0.0.1:$DASHBOARD_PORT" \
    node dist/agents/runner.js &
  pids+=("$!")
}

# ── 7. Coordinator first (must be up so agents can poll it) ───────────────
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║   SWARM MIND  ·  Polymarket Prediction Oracle                    ║"
echo "║   Nakamoto · Szabo · Finney  ·  commit-reveal · Ed25519          ║"
echo "║   LLM: claude CLI (OAuth via CLAUDE_CODE_OAUTH_TOKEN)            ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
echo "[start] coordinator on :$DASHBOARD_PORT"
AGENT_URLS="http://127.0.0.1:$P1,http://127.0.0.1:$P2,http://127.0.0.1:$P3" \
DASHBOARD_PORT="$DASHBOARD_PORT" \
PORT="$DASHBOARD_PORT" \
  node dist/dashboard/server-multi.js &
pids+=("$!")

sleep 2

# ── 8. Three agents, each pointing at the others ──────────────────────────
start_agent 0 "$P1" "Nakamoto" "http://127.0.0.1:$P2,http://127.0.0.1:$P3"
sleep 1
start_agent 1 "$P2" "Szabo"    "http://127.0.0.1:$P1,http://127.0.0.1:$P3"
sleep 1
start_agent 2 "$P3" "Finney"   "http://127.0.0.1:$P1,http://127.0.0.1:$P2"

echo ""
echo "[start] all processes up. dashboard listening on :$DASHBOARD_PORT"
echo ""

# ── 9. Wait — exit on first child failure ─────────────────────────────────
wait -n
echo "[start] one process exited — shutting down the rest"
cleanup
exit $?
