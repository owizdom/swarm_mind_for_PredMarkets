import { v4 as uuid } from "uuid";
import {
  Pheromone,
  PheromoneChannel,
  AutonomousAgentState,
  AgentPersonality,
  PolymarketQuestion,
  AgentPrediction,
} from "./types";
import { generateKeypair, buildAttestation } from "./keystore";
import { formMarketPrediction } from "./thinker";

/**
 * Swarm Mind Prediction Agent
 *
 * Each agent independently analyzes a live Polymarket question, forms a
 * directional opinion (YES/NO/UNCERTAIN) using Claude reasoning, and seals
 * the prediction cryptographically before any peer can see it. The agents
 * are Nakamoto (Technical), Szabo (Macro), and Finney (On-chain Evidence).
 */

const NAMES = ["Nakamoto", "Szabo", "Finney"];

const PERSONALITY_PRESETS: Array<{ name: string; personality: AgentPersonality }> = [
  // Nakamoto — Technical: quantitative, anchored to numbers
  {
    name: "Technical",
    personality: { curiosity: 0.7, diligence: 0.9, boldness: 0.6, sociability: 0.4 },
  },
  // Szabo — Macro: contextual, structural, sociable (broadcasts conclusions)
  {
    name: "Macro",
    personality: { curiosity: 0.6, diligence: 0.5, boldness: 0.5, sociability: 0.95 },
  },
  // Finney — On-chain evidence aggregator: bold, diligent, somewhat sociable
  {
    name: "OnChain",
    personality: { curiosity: 0.8, diligence: 0.85, boldness: 0.7, sociability: 0.5 },
  },
];

const NO_QUESTION_TARGET = "awaiting_question";

function generatePersonality(index: number): { specialization: string; personality: AgentPersonality } {
  const preset = PERSONALITY_PRESETS[index % PERSONALITY_PRESETS.length];
  const perturb = () => (Math.random() - 0.5) * 0.08;
  return {
    specialization: preset.name,
    personality: {
      curiosity: Math.max(0, Math.min(1, preset.personality.curiosity + perturb())),
      diligence: Math.max(0, Math.min(1, preset.personality.diligence + perturb())),
      boldness: Math.max(0, Math.min(1, preset.personality.boldness + perturb())),
      sociability: Math.max(0, Math.min(1, preset.personality.sociability + perturb())),
    },
  };
}

export class SwarmAgent {
  state: AutonomousAgentState;
  private currentQuestion: PolymarketQuestion | null = null;
  private currentPrediction: AgentPrediction | null = null;
  private hasFormedPrediction = false;
  private predictionInFlight = false;
  private keypair = generateKeypair();

  constructor(index: number) {
    const angle = (index / 8) * Math.PI * 2;
    const radius = 300 + Math.random() * 200;
    const { specialization, personality } = generatePersonality(index);
    const tokenBudget = parseInt(process.env.TOKEN_BUDGET_PER_AGENT || "200000");

    this.state = {
      id: uuid(),
      name: NAMES[index] || `Agent-${index}`,
      position: {
        x: 500 + Math.cos(angle) * radius,
        y: 400 + Math.sin(angle) * radius,
      },
      velocity: {
        dx: (Math.random() - 0.5) * 8,
        dy: (Math.random() - 0.5) * 8,
      },
      knowledge: [],
      absorbed: new Set(),
      explorationTarget: NO_QUESTION_TARGET,
      energy: 0.3 + Math.random() * 0.3,
      synchronized: false,
      syncedWith: [],
      stepCount: 0,
      discoveries: 0,
      contributionsToCollective: 0,

      thoughts: [],
      decisions: [],
      currentDecision: null,
      reposStudied: [],
      prsCreated: [],
      tokensUsed: 0,
      tokenBudget,
      specialization,
      personality,
      currentAction: "initializing",
      identity: {
        publicKey:   this.keypair.publicKey,
        fingerprint: this.keypair.fingerprint,
        createdAt:   Date.now(),
      },
    };
  }

  enableEngineering(): void {
    // Kept for compatibility — no-op in prediction mode.
  }

  getPrivateKey(): string {
    return this.keypair.privateKey;
  }

  /** Coordinator pushes the active Polymarket question for this cycle. */
  setActiveQuestion(q: PolymarketQuestion): void {
    if (this.currentQuestion?.id === q.id && this.hasFormedPrediction) return;
    this.currentQuestion = q;
    this.state.explorationTarget = q.id;
    this.hasFormedPrediction = false;
    this.currentPrediction = null;
  }

  /** Called by runner at cycle reset so the agent re-thinks next cycle. */
  resetForNewCycle(): void {
    this.hasFormedPrediction = false;
    this.currentPrediction = null;
    this.predictionInFlight = false;
  }

  /** Runner reads this when posting commit registration to coordinator. */
  getCurrentPrediction(): AgentPrediction | null {
    return this.currentPrediction;
  }

  getActiveQuestion(): PolymarketQuestion | null {
    return this.currentQuestion;
  }

  private trackTokens(tokensUsed: number): void {
    this.state.tokensUsed += tokensUsed;
  }

