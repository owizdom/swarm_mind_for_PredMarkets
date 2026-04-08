/**
 * Dashboard Server — Multi-Agent Mode
 *
 * Reads state from each independent agent HTTP API.
 * No shared database. No central coordinator.
 * If an agent is down, the rest keep working.
 */

import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fetchInterestingQuestions, fetchQuestionById } from "../agents/markets";
import { initThinker, generateOracleConsensus } from "../agents/thinker";
import { callClaudeCLI } from "../agents/llm-claude-cli";
import type { PolymarketQuestion, AgentPrediction, OracleConsensus, LLMConfig } from "../agents/types";

const AGENT_URLS      = (process.env.AGENT_URLS || "http://127.0.0.1:3001,http://127.0.0.1:3002,http://127.0.0.1:3003").split(",").filter(Boolean);
// Railway sets $PORT for the public service. Locally we use DASHBOARD_PORT.
const DASHBOARD_PORT  = parseInt(process.env.PORT || process.env.DASHBOARD_PORT || "3000");
const EXPLORE_STEPS   = parseInt(process.env.EXPLORE_STEPS   || "18");
const STEP_INTERVAL   = parseInt(process.env.SYNC_INTERVAL_MS || "2000");

// ── Cost tracking ──────────────────────────────────────────────────────────
let totalCostUsd = 0;
let totalCalls = 0;
export function trackCost(usd: number): void {
  totalCostUsd += usd;
  totalCalls++;
}

// ── Cycle history ──────────────────────────────────────────────────────────
interface HistoryEntry {
  cycleNumber: number;
  cycleId: string;
  question: PolymarketQuestion;
  consensus: OracleConsensus;
  marketImpliedYes: number;
  generatedAt: number;
}
const cycleHistory: HistoryEntry[] = [];
function appendCycleHistory(consensus: OracleConsensus): void {
  if (!coordinator.currentQuestion) return;
  cycleHistory.unshift({
    cycleNumber: coordinator.cycleNumber,
    cycleId: coordinator.cycleId,
    question: coordinator.currentQuestion,
    consensus,
    marketImpliedYes: coordinator.currentQuestion.yesPrice,
    generatedAt: Date.now(),
  });
  if (cycleHistory.length > 30) cycleHistory.pop();
}

// Initialize thinker for synthesis calls (uses claude CLI subprocess)
const llmProvider = (process.env.LLM_PROVIDER || "claude-cli") as LLMConfig["provider"];
try {
  initThinker({
    provider: llmProvider,
    apiUrl: process.env.OPENAI_API_URL || "",
    apiKey: process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || "",
    model: process.env.ANTHROPIC_MODEL || process.env.OPENAI_MODEL || "sonnet",
  });
} catch (err) {
  console.warn(`[COORDINATOR] thinker init failed: ${err instanceof Error ? err.message : String(err)}`);
}

// Pre-warm the LLM so the first synthesis call is not a cold start (~10-15s saved)
console.log("[COORDINATOR] warming claude CLI…");
callClaudeCLI(
  "You output JSON only.",
  'Respond ONLY: {"warm":true}',
  { maxBudgetUsd: 0.5, timeoutMs: 30_000 }
)
  .then((r) => { trackCost(r.costUsd); console.log(`[COORDINATOR] LLM warmed ($${r.costUsd.toFixed(4)})`); })
  .catch((err) => console.warn(`[COORDINATOR] LLM warm-up failed: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`));

// ── Coordinator State Machine ──────────────────────────────────────────────
// Manages objective, coordinator-driven cycle phases instead of each agent
// locally detecting density thresholds. All agents poll /api/coordinator and
// react to phase changes. This makes phase boundaries objectively verifiable.

type CoordPhase = "explore" | "commit" | "reveal" | "synthesis";

