import crypto from "crypto";

/** A single knowledge fragment discovered by an agent */
export interface Pheromone {
  id: string;
  agentId: string;
  content: string;           // The actual knowledge
  domain: string;            // What area this covers
  confidence: number;        // 0-1 how certain the agent is
  strength: number;          // Decays over time, boosted when others confirm
  connections: string[];     // IDs of related pheromones
  timestamp: number;
  attestation: string;       // Ed25519 sig: "ed25519:<sig>:<pubkey>" or SHA-256 fallback
  agentPubkey?: string;      // Agent's Ed25519 public key (hex) for verification
  eigendaCommitment?: string; // KZG commitment from EigenDA once anchored
  preCommitRef?: string;     // agent's commitmentHash — proves content was sealed before reveal
}

/** What each agent knows and is doing */
export interface AgentState {
  id: string;
  name: string;
  position: { x: number; y: number };  // Abstract 2D exploration space
  velocity: { dx: number; dy: number };
  knowledge: Pheromone[];               // What this agent has discovered
  absorbed: Set<string>;                // Pheromone IDs it has picked up
  explorationTarget: string;            // Current focus area
  energy: number;                       // Activity level 0-1
  synchronized: boolean;               // Has it joined the collective?
  syncedWith: string[];                // Which agents it's synced with
  stepCount: number;
  discoveries: number;
  contributionsToCollective: number;
}

/** The shared pheromone channel — no central coordinator, just signals */
export interface PheromoneChannel {
  pheromones: Pheromone[];
  density: number;           // Current pheromone density (0-1)
  criticalThreshold: number; // When sync happens
  phaseTransitionOccurred: boolean;
  transitionStep: number | null;
  cyclePhase: CyclePhase;
  phaseStartStep: number;
}

/** LLM-written collective intelligence report */
export interface CollectiveReport {
  overview: string;          // What was studied and the main theme
  keyFindings: string[];     // Concrete things the swarm learned
  opinions: string;          // The swarm's own opinionated take
  improvements: string[];    // What could have been done better
  verdict: string;           // Final assessment / takeaway
}

/** Collective knowledge that emerges after phase transition */
export interface CollectiveMemory {
  id: string;
  topic: string;
  synthesis: string;         // Raw merged knowledge (fallback)
  contributors: string[];    // Which agents contributed
  pheromoneIds: string[];    // Which pheromones were combined
  confidence: number;        // Collective confidence
  attestation: string;       // Hash of the full synthesis
  createdAt: number;
  report?: CollectiveReport; // LLM-written narrative report
  preCommitProofs?: Record<string, string>;  // agentId → commitmentHash
}

/** Full swarm state for dashboard */
export interface SwarmState {
  agents: AgentState[];
  channel: PheromoneChannel;
  collectiveMemories: CollectiveMemory[];
  step: number;
  startedAt: number;
  phaseTransitionOccurred: boolean;
  transitionStep: number | null;
  metrics: SwarmMetrics;
}

export interface SwarmMetrics {
  totalPheromones: number;
  totalDiscoveries: number;
  totalSyncs: number;
  avgEnergy: number;
  density: number;
  synchronizedCount: number;
  collectiveMemoryCount: number;
  uniqueDomainsExplored: number;
}

/** Attestation record for TEE verification */
export interface AttestationRecord {
  agentId: string;
  action: string;
  inputHash: string;
  outputHash: string;
  timestamp: number;
  teeSig: string;
}

// ── Engineering Types (v2) ──

/** LLM provider configuration */
export interface LLMConfig {
  provider: "eigenai" | "openai" | "anthropic" | "claude-cli";
  apiUrl: string;
  apiKey: string;
  model: string;
}

// ── Polymarket / Prediction Oracle Types ──

/** A live Polymarket question the agents reason about */
export interface PolymarketQuestion {
  id: string;
  conditionId: string;
  question: string;
  description: string;
  category: string;
  yesPrice: number;       // 0..1 — market's implied YES probability at fetch time
  noPrice: number;
  volume24hr: number;     // USD
  liquidity: number;
  endDate: string;        // ISO
  slug: string;
  url: string;            // polymarket.com link
  fetchedAt: number;
}

