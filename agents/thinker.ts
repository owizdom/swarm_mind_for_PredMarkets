import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuid } from "uuid";
import type {
  LLMConfig,
  AgentThought,
  AutonomousAgentState,
  Pheromone,
  CollectiveReport,
  ScienceDataset,
  PolymarketQuestion,
  AgentPrediction,
  OracleConsensus,
} from "./types";
import { callClaudeCLI } from "./llm-claude-cli";
let openaiClient: OpenAI | null = null;
let anthropicClient: Anthropic | null = null;
let activeProvider: LLMConfig["provider"] = "eigenai";
let modelName = "gpt-oss-120b-f16";
let totalTokensTracked = 0;
let totalCostTracked = 0;
let totalCallsTracked = 0;
export function getTotalCostUsd(): number { return totalCostTracked; }
export function getTotalCalls(): number { return totalCallsTracked; }

// ── Rate limiter (shared across all agents in this process) ──
const DAILY_LIMIT  = parseInt(process.env.LLM_DAILY_LIMIT  || "14000"); // buffer under 14,400
const MINUTE_LIMIT = parseInt(process.env.LLM_MINUTE_LIMIT || "25");    // buffer under 30/min

let dailyCount  = 0;
let dailyReset  = Date.now() + 86_400_000;   // reset 24h from start
const minuteWindow: number[] = [];            // timestamps of calls in the last 60s

function isRateLimited(): boolean {
  const now = Date.now();

  // Reset daily counter if 24h has passed
  if (now > dailyReset) {
    dailyCount = 0;
    dailyReset = now + 86_400_000;
  }

  // Evict timestamps older than 60s from the sliding window
  while (minuteWindow.length && minuteWindow[0] < now - 60_000) minuteWindow.shift();

  if (dailyCount >= DAILY_LIMIT) {
    console.warn(`  [LLM] Daily limit reached (${DAILY_LIMIT}). Skipping.`);
    return true;
  }
  if (minuteWindow.length >= MINUTE_LIMIT) {
    // Don't log every time — too noisy
    return true;
  }

  // Record this call
  minuteWindow.push(now);
  dailyCount++;
  return false;
}

export function initThinker(config: LLMConfig): void {
  activeProvider = config.provider;
  modelName = config.model || "sonnet";

  if (config.provider === "claude-cli") {
    // No client to initialize — calls go through `claude` subprocess
    console.log(`[THINKER] Initialized with claude CLI subprocess (model: ${modelName})`);
    return;
  }

  if (config.provider === "anthropic") {
    anthropicClient = new Anthropic({ apiKey: config.apiKey });
  } else {
    openaiClient = new OpenAI({
      baseURL: config.apiUrl,
      apiKey: config.apiKey,
    });
  }

  console.log(`[THINKER] Initialized with ${config.provider} model: ${config.model}`);
}

export function getTotalTokensUsed(): number {
  return totalTokensTracked;
}

export function getLLMUsage(): { dailyCount: number; dailyLimit: number; minuteCount: number; minuteLimit: number } {
  const now = Date.now();
  const recentMinute = minuteWindow.filter(t => t >= now - 60_000).length;
  return { dailyCount, dailyLimit: DAILY_LIMIT, minuteCount: recentMinute, minuteLimit: MINUTE_LIMIT };
}

// ── Internal LLM call ──

interface CallOptions {
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  force?: boolean;  // bypass per-process rate limiter (for rare synthesis calls)
}

async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  options: CallOptions = {}
): Promise<{ content: string; tokensUsed: number }> {
  if (!options.force && isRateLimited()) return { content: "", tokensUsed: 0 };
  // Forced calls still track toward limits
  if (options.force) {
    const now = Date.now();
    while (minuteWindow.length && minuteWindow[0] < now - 60_000) minuteWindow.shift();
    minuteWindow.push(now);
    dailyCount++;
  }

  const maxTokens = options.maxTokens || 1000;
  const temperature = options.temperature ?? 0.7;

  if (activeProvider === "claude-cli") {
    return callClaudeCLIWrapper(systemPrompt, userPrompt);
  }
  if (activeProvider === "anthropic") {
    return callAnthropic(systemPrompt, userPrompt, maxTokens, temperature, options.jsonMode);
  }
  return callOpenAI(systemPrompt, userPrompt, maxTokens, temperature, options.jsonMode);
}