interface CommitEntry {
  agentId: string;
  agentName: string;
  kzgHash: string;
  eigenDABatchId: string | null;
  eigenDAReferenceBlock: number | null;
  sealedBlobHash: string;
  submittedAt: number;
  committedViaEigenDA: boolean;
  windowMissed: boolean;
  prediction: AgentPrediction | null;
}

interface SlashEvent {
  agentId: string;
  agentName: string;
  fault: "missed_commit" | "missed_reveal" | "hash_mismatch";
  cycleId: string;
  detectedAt: number;
}

interface CoordinatorState {
  cycleId: string;
  cycleNumber: number;
  phase: CoordPhase;
  phaseStartedAt: number;
  cycleStartedAt: number;
  commitWindowCloseBlock: number | null; // Ethereum block estimate when commit window closed
  commitRegistry: Map<string, CommitEntry>;
  slashEvents: SlashEvent[];
  lastSynthesisReport: unknown | null;
  expectedAgentCount: number;
  currentQuestion: PolymarketQuestion | null;
  consensus: OracleConsensus | null;
  synthesisFired: boolean;
  consensusReadyAt: number | null;       // when consensus was first set — used to time the display
  synthesisInFlight: boolean;
}

// Phase durations (wall-clock ms) — min-time + completion semantics
//   EXPLORE: full window (no early exit) — agents need uninterrupted thinking time
//   COMMIT:  closes early when all 3 commits land, otherwise after COMMIT_MS_MAX
//   REVEAL:  full window (gossip)
//   SYNTHESIS: stays until consensus is computed AND has been displayed for CONSENSUS_DISPLAY_MS
const EXPLORE_MS         = EXPLORE_STEPS * STEP_INTERVAL;
const COMMIT_MS_MAX      = 30 * STEP_INTERVAL;      // up to 60s for slow agents (was 8s)
const REVEAL_MS          = 16 * STEP_INTERVAL;
const SYNTHESIS_MS_MAX   = 30 * STEP_INTERVAL;      // up to 60s for the LLM call (was 16s)
const CONSENSUS_DISPLAY_MS = 14 * STEP_INTERVAL;    // 28s for the audience to read the answer

function newCycleState(cycleNumber: number, carryQuestion: PolymarketQuestion | null = null): CoordinatorState {
  return {
    cycleId: crypto.randomUUID(),
    cycleNumber,
    phase: "explore",
    phaseStartedAt: Date.now(),
    cycleStartedAt: Date.now(),
    commitWindowCloseBlock: null,
    commitRegistry: new Map(),
    slashEvents: [],
    lastSynthesisReport: null,
    expectedAgentCount: AGENT_URLS.length,
    currentQuestion: carryQuestion,
    consensus: null,
    synthesisFired: false,
    consensusReadyAt: null,
    synthesisInFlight: false,
  };
}

let coordinator: CoordinatorState = newCycleState(1);

// ── Polymarket question selection ──────────────────────────────────────────

let questionPickInFlight = false;
let manualQuestionOverride: PolymarketQuestion | null = null;
const usedQuestionIds = new Set<string>();   // session-wide history of questions we've already shown