  async step(channel: PheromoneChannel): Promise<Pheromone | null> {
    this.state.stepCount++;
    this.move(channel);
    const absorbed = this.absorbPheromones(channel);

    const discovery = await this.exploreMarket(absorbed);

    this.checkSync(channel);
    return discovery;
  }

  /**
   * Form an independent prediction for the active Polymarket question.
   * Called once per cycle (gated by hasFormedPrediction). The LLM call
   * runs in the background; emits a pheromone with the resulting verdict.
   */
  private async exploreMarket(_absorbed: Pheromone[]): Promise<Pheromone | null> {
    if (!this.currentQuestion) {
      this.state.currentAction = "awaiting question";
      return null;
    }

    if (this.predictionInFlight) {
      this.state.currentAction = "reasoning";
      return null;
    }

    if (this.hasFormedPrediction) {
      // Already predicted this cycle. Occasionally re-emit a pheromone for liveness.
      if (this.currentPrediction && Math.random() < 0.25) {
        return this.predictionPheromone(this.currentPrediction);
      }
      this.state.currentAction = "watching peers";
      return null;
    }

    if (this.state.tokensUsed >= this.state.tokenBudget) {
      this.state.currentAction = "budget exhausted";
      return null;
    }

    this.state.currentAction = `analyzing "${this.currentQuestion.question.slice(0, 50)}…"`;
    this.predictionInFlight = true;

    try {
      const { prediction, tokensUsed } = await formMarketPrediction(this.state, this.currentQuestion);
      this.trackTokens(tokensUsed);
      this.currentPrediction = prediction;
      this.hasFormedPrediction = true;
      this.state.discoveries++;
      console.log(`  [${this.state.name}] prediction: ${prediction.answer} @ ${(prediction.confidence*100).toFixed(0)}% — ${prediction.reasoning.slice(0, 100)}`);
      return this.predictionPheromone(prediction);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [${this.state.name}] prediction error: ${msg.slice(0, 200)}`);
      this.state.currentAction = "recovering";
      return null;
    } finally {
      this.predictionInFlight = false;
    }
  }

  private predictionPheromone(p: AgentPrediction): Pheromone {
    const ts = Date.now();
    const content = `[${p.answer} ${(p.confidence*100).toFixed(0)}%] ${p.reasoning}`;
    const pheromone: Pheromone = {
      id: uuid(),
      agentId: this.state.id,
      content,
      domain: "polymarket prediction",
      confidence: p.confidence,
      strength: 0.7 + p.confidence * 0.25,
      connections: [],
      timestamp: ts,
      attestation: buildAttestation(content, this.state.id, ts, this.keypair.privateKey, this.keypair.publicKey),
      agentPubkey: this.keypair.publicKey,
    };
    this.state.knowledge.push(pheromone);
    return pheromone;
  }

  private move(channel: PheromoneChannel): void {
    if (this.state.synchronized) {
      const cx = 500, cy = 400;
      this.state.velocity.dx += (cx - this.state.position.x) * 0.05;
      this.state.velocity.dy += (cy - this.state.position.y) * 0.05;
      this.state.velocity.dx += (this.state.position.y - cy) * 0.01;
      this.state.velocity.dy += -(this.state.position.x - cx) * 0.01;
    } else {
      this.state.velocity.dx += (Math.random() - 0.5) * 4;
      this.state.velocity.dy += (Math.random() - 0.5) * 4;
      for (const p of channel.pheromones) {
        if (p.agentId === this.state.id || this.state.absorbed.has(p.id)) continue;
        if (p.strength > 0.5) {
          this.state.velocity.dx += (Math.random() - 0.5) * p.strength * 3;
          this.state.velocity.dy += (Math.random() - 0.5) * p.strength * 3;
        }
      }
    }

    this.state.velocity.dx *= 0.85;
    this.state.velocity.dy *= 0.85;
    this.state.position.x = Math.max(50, Math.min(950, this.state.position.x + this.state.velocity.dx));
    this.state.position.y = Math.max(50, Math.min(750, this.state.position.y + this.state.velocity.dy));
  }

  private absorbPheromones(channel: PheromoneChannel): Pheromone[] {
    const absorbed: Pheromone[] = [];
    for (const p of channel.pheromones) {
      if (p.agentId === this.state.id || this.state.absorbed.has(p.id)) continue;
      if (p.strength > 0.2 && Math.random() < p.strength * 0.6) {
        this.state.absorbed.add(p.id);
        absorbed.push(p);
        this.state.energy = Math.min(1.0, this.state.energy + 0.05);
        p.strength = Math.min(1.0, p.strength + 0.1);
      }
    }
    return absorbed;
  }

  private checkSync(channel: PheromoneChannel): void {
    if (this.state.synchronized) return;
    if (
      channel.density >= channel.criticalThreshold &&
      this.state.absorbed.size >= 3 &&
      this.state.energy > 0.5
    ) {
      this.state.synchronized = true;
      this.state.energy = 1.0;
      console.log(`  [${this.state.name}] SYNCHRONIZED (absorbed ${this.state.absorbed.size} signals)`);
    }
  }
}