async function callClaudeCLIWrapper(
  systemPrompt: string,
  userPrompt: string
): Promise<{ content: string; tokensUsed: number }> {
  try {
    const r = await callClaudeCLI(systemPrompt, userPrompt, {
      maxBudgetUsd: 1.0,
      model: modelName || "sonnet",
      timeoutMs: 90_000,
    });
    totalTokensTracked += r.tokensUsed;
    totalCostTracked += r.costUsd;
    totalCallsTracked++;
    return { content: r.content, tokensUsed: r.tokensUsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [LLM] claude-cli failed: ${msg.slice(0, 200)}`);
    return { content: "", tokensUsed: 0 };
  }
}

async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  temperature: number,
  jsonMode?: boolean
): Promise<{ content: string; tokensUsed: number }> {
  if (!anthropicClient) throw new Error("Anthropic client not initialized.");

  const effectiveModel = modelName;
  const prompt = jsonMode
    ? userPrompt + "\n\nIMPORTANT: Respond with valid JSON only, no markdown fences."
    : userPrompt;

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await anthropicClient.messages.create({
        model: effectiveModel,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      });

      let content = "";
      for (const block of response.content) {
        if (block.type === "text") content += block.text;
      }

      // Strip markdown fences if present
      content = content.trim();
      if (content.startsWith("```json")) content = content.slice(7);
      else if (content.startsWith("```")) content = content.slice(3);
      if (content.endsWith("```")) content = content.slice(0, -3);
      content = content.trim();

      const tokensUsed =
        (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
      totalTokensTracked += tokensUsed;

      return { content, tokensUsed };
    } catch (err: unknown) {
      if (attempt === maxRetries) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [LLM] Failed after ${maxRetries + 1} attempts: ${message.slice(0, 200)}`);
        return { content: "", tokensUsed: 0 };
      }
      const message = err instanceof Error ? err.message : String(err);
      const is429 = message.includes("429") || message.toLowerCase().includes("rate limit");
      await new Promise((r) => setTimeout(r, is429 ? 8000 * (attempt + 1) : 1000 * (attempt + 1)));
    }
  }

  return { content: "", tokensUsed: 0 };
}

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  temperature: number,
  jsonMode?: boolean
): Promise<{ content: string; tokensUsed: number }> {
  if (!openaiClient) throw new Error("OpenAI client not initialized.");

  const effectiveModel = modelName;
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await openaiClient.chat.completions.create({
        model: effectiveModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature,
        ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
      });

      const content = response.choices?.[0]?.message?.content || "";
      const tokensUsed =
        (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0);
      totalTokensTracked += tokensUsed;

      return { content, tokensUsed };
    } catch (err: unknown) {
      if (attempt === maxRetries) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [LLM] Failed after ${maxRetries + 1} attempts: ${message.slice(0, 200)}`);
        return { content: "", tokensUsed: 0 };
      }
      const message = err instanceof Error ? err.message : String(err);
      const is429 = message.includes("429") || message.toLowerCase().includes("rate limit");
      await new Promise((r) => setTimeout(r, is429 ? 8000 * (attempt + 1) : 1000 * (attempt + 1)));
    }
  }

  return { content: "", tokensUsed: 0 };
}

// ── System Prompt Builder ──