/** A single agent's directional prediction for a Polymarket question */
export interface AgentPrediction {
  id: string;
  agentId: string;
  agentName: string;
  specialization: string;
  questionId: string;
  questionText: string;
  answer: "YES" | "NO" | "UNCERTAIN";
  confidence: number;            // 0..1
  reasoning: string;             // 2-3 sentences
  marketImpliedYes: number;      // 0..1, what Polymarket said at form-time
  disagreesWithMarket: boolean;
  timestamp: number;
  // Filled in during commit phase:
  commitmentHash?: string;
  attestation?: string;
}

/** Final oracle answer aggregating 3 sealed agent predictions */
export interface OracleConsensus {
  id: string;
  cycleId: string;
  questionId: string;
  questionText: string;
  questionUrl: string;
  marketImpliedYes: number;
  answer: "YES" | "NO" | "UNCERTAIN";
  confidence: number;
  agreementLevel: "unanimous" | "majority" | "split";
  narrative: string;
  perAgentPredictions: AgentPrediction[];
  preCommitProofs: Record<string, string>; // agentId → commitmentHash
  generatedAt: number;
}

/** Agent personality traits (each 0-1) */
export interface AgentPersonality {
  curiosity: number;   // How eagerly it explores new repos/topics
  diligence: number;   // How thoroughly it reviews and tests
  boldness: number;    // Willingness to tackle hard issues / submit PRs
  sociability: number; // How much it cross-pollinates with other agents
}

/** A structured thought produced by LLM reasoning */
export interface AgentThought {
  id: string;
  agentId: string;
  trigger: string;         // What prompted this thought
  observation: string;     // What the agent noticed
  reasoning: string;       // Chain of thought
  conclusion: string;      // Final takeaway
  suggestedActions: string[]; // What should be done next
  confidence: number;      // 0-1
  timestamp: number;
}

/** Cost estimate for a decision */
export interface DecisionCost {
  estimatedTokens: number;
  estimatedTimeMs: number;
  riskLevel: "low" | "medium" | "high";
}

/** Result of executing a decision */
export interface DecisionResult {
  success: boolean;
  summary: string;
  artifacts: Artifact[];
  tokensUsed: number;
}

/** A real NASA/science dataset fetched and analyzed by an agent */
export interface ScienceDataset {
  id: string;
  topic: string;           // e.g. "near_earth_objects"
  subtopic: string;        // e.g. "Asteroid Close Approaches"
  source: string;          // e.g. "NASA NeoWs API"
  fetchedAt: number;
  recordCount: number;
  timeRange: string;
  stats: Record<string, unknown>;
  highlights: string[];    // Pre-computed notable findings
  analysisContext: string; // JSON-serialized rich data for LLM reasoning
}

/** Discriminated union of possible agent actions */
export type AgentAction =
  | { type: "analyze_dataset"; topic: string }
  | { type: "share_finding"; finding: string; topic?: string }
  | { type: "correlate_findings"; topics: string[] }
  | { type: "explore_topic"; topic: string };

/** A decision an agent makes about what to do */
export interface AgentDecision {
  id: string;
  agentId: string;
  action: AgentAction;
  priority: number;       // Computed score
  cost: DecisionCost;
  status: "pending" | "executing" | "completed" | "failed";
  result: DecisionResult | null;
  createdAt: number;
  completedAt: number | null;
}


/** Output artifact from agent execution */
export interface Artifact {
  type: "finding" | "analysis" | "correlation";
  content: string;
}

/** Cryptographic identity — generated at startup, hardware-rooted on EigenCompute TEE */
export interface AgentIdentity {
  publicKey: string;   // hex-encoded Ed25519 SPKI
  fingerprint: string; // sha256(pubkey).slice(0,16) — shown in UI
  createdAt: number;
}