async function pickQuestionForCycle(): Promise<PolymarketQuestion | null> {
  if (manualQuestionOverride) {
    const q = manualQuestionOverride;
    manualQuestionOverride = null;
    usedQuestionIds.add(q.id);
    console.log(`[COORDINATOR] Using manually-set question: ${q.question.slice(0, 80)}`);
    return q;
  }
  try {
    const candidates = await fetchInterestingQuestions(20);
    if (candidates.length === 0) return null;

    // Filter out questions we've already used this session
    const fresh = candidates.filter(c => !usedQuestionIds.has(c.id));

    let pool = fresh.length > 0 ? fresh : candidates; // recycle if we've exhausted fresh ones

    // Sort by uncertainty (closest to 0.50 first) so we always have interesting answers
    pool = [...pool].sort((a, b) => Math.abs(0.5 - a.yesPrice) - Math.abs(0.5 - b.yesPrice));

    // From the top-half (most uncertain), pick one at random for variety
    const topHalf = pool.slice(0, Math.max(3, Math.ceil(pool.length / 2)));
    const picked = topHalf[Math.floor(Math.random() * topHalf.length)];

    if (fresh.length === 0) {
      console.log(`[COORDINATOR] All ${candidates.length} fresh candidates used — recycling`);
      usedQuestionIds.clear();
    }
    usedQuestionIds.add(picked.id);
    return picked;
  } catch (err) {
    console.warn(`[COORDINATOR] failed to fetch Polymarket questions: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function ensureCycleHasQuestion(): Promise<void> {
  if (coordinator.currentQuestion || questionPickInFlight) return;
  questionPickInFlight = true;
  try {
    const q = await pickQuestionForCycle();
    if (q) {
      coordinator.currentQuestion = q;
      console.log(`[COORDINATOR] Cycle ${coordinator.cycleNumber} question: "${q.question}" (YES=${(q.yesPrice*100).toFixed(0)}%, vol24h=$${Math.round(q.volume24hr).toLocaleString()})`);
    }
  } finally {
    questionPickInFlight = false;
  }
}

async function runSynthesis(): Promise<void> {
  if (coordinator.synthesisFired) return;
  if (!coordinator.currentQuestion) {
    console.warn(`[COORDINATOR] Cannot synthesize — no active question`);
    return;
  }
  const predictions: AgentPrediction[] = [];
  const proofs: Record<string, string> = {};
  for (const c of coordinator.commitRegistry.values()) {
    if (c.prediction) {
      predictions.push({ ...c.prediction, commitmentHash: c.kzgHash });
      proofs[c.agentId] = c.kzgHash;
    }
  }
  if (predictions.length === 0) {
    console.warn(`[COORDINATOR] Cannot synthesize — no predictions in commit registry`);
    coordinator.synthesisFired = true;
    coordinator.consensusReadyAt = Date.now(); // unblock advance
    return;
  }

  coordinator.synthesisFired = true;
  coordinator.synthesisInFlight = true;
  console.log(`\n${"█".repeat(60)}`);
  console.log(`█  [COORDINATOR] SYNTHESIS — cycle ${coordinator.cycleNumber}`);
  console.log(`█  Question: ${coordinator.currentQuestion.question.slice(0, 70)}`);
  console.log(`█  Predictions: ${predictions.length} (${predictions.map(p => `${p.agentName}=${p.answer}`).join(", ")})`);
  console.log(`${"█".repeat(60)}\n`);

  try {
    const { consensus } = await generateOracleConsensus(
      predictions,
      coordinator.currentQuestion,
      coordinator.cycleId,
      proofs
    );
    coordinator.consensus = consensus;
    coordinator.lastSynthesisReport = consensus;
    coordinator.consensusReadyAt = Date.now();
    appendCycleHistory(consensus);
    console.log(`\n${"█".repeat(60)}`);
    console.log(`█  ORACLE CONSENSUS: ${consensus.answer} @ ${(consensus.confidence*100).toFixed(0)}% (${consensus.agreementLevel})`);
    console.log(`█  ${consensus.narrative.slice(0, 200)}`);
    console.log(`${"█".repeat(60)}\n`);
  } catch (err) {
    console.error(`[COORDINATOR] synthesis error: ${err instanceof Error ? err.message : String(err)}`);
    coordinator.consensusReadyAt = Date.now(); // unblock advance even on error
  } finally {
    coordinator.synthesisInFlight = false;
  }
}

function advanceCycle(): void {
  const now = Date.now();
  const elapsed = now - coordinator.phaseStartedAt;

  switch (coordinator.phase) {
    case "explore":
      // Make sure a Polymarket question is loaded for this cycle
      if (!coordinator.currentQuestion) {
        ensureCycleHasQuestion().catch(() => {});
      }
      // Full window — agents need uninterrupted thinking time
      if (elapsed >= EXPLORE_MS) {
        coordinator.phase = "commit";
        coordinator.phaseStartedAt = now;
        console.log(`[COORDINATOR] Cycle ${coordinator.cycleNumber} → COMMIT (max ${COMMIT_MS_MAX}ms, advances early on full registry)`);
      }
      break;

    case "commit":
      // Advance early once all expected agents have committed; otherwise wait up to COMMIT_MS_MAX
      if (coordinator.commitRegistry.size >= coordinator.expectedAgentCount || elapsed >= COMMIT_MS_MAX) {
        coordinator.commitWindowCloseBlock = Math.floor(now / 12_000);
        coordinator.phase = "reveal";
        coordinator.phaseStartedAt = now;
        const cause = coordinator.commitRegistry.size >= coordinator.expectedAgentCount ? "all committed" : "timeout";
        console.log(`[COORDINATOR] Cycle ${coordinator.cycleNumber} → REVEAL (${coordinator.commitRegistry.size}/${coordinator.expectedAgentCount} commits, ${cause})`);
      }
      break;

    case "reveal":
      if (elapsed >= REVEAL_MS) {
        coordinator.phase = "synthesis";
        coordinator.phaseStartedAt = now;
        console.log(`[COORDINATOR] Cycle ${coordinator.cycleNumber} → SYNTHESIS`);
        // Fire synthesis exactly once when entering this phase
        runSynthesis().catch((err) => console.error("[COORDINATOR] synthesis crash:", err));
      }
      break;

    case "synthesis": {
      // Two gates:
      //  1) Hard timeout — synthesis must complete in SYNTHESIS_MS_MAX or we move on
      //  2) Display delay — once consensus is ready, hold for CONSENSUS_DISPLAY_MS so the audience can read it
      const consensusReady = coordinator.consensusReadyAt !== null;
      const displayElapsed = consensusReady ? (now - (coordinator.consensusReadyAt as number)) : 0;
      const hardTimeout = elapsed >= SYNTHESIS_MS_MAX;
      const displayDone = consensusReady && displayElapsed >= CONSENSUS_DISPLAY_MS;

      if (hardTimeout || displayDone) {
        const next = coordinator.cycleNumber + 1;
        const reason = hardTimeout && !consensusReady ? "synthesis timeout" : "display window done";
        console.log(`[COORDINATOR] Cycle ${coordinator.cycleNumber} complete (${reason}) → starting Cycle ${next} (EXPLORE)`);
        coordinator = newCycleState(next);
        ensureCycleHasQuestion().catch(() => {});
      }
      break;
    }
  }
}

// Advance cycle phase every second
setInterval(advanceCycle, 1000);
// Pre-load the first question on boot so the very first cycle isn't empty
ensureCycleHasQuestion().catch(() => {});

const app = express();
app.use(cors());
app.use(express.json());

// Serve dashboard HTML
let dashboardDir = path.join(__dirname, "..", "..", "dashboard");
if (!fs.existsSync(path.join(dashboardDir, "index.html"))) {
  dashboardDir = path.join(__dirname, "..", "dashboard");
}
app.use(express.static(dashboardDir));

// ── Aggregate helpers ──

async function fetchAgent(url: string, endpoint: string): Promise<unknown> {
  try {
    const res = await fetch(`${url}${endpoint}`, { signal: AbortSignal.timeout(3000) });
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchAllAgents(endpoint: string): Promise<unknown[]> {
  const results = await Promise.allSettled(AGENT_URLS.map(u => fetchAgent(u, endpoint)));
  return results.map(r => r.status === "fulfilled" ? r.value : null).filter(Boolean);
}

// ── Coordinator API ────────────────────────────────────────────────────────

// GET /api/coordinator — agents poll this every step for current phase
app.get("/api/coordinator", (_req, res) => {
  const now = Date.now();
  const elapsed = now - coordinator.phaseStartedAt;
  let windowRemainingMs = 0;
  switch (coordinator.phase) {
    case "explore":   windowRemainingMs = Math.max(0, EXPLORE_MS - elapsed);       break;
    case "commit":    windowRemainingMs = Math.max(0, COMMIT_MS_MAX - elapsed);    break;
    case "reveal":    windowRemainingMs = Math.max(0, REVEAL_MS - elapsed);        break;
    case "synthesis": windowRemainingMs = Math.max(0, SYNTHESIS_MS_MAX - elapsed); break;
  }
  res.json({
    cycleId:            coordinator.cycleId,
    cycleNumber:        coordinator.cycleNumber,
    phase:              coordinator.phase,
    phaseStartedAt:     coordinator.phaseStartedAt,
    windowRemainingMs,
    commitCount:        coordinator.commitRegistry.size,
    expectedAgentCount: coordinator.expectedAgentCount,
    slashEventCount:    coordinator.slashEvents.length,
    currentQuestion:    coordinator.currentQuestion,
    commits: [...coordinator.commitRegistry.values()].map(c => ({
      agentId:              c.agentId,
      agentName:            c.agentName,
      kzgHash:              c.kzgHash.slice(0, 32) + "…",
      eigenDABatchId:       c.eigenDABatchId,
      eigenDAReferenceBlock: c.eigenDAReferenceBlock,
      committedViaEigenDA:  c.committedViaEigenDA,
      submittedAt:          c.submittedAt,
    })),
  });
});

// GET /api/oracle — full oracle state for the current cycle
app.get("/api/oracle", (_req, res) => {
  const predictions: AgentPrediction[] = [];
  for (const c of coordinator.commitRegistry.values()) {
    if (c.prediction) predictions.push({ ...c.prediction, commitmentHash: c.kzgHash });
  }
  const now = Date.now();
  const elapsed = now - coordinator.phaseStartedAt;
  let phaseWindowMs = EXPLORE_MS;
  switch (coordinator.phase) {
    case "explore":   phaseWindowMs = EXPLORE_MS; break;
    case "commit":    phaseWindowMs = COMMIT_MS_MAX; break;
    case "reveal":    phaseWindowMs = REVEAL_MS; break;
    case "synthesis": phaseWindowMs = SYNTHESIS_MS_MAX; break;
  }
  res.json({
    cycleId:        coordinator.cycleId,
    cycleNumber:    coordinator.cycleNumber,
    phase:          coordinator.phase,
    phaseElapsedMs: elapsed,
    phaseWindowMs,
    phaseRemainingMs: Math.max(0, phaseWindowMs - elapsed),
    question:       coordinator.currentQuestion,
    perAgentPredictions: predictions,
    consensus:      coordinator.consensus,
    consensusReadyAt: coordinator.consensusReadyAt,
    synthesisInFlight: coordinator.synthesisInFlight,
    expectedAgents: coordinator.expectedAgentCount,
    receivedAgents: predictions.length,
  });
});

// GET /api/history — past cycle consensus answers (newest first, max 30)
app.get("/api/history", (_req, res) => {
  const stats = {
    total: cycleHistory.length,
    disagreedWithMarket: 0,
    unanimous: 0,
    majority: 0,
    split: 0,
  };
  for (const h of cycleHistory) {
    if (h.consensus.agreementLevel === "unanimous") stats.unanimous++;
    if (h.consensus.agreementLevel === "majority") stats.majority++;
    if (h.consensus.agreementLevel === "split") stats.split++;
    const ourYes = h.consensus.answer === "YES";
    const marketYes = h.marketImpliedYes >= 0.5;
    if (ourYes !== marketYes) stats.disagreedWithMarket++;
  }
  res.json({ stats, entries: cycleHistory });
});

// GET /api/cost — cumulative LLM spend (coordinator + all agents) across the demo session
app.get("/api/cost", async (_req, res) => {
  const agentCosts = await fetchAllAgents("/cost") as Array<{ totalCostUsd?: number; totalCalls?: number } | null>;
  let agentTotal = 0;
  let agentCalls = 0;
  for (const c of agentCosts) {
    if (c) {
      agentTotal += c.totalCostUsd || 0;
      agentCalls += c.totalCalls || 0;
    }
  }
  const grandTotal = totalCostUsd + agentTotal;
  const grandCalls = totalCalls + agentCalls;
  res.json({
    totalCostUsd: grandTotal,
    totalCalls: grandCalls,
    coordinator: { totalCostUsd, totalCalls },
    agents: { totalCostUsd: agentTotal, totalCalls: agentCalls },
    avgCostPerCall: grandCalls > 0 ? grandTotal / grandCalls : 0,
  });
});

// POST /api/coordinator/question — manually override the question for next cycle
app.post("/api/coordinator/question", async (req, res) => {
  const { id, question } = req.body as { id?: string; question?: PolymarketQuestion };
  if (question && question.id && question.question) {
    manualQuestionOverride = question;
    res.json({ ok: true, willUseAtNextCycle: true, question });
    return;
  }
  if (id) {
    const q = await fetchQuestionById(id);
    if (!q) { res.status(404).json({ error: "question not found" }); return; }
    manualQuestionOverride = q;
    res.json({ ok: true, willUseAtNextCycle: true, question: q });
    return;
  }
  res.status(400).json({ error: "provide either { id } or { question }" });
});

// POST /api/coordinator/commit — agents register their commitment during commit window
app.post("/api/coordinator/commit", (req, res) => {
  const body = req.body as Partial<CommitEntry> & {
    agentId?: string;
    agentName?: string;
    kzgHash?: string;
    prediction?: AgentPrediction | null;
  };
  if (!body?.agentId || !body?.kzgHash) {
    res.status(400).json({ error: "agentId and kzgHash are required" });
    return;
  }

  if (coordinator.phase !== "commit") {
    const slash: SlashEvent = {
      agentId:   body.agentId,
      agentName: body.agentName ?? body.agentId,
      fault:     "missed_commit",
      cycleId:   coordinator.cycleId,
      detectedAt: Date.now(),
    };
    coordinator.slashEvents.push(slash);
    console.warn(`[COORDINATOR] SLASH: ${body.agentName} committed outside window (phase=${coordinator.phase})`);
    res.status(409).json({
      error:  "commit_window_closed",
      phase:  coordinator.phase,
      cycleId: coordinator.cycleId,
      fault:  "missed_commit",
    });
    return;
  }

  const entry: CommitEntry = {
    agentId:              body.agentId,
    agentName:            body.agentName ?? body.agentId,
    kzgHash:              body.kzgHash,
    eigenDABatchId:       body.eigenDABatchId ?? null,
    eigenDAReferenceBlock: body.eigenDAReferenceBlock ?? null,
    sealedBlobHash:       body.sealedBlobHash ?? "",
    submittedAt:          Date.now(),
    committedViaEigenDA:  body.committedViaEigenDA ?? false,
    windowMissed:         false,
    prediction:           body.prediction ?? null,
  };

  coordinator.commitRegistry.set(body.agentId, entry);
  const predTag = entry.prediction ? ` [${entry.prediction.answer} ${(entry.prediction.confidence*100).toFixed(0)}%]` : "";
  console.log(`[COORDINATOR] Commit registered: ${entry.agentName}${predTag} → ${entry.kzgHash.slice(0, 20)}… (${coordinator.commitRegistry.size}/${coordinator.expectedAgentCount})`);

  res.json({
    ok:                true,
    cycleId:           coordinator.cycleId,
    position:          coordinator.commitRegistry.size,
    allCommitted:      coordinator.commitRegistry.size >= coordinator.expectedAgentCount,
  });
});

// GET /api/evidence — machine-verifiable evidence bundle for current/last cycle
app.get("/api/evidence", (_req, res) => {
  const commits = [...coordinator.commitRegistry.values()];
  const proxyUrl = process.env.EIGENDA_PROXY_URL || null;

  const commitmentRecords = commits.map(c => ({
    agentId:              c.agentId,
    agentName:            c.agentName,
    kzgHash:              c.kzgHash,
    eigenDABatchId:       c.eigenDABatchId,
    eigenDAReferenceBlock: c.eigenDAReferenceBlock,
    submittedAt:          c.submittedAt,
    committedViaEigenDA:  c.committedViaEigenDA,
    sealedBlobHash:       c.sealedBlobHash,
  }));

  const integrityChecks = commits.map(c => ({
    agentId:                 c.agentId,
    agentName:               c.agentName,
    committedSealedBlobHash: c.sealedBlobHash,
    verificationUrl:         proxyUrl && c.committedViaEigenDA
      ? `${proxyUrl}/get/${c.kzgHash.replace("eigenda:", "")}`
      : null,
    passed: null, // verifier must fetch blob from EigenDA and check sha256(blob) === sealedBlobHash
  }));

  const revealWindowBlock = coordinator.commitWindowCloseBlock;
  const independenceChecks = commits.map(c => {
    const ref = c.eigenDAReferenceBlock;
    const close = revealWindowBlock;
    return {
      agentId:                c.agentId,
      agentName:              c.agentName,
      eigenDAReferenceBlock:  ref,
      commitWindowCloseBlock: close,
      // Block when blob was sealed must be before the reveal window opened
      independentBeforeReveal: (ref !== null && close !== null) ? ref < close : null,
    };
  });

  const allIndependentBeforeReveal = independenceChecks.every(c => c.independentBeforeReveal !== false)
    ? (independenceChecks.some(c => c.independentBeforeReveal === true) ? true : null)
    : false;

  const bundle = {
    cycleId:       coordinator.cycleId,
    cycleNumber:   coordinator.cycleNumber,
    generatedAt:   Date.now(),
    commitments:   commitmentRecords,
    integrityChecks,
    independenceChecks,
    allCommitted:  commits.length >= coordinator.expectedAgentCount,
    allIndependentBeforeReveal,
    synthesis:     coordinator.lastSynthesisReport,
    slashEvents:   coordinator.slashEvents,
    verifierInstructions: [
      "1. For each commitment with committedViaEigenDA=true:",
      "   GET {verificationUrl} → deserialize blob → sha256(blob) should equal committedSealedBlobHash",
      "2. Each blob.findings[].contentHash should match sha256(reveal-phase pheromone.content)",
      "   (pheromones with preCommitRef set are reveal-phase; those without are explore-phase)",
      "3. independenceChecks: eigenDAReferenceBlock < commitWindowCloseBlock proves blob was",
      "   sealed before the reveal window opened — agent could not have copied peers",
      "4. For sha256-only commits (EigenDA unavailable): verify independently by re-running",
      "   the agent with the same inputs (determinism not guaranteed; treat as best-effort)",
    ].join("\n"),
  };

  res.json(bundle);
});

// POST /api/coordinator/synthesis — agent notifies coordinator it generated synthesis
app.post("/api/coordinator/synthesis", (req, res) => {
  const { report } = req.body as { report?: unknown };
  if (report && coordinator.phase === "synthesis") {
    coordinator.lastSynthesisReport = report;
  }
  res.json({ ok: true });
});

// ── API endpoints ──

app.get("/api/agents", async (_req, res) => {
  const states = await fetchAllAgents("/state") as Array<Record<string, unknown>>;
  // Strip large arrays — dashboard uses pre-computed counts from runner.ts /state
  const reshaped = states.filter(Boolean).map((s) => {
    const { thoughts, decisions, knowledge, personality, currentDecision, ...rest } = s;
    void thoughts; void decisions; void knowledge; void personality; void currentDecision;
    return rest;
  });
  res.json(reshaped);
});

app.get("/api/identities", async (_req, res) => {
  const ids = await fetchAllAgents("/identity");
  res.json(ids);
});

app.get("/api/state", async (_req, res) => {
  const states = await fetchAllAgents("/state") as Array<Record<string, unknown>> | null;
  if (!states || states.length === 0) { res.json({}); return; }

  const validStates = states.filter(Boolean) as Array<Record<string, unknown>>;
  const step             = Math.max(...validStates.map(s => (s.step as number) || 0));
  const totalTokens      = validStates.reduce((s, a) => s + ((a.tokensUsed as number) || 0), 0);
  const synced           = validStates.filter(s => s.synchronized).length;
  const phaseTransition  = validStates.some(s => s.phaseTransitionOccurred);
  const criticalThreshold = (validStates[0]?.criticalThreshold as number) ?? 0.55;
  // Use the density already computed inside each agent (averaged across all agents)
  const density = validStates.reduce((s, a) => s + ((a.density as number) || 0), 0) / Math.max(1, validStates.length);

  const cyclePhaseCounts: Record<string, number> = {};
  for (const s of validStates) {
    const p = (s.cyclePhase as string) ?? "explore";
    cyclePhaseCounts[p] = (cyclePhaseCounts[p] ?? 0) + 1;
  }

  // Fetch pheromones just for metrics
  const allPheromones = (await fetchAllAgents("/pheromones")).flat();
  const seen = new Set<string>();
  const unique: unknown[] = [];
  for (const p of allPheromones as Array<{ id: string }>) {
    if (!seen.has(p.id)) { seen.add(p.id); unique.push(p); }
  }

  res.json({
    step,
    totalTokens,
    density,
    criticalThreshold,
    synchronizedCount: synced,
    agentCount: validStates.length,
    phaseTransitionOccurred: phaseTransition,
    cyclePhase: coordinator.phase,
    coordinator: {
      cycleId:        coordinator.cycleId,
      cycleNumber:    coordinator.cycleNumber,
      phase:          coordinator.phase,
      commitCount:    coordinator.commitRegistry.size,
      slashEvents:    coordinator.slashEvents.length,
      expectedAgents: coordinator.expectedAgentCount,
    },
    metrics: {
      totalPheromones:        unique.length,
      totalDiscoveries:       validStates.reduce((s, a) => s + ((a.discoveries as number) || 0), 0),
      totalSyncs:             synced,
      avgEnergy:              validStates.reduce((s, a) => s + ((a.energy as number) || 0), 0) / Math.max(1, validStates.length),
      density,
      synchronizedCount:      synced,
      collectiveMemoryCount:  0,
      uniqueDomainsExplored:  new Set((unique as Array<{ domain: string }>).map(p => p.domain)).size,
    },
    eigenDA: {
      enabled: validStates.some(s => s.eigenDAEnabled),
      attestedPheromones: (unique as Array<{ eigendaCommitment?: string }>).filter(p => p.eigendaCommitment).length,
    },
  });
});


const dashboardIndex = path.join(dashboardDir, "index.html");

app.get("/", (_req, res) => {
  res.sendFile(dashboardIndex);
});

app.get(["/dashboard", "/dashboard/"], (_req, res) => {
  res.sendFile(dashboardIndex);
});

app.listen(DASHBOARD_PORT, "0.0.0.0", () => {
  console.log(`\n[DASHBOARD] http://localhost:${DASHBOARD_PORT}`);
  console.log(`[DASHBOARD] Aggregating from ${AGENT_URLS.length} independent agents:`);
  AGENT_URLS.forEach(u => console.log(`  → ${u}`));
  console.log();
});