function buildSystemPrompt(agent: AutonomousAgentState): string {
  const p = agent.personality;
  const traits: string[] = [];

  if (p.curiosity > 0.7) traits.push("deeply curious, eager to find patterns across datasets");
  else if (p.curiosity < 0.3) traits.push("focused, prefers deep dives over breadth");

  if (p.diligence > 0.7) traits.push("meticulous, references exact numbers in analysis");
  else if (p.diligence < 0.3) traits.push("intuitive, favors big-picture insights");

  if (p.boldness > 0.7) traits.push("bold, forms strong hypotheses and defends them");
  else if (p.boldness < 0.3) traits.push("cautious, hedges when data is uncertain");

  if (p.sociability > 0.7) traits.push("collaborative, eager to share findings with the swarm");
  else if (p.sociability < 0.3) traits.push("independent, does deep analysis before sharing");

  return `You are ${agent.name}, a NASA swarm agent. Specialization: ${agent.specialization}. Traits: ${traits.join("; ") || "balanced"}. Datasets analyzed: ${agent.reposStudied.length}. Be specific with numbers. Form bold scientific opinions.`;
}

// ── Core Reasoning Functions ──

export async function formThought(
  agentState: AutonomousAgentState,
  trigger: string,
  observation: string,
  context: string
): Promise<{ thought: AgentThought; tokensUsed: number }> {
  const systemPrompt = buildSystemPrompt(agentState);
  const userPrompt = `Trigger: ${trigger.slice(0, 80)}
Observation: ${observation.slice(0, 120)}
Context: ${context.slice(0, 100)}

JSON:{"reasoning":"2 sentences","conclusion":"1 sentence","suggestedActions":["action:topic"],"confidence":0.0-1.0}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 380,
    jsonMode: true,
  });

  let parsed: { reasoning?: string; conclusion?: string; suggestedActions?: string[]; confidence?: number } = {};
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = {
      reasoning: content.slice(0, 200),
      conclusion: "Could not form structured thought",
      suggestedActions: [],
      confidence: 0.3,
    };
  }

  const thought: AgentThought = {
    id: uuid(),
    agentId: agentState.id,
    trigger,
    observation,
    reasoning: parsed.reasoning || "",
    conclusion: parsed.conclusion || "",
    suggestedActions: parsed.suggestedActions || [],
    confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
    timestamp: Date.now(),
  };

  return { thought, tokensUsed };
}

export async function analyzeDataset(
  agentState: AutonomousAgentState,
  dataset: ScienceDataset
): Promise<{ thought: AgentThought; tokensUsed: number }> {
  const systemPrompt = buildSystemPrompt(agentState);

  const statsText = Object.entries(dataset.stats)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  const userPrompt = `NASA dataset: ${dataset.subtopic} | ${dataset.timeRange} | ${dataset.recordCount} records

Stats: ${statsText.slice(0, 300)}
Highlights: ${dataset.highlights.slice(0, 3).map((h) => `• ${h}`).join(" ")}
Context: ${dataset.analysisContext.slice(0, 600)}

JSON:{"reasoning":"3 sentences with specific numbers","conclusion":"bold 1-sentence finding","suggestedActions":["analyze_dataset:topic","share_finding:desc","correlate_findings:t1,t2"],"confidence":0.0-1.0}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 550,
    jsonMode: true,
  });

  let parsed: { reasoning?: string; conclusion?: string; suggestedActions?: string[]; confidence?: number } = {};
  try { parsed = JSON.parse(content); } catch { parsed = { reasoning: content.slice(0, 200), conclusion: "Analysis incomplete", suggestedActions: [], confidence: 0.4 }; }

  const thought: AgentThought = {
    id: uuid(),
    agentId: agentState.id,
    trigger: `dataset_analysis:${dataset.topic}`,
    observation: `Analyzed ${dataset.subtopic} — ${dataset.highlights[0] || `${dataset.recordCount} records`}`,
    reasoning: parsed.reasoning || "",
    conclusion: parsed.conclusion || "",
    suggestedActions: parsed.suggestedActions || [],
    confidence: Math.max(0, Math.min(1, parsed.confidence || 0.6)),
    timestamp: Date.now(),
  };

  return { thought, tokensUsed };
}