/** Extended agent state for autonomous science */
export interface AutonomousAgentState extends AgentState {
  thoughts: AgentThought[];
  decisions: AgentDecision[];
  currentDecision: AgentDecision | null;
  reposStudied: string[];     // Re-used as datasetsAnalyzed (topic strings)
  prsCreated: string[];       // Unused in science mode
  tokensUsed: number;
  tokenBudget: number;
  specialization: string;
  personality: AgentPersonality;
  currentAction: string;
  identity: AgentIdentity;    // Cryptographic identity (TEE keypair on EigenCompute)
  commitmentHash?: string;
  commitTimestamp?: number;
  cyclePhase?: CyclePhase;
}

/** Collaborative project detected among agents */
export interface CollaborativeProject {
  id: string;
  title: string;
  description: string;
  participants: string[];     // Agent IDs
  repos: string[];            // "owner/repo" strings
  status: "proposed" | "active" | "completed";
  createdAt: number;
}

// ── Utility Functions ──

export function hash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function hashObject(obj: unknown): string {
  return hash(JSON.stringify(obj));
}

// ── Commit-Reveal Types ──

export type CyclePhase = "explore" | "commit" | "reveal" | "synthesis";

export interface FindingSummary {
  pheromoneId: string;
  contentHash: string;     // sha256(content) hex
  domain: string;
  confidence: number;
  timestamp: number;
}

export interface SealedBlob {
  agentId: string;
  agentPublicKey: string;         // hex-encoded Ed25519 SPKI
  agentName: string;
  explorationEndedAt: number;
  eigenDAReferenceBlock: number | null;  // Ethereum block from EigenDA batch — objective timestamp
  eigenDABatchId: string | null;         // EigenDA batch identifier
  teeInstanceId: string;                 // EIGENCOMPUTE_INSTANCE_ID || "local"
  findings: FindingSummary[];
  topicsCovered: string[];
  independenceProof: string; // ed25519:<sig(agentId|eigenDAReferenceBlock|sha256(sortedHashes))>:<pubkey>
}

export interface AgentCommitment {
  agentId: string;
  agentName: string;
  agentPublicKey: string;
  commitmentHash: string;          // "eigenda:<kzg>" or "sha256:<hex>" fallback
  committedViaEigenDA: boolean;
  sealedBlobHash: string;          // sha256(JSON.stringify(sealedBlob))
  committedAt: number;
  cycleStartStep: number;
  eigenDABatchId: string | null;
  eigenDAReferenceBlock: number | null;
}

// ── Evidence Bundle — machine-verifiable proof of independent convergence ──

export interface CommitmentRecord {
  agentId: string;
  agentName: string;
  kzgHash: string;
  eigenDABatchId: string | null;
  eigenDAReferenceBlock: number | null;
  submittedAt: number;              // coordinator wall-clock — not agent local time
  committedViaEigenDA: boolean;
  sealedBlobHash: string;
}

export interface IntegrityCheck {
  agentId: string;
  agentName: string;
  committedSealedBlobHash: string; // what was committed
  // A verifier fetches the blob from EigenDA and checks sha256(blob) === committedSealedBlobHash
  verificationUrl: string | null;  // eigenda-proxy /get/<kzgHash> if available
  passed: boolean | null;          // null = cannot verify without EigenDA access
}

export interface IndependenceCheck {
  agentId: string;
  agentName: string;
  eigenDAReferenceBlock: number | null;
  commitWindowCloseBlock: number | null;  // coordinator's reveal-start block estimate
  // independentBeforeReveal = eigenDAReferenceBlock < commitWindowCloseBlock
  independentBeforeReveal: boolean | null;
}

export interface EvidenceBundle {
  cycleId: string;
  cycleNumber: number;
  generatedAt: number;
  commitments: CommitmentRecord[];
  integrityChecks: IntegrityCheck[];
  independenceChecks: IndependenceCheck[];
  allCommitted: boolean;           // all expected agents submitted commits
  allIndependentBeforeReveal: boolean | null;
  synthesis: CollectiveReport | null;
  verifierInstructions: string;
}