export async function synthesizeKnowledge(
  agentState: AutonomousAgentState,
  pheromones: Pheromone[]
): Promise<{ thought: AgentThought; tokensUsed: number }> {
  const systemPrompt = buildSystemPrompt(agentState);

  const pheromoneInfo = pheromones
    .slice(0, 5)
    .map((p) => `[${p.domain}] ${p.content.slice(0, 80)}`)
    .join("\n");

  const userPrompt = `Signals:\n${pheromoneInfo}\n\nJSON:{"reasoning":"2 sentences","conclusion":"cross-domain insight","suggestedActions":["explore_topic:topic"],"confidence":0.0-1.0}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 420,
    jsonMode: true,
  });

  let parsed: { reasoning?: string; conclusion?: string; suggestedActions?: string[]; confidence?: number } = {};
  try { parsed = JSON.parse(content); } catch { parsed = { reasoning: content.slice(0, 200), conclusion: "Synthesis incomplete", suggestedActions: [], confidence: 0.3 }; }

  const thought: AgentThought = {
    id: uuid(),
    agentId: agentState.id,
    trigger: "knowledge_synthesis",
    observation: `Synthesized ${pheromones.length} pheromones across domains`,
    reasoning: parsed.reasoning || "",
    conclusion: parsed.conclusion || "",
    suggestedActions: parsed.suggestedActions || [],
    confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
    timestamp: Date.now(),
  };

  return { thought, tokensUsed };
}


export async function generateCollectiveReport(
  agentThoughts: Array<{ agentName: string; specialization: string; observation: string; reasoning: string; conclusion: string; confidence: number }>,
  reposStudied: string[],
  topic: string
): Promise<{ report: CollectiveReport; tokensUsed: number }> {
  const systemPrompt = `You are the collective intelligence of an autonomous NASA science swarm.
Your agents analyze real NASA datasets and you synthesize their findings into a research report.
Write like a lead scientist giving a briefing — opinionated, data-driven, and specific.
Reference actual numbers, phenomena, and anomalies the agents found. Do not be generic.`;

  const thoughtsText = agentThoughts.slice(0, 8).map((t) =>
    `[${t.agentName}] ${t.conclusion} (${Math.round(t.confidence * 100)}%)`
  ).join("\n");

  const datasetList = reposStudied.slice(0, 8).join(", ") || "various NASA datasets";

  const userPrompt = `The swarm analyzed: ${datasetList}

Agent findings and conclusions:
${thoughtsText}

Write a scientific findings report based on the actual data the agents analyzed.
Be specific — reference real numbers, dates, anomalies, and phenomena from the data.

Respond as JSON:
{
  "overview": "1-2 sentences: what NASA data was analyzed and the central scientific theme or question",
  "keyFindings": ["3-5 specific findings with actual data references — numbers, rates, comparisons, anomalies"],
  "opinions": "2-3 sentences of the collective's scientific opinion — hypotheses, interpretations, what the data suggests beyond the obvious",
  "improvements": ["2-4 limitations or gaps — what the data didn't capture, what follow-up studies are needed, what the swarm missed"],
  "verdict": "1-2 sentences: the collective's scientific conclusion — what does this data tell us about space/Earth/the universe?"
}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 800,
    temperature: 0.82,
    jsonMode: true,
    force: true,  // synthesis call — bypasses per-process rate limiter
  });

  let parsed: Partial<CollectiveReport> = {};
  try { parsed = JSON.parse(content); } catch { /* use fallback */ }

  const report: CollectiveReport = {
    overview:      parsed.overview     || topic,
    keyFindings:   parsed.keyFindings  || [],
    opinions:      parsed.opinions     || "",
    improvements:  parsed.improvements || [],
    verdict:       parsed.verdict      || "",
  };

  return { report, tokensUsed };
}

// ── Market Prediction (Polymarket) ──────────────────────────────────────────

const PERSONALITY_LENS: Record<string, string> = {
  Technical: "Quantitative analyst. Anchor every claim to numbers: implied probability vs base rate, comparable past events, statistical priors. Be sharp.",
  Macro:     "Macro/contextual thinker. Focus on incentives of involved parties, structural drivers, and second-order consequences. Argue from causes.",
  OnChain:   "Evidence aggregator. Weigh reported facts, what's verifiable, what's plausible. Identify the most likely scenario from publicly observable signals.",
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function parseAnswerString(s: unknown): "YES" | "NO" | "UNCERTAIN" | null {
  if (typeof s !== "string") return null;
  const u = s.trim().toUpperCase();
  if (u === "YES" || u === "NO" || u === "UNCERTAIN") return u;
  return null;
}

function stripFences(content: string): string {
  let cleaned = content.trim();
  if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
  if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
  return cleaned.trim();
}

/**
 * Each agent forms an independent prediction for a Polymarket question.
 * This is the core EXPLORE-phase reasoning call. The result is sealed
 * cryptographically before any peer can see it.
 */
export async function formMarketPrediction(
  agent: AutonomousAgentState,
  question: PolymarketQuestion
): Promise<{ prediction: AgentPrediction; tokensUsed: number }> {
  const lens = PERSONALITY_LENS[agent.specialization] || "Be objective and data-driven.";

  const systemPrompt =
    `You are ${agent.name}, an autonomous prediction oracle agent. Specialization: ${agent.specialization}. ` +
    `${lens} Your prediction is sealed cryptographically BEFORE you see any other agent's analysis. ` +
    `Be honest. The market price is a signal, not gospel — your job is to assess whether the market is right. ` +
    `Output is binding and signed by your hardware key. Respond with ONLY a valid JSON object, no preamble, no markdown fences.`;

  const userPrompt =
`Polymarket question: "${question.question}"

Description: ${(question.description || "(no description)").slice(0, 800)}

Market data:
- Implied probability YES: ${(question.yesPrice * 100).toFixed(1)}%
- Implied probability NO:  ${(question.noPrice * 100).toFixed(1)}%
- 24h volume: $${Math.round(question.volume24hr).toLocaleString()}
- Resolves: ${question.endDate || "unknown"}
- Category: ${question.category}

Form your independent prediction now.

Respond as JSON:
{
  "answer": "YES" | "NO" | "UNCERTAIN",
  "confidence": 0.0-1.0,
  "reasoning": "2-3 sentences explaining your verdict, citing specific evidence or reasoning",
  "disagreesWithMarket": true | false
}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 600,
    temperature: 0.7,
    jsonMode: true,
    force: true,
  });

  let parsed: { answer?: unknown; confidence?: unknown; reasoning?: unknown; disagreesWithMarket?: unknown } = {};
  try {
    parsed = JSON.parse(stripFences(content));
  } catch {
    /* fall through to fallback below */
  }

  const llmAnswer = parseAnswerString(parsed.answer);
  const fallbackAnswer: "YES" | "NO" | "UNCERTAIN" =
    question.yesPrice >= 0.65 ? "YES" :
    question.yesPrice <= 0.35 ? "NO"  : "UNCERTAIN";

  const answer = llmAnswer ?? fallbackAnswer;
  const confidence = clamp01(typeof parsed.confidence === "number" ? parsed.confidence : 0.5);
  const reasoning = typeof parsed.reasoning === "string" && parsed.reasoning.trim().length > 0
    ? parsed.reasoning.trim()
    : `Fallback prediction derived from market price (${(question.yesPrice * 100).toFixed(0)}% YES). LLM call returned no structured output.`;
  const disagreesWithMarket = typeof parsed.disagreesWithMarket === "boolean"
    ? parsed.disagreesWithMarket
    : (answer === "YES" && question.yesPrice < 0.5) || (answer === "NO" && question.yesPrice > 0.5);

  return {
    prediction: {
      id: uuid(),
      agentId: agent.id,
      agentName: agent.name,
      specialization: agent.specialization,
      questionId: question.id,
      questionText: question.question,
      answer,
      confidence,
      reasoning,
      marketImpliedYes: question.yesPrice,
      disagreesWithMarket,
      timestamp: Date.now(),
    },
    tokensUsed,
  };
}

/**
 * SYNTHESIS-phase call: aggregates sealed agent predictions into a single
 * oracle answer. Uses confidence-weighted voting as a deterministic fallback
 * if the LLM call fails, so the demo cycle always completes.
 */
export async function generateOracleConsensus(
  predictions: AgentPrediction[],
  question: PolymarketQuestion,
  cycleId: string,
  preCommitProofs: Record<string, string>
): Promise<{ consensus: OracleConsensus; tokensUsed: number }> {
  const tally = { YES: 0, NO: 0, UNCERTAIN: 0 };
  for (const p of predictions) tally[p.answer] += p.confidence;

  const baselineAnswer: "YES" | "NO" | "UNCERTAIN" =
    tally.YES > tally.NO && tally.YES > tally.UNCERTAIN ? "YES" :
    tally.NO  > tally.YES && tally.NO  > tally.UNCERTAIN ? "NO"  : "UNCERTAIN";

  const yesCount = predictions.filter(p => p.answer === "YES").length;
  const noCount  = predictions.filter(p => p.answer === "NO").length;
  const baselineAgreement: "unanimous" | "majority" | "split" =
    (yesCount === predictions.length || noCount === predictions.length) ? "unanimous" :
    (yesCount >= 2 || noCount >= 2) ? "majority" : "split";

  const systemPrompt =
    `You are the oracle synthesizer. ${predictions.length} independent autonomous agents analyzed the same Polymarket question in cryptographic isolation — their predictions were sealed with hardware keys before they could see each other's work. Synthesize their reasoning into a single oracle answer. Do not hedge. Respond with ONLY valid JSON, no preamble, no markdown fences.`;

  const userPrompt =
`Polymarket question: "${question.question}"
Market implied YES: ${(question.yesPrice * 100).toFixed(1)}%

Sealed predictions:

${predictions.map(p => `[${p.agentName} — ${p.specialization}] ${p.answer} @ ${(p.confidence*100).toFixed(0)}% confidence
  ${p.reasoning}`).join("\n\n")}

Confidence-weighted tally: YES=${tally.YES.toFixed(2)}, NO=${tally.NO.toFixed(2)}, UNCERTAIN=${tally.UNCERTAIN.toFixed(2)}
Baseline winner: ${baselineAnswer} (${baselineAgreement})

Respond as JSON:
{
  "answer": "YES" | "NO" | "UNCERTAIN",
  "confidence": 0.0-1.0,
  "narrative": "2-3 sentences explaining the consensus, naming agents whose reasoning carried it",
  "agreementLevel": "unanimous" | "majority" | "split"
}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 700,
    temperature: 0.6,
    jsonMode: true,
    force: true,
  });

  let parsed: { answer?: unknown; confidence?: unknown; narrative?: unknown; agreementLevel?: unknown } = {};
  try {
    parsed = JSON.parse(stripFences(content));
  } catch {
    /* use baseline fallback below */
  }

  const llmAnswer = parseAnswerString(parsed.answer);
  const totalWeight = Math.max(0.001, tally.YES + tally.NO + tally.UNCERTAIN);
  const baselineConfidence = Math.max(tally.YES, tally.NO, tally.UNCERTAIN) / totalWeight;
  const llmAgreement: "unanimous" | "majority" | "split" | null =
    parsed.agreementLevel === "unanimous" || parsed.agreementLevel === "majority" || parsed.agreementLevel === "split"
      ? parsed.agreementLevel
      : null;

  return {
    consensus: {
      id: uuid(),
      cycleId,
      questionId: question.id,
      questionText: question.question,
      questionUrl: question.url,
      marketImpliedYes: question.yesPrice,
      answer: llmAnswer ?? baselineAnswer,
      confidence: clamp01(typeof parsed.confidence === "number" ? parsed.confidence : baselineConfidence),
      agreementLevel: llmAgreement ?? baselineAgreement,
      narrative: typeof parsed.narrative === "string" && parsed.narrative.trim().length > 0
        ? parsed.narrative.trim()
        : `Confidence-weighted vote: YES=${tally.YES.toFixed(2)}, NO=${tally.NO.toFixed(2)}, UNCERTAIN=${tally.UNCERTAIN.toFixed(2)}. Winner: ${baselineAnswer} by ${baselineAgreement} of agents.`,
      perAgentPredictions: predictions,
      preCommitProofs,
      generatedAt: Date.now(),
    },
    tokensUsed,
  };
}



