# Swarm Mind — Autonomous Prediction Oracle


**Three AI agents independently analyze crypto markets, seal their predictions with TEE hardware keys before seeing each other's work, then reveal simultaneously to produce a verifiable consensus answer.**


---


## The Problem with Prediction Markets


### A brief history of oracles


The idea of a decentralized prediction market is almost as old as Ethereum. In 2015, Augur launched as the first serious attempt: a market where anyone could bet on any real-world outcome, with payouts settled by a decentralized oracle. The theory was elegant — aggregated crowd belief is a well-studied predictor of future events, and decentralization removes single points of control.


Augur failed at the oracle. The mechanism was REP token holders voting on outcomes. This is not decentralized truth — it is decentralized voting, which is gameable at scale, slow, and expensive. When a market resolved, disputes could extend for weeks. More critically, REP token holders voting on "did this event happen?" are replicating exactly the intersubjective judgment call that decentralized systems are supposed to avoid. If the market is controversial, the oracle fight is more expensive than the prize.


Gnosis (now Gnosis Protocol / CoW Protocol) pivoted away from oracle dependency toward market mechanism design. Prediction markets became a niche product rather than the flagship. The oracle problem was quietly conceded.


**Polymarket** solved the liquidity problem that killed Augur. With $1B+ in trading volume by 2024, it demonstrated that prediction markets have real product-market fit. But Polymarket's oracle is UMA's optimistic oracle: anyone can propose an outcome, a 48-hour challenge window opens, and if nobody posts a bond to dispute, the answer becomes final. This is economically rational and mostly works — but it has three structural weaknesses:


1. **Dispute windows introduce latency.** Fast-moving markets (will BTC be above $X in 24h?) are poorly served by 48-hour settlement.
2. **Economic collusion is possible.** A well-funded actor can suppress disputes by making it unprofitable to challenge a false outcome.
3. **Human judgment is still required.** UMA resolvers are humans reading terms of service. For nuanced outcomes, this is irreducible — but for data-computable outcomes like crypto prices, it is unnecessary overhead.


### Where oracles still fail


Every existing oracle design falls into one of two failure modes:


**Price feed oracles** (Chainlink, UMA for price queries) relay objective on-chain or off-chain data. They work for "what is the current price of ETH?" but not for "will this trend continue?" They are measurement instruments, not reasoning systems.


**Human judgment oracles** (UMA optimistic, Augur REP voting, Kleros) handle subjective claims. For claims that require interpretation — "did this sporting event conclude as described?" — they are the right tool. For claims that can be reasoned about from data — "given this market structure, is the trend bullish?" — they introduce unnecessary noise, latency, and attack surface.


**No existing oracle** combines autonomous reasoning over real market data with a cryptographic proof that the reasoning was independent. This is the gap Swarm Mind occupies.


---


## What Swarm Mind Does Differently


```
EXPLORE ──────────────────────────► COMMIT ──────────► REVEAL ──────► ORACLE ANSWER
                                                                           │
 Three agents analyze:            Each agent seals     Simultaneous       ▼
 • Live price data (CoinGecko)    its prediction       reveal with     YES / NO /
 • 7-day trend + volatility       with TEE hardware    preCommitRef    UNCERTAIN
 • Fear & Greed index             key BEFORE seeing    stamps          + confidence
 • Support/resistance levels      any peer output
 • Volume/market cap                                                   weighted across
                                  commitmentHash =                     all 3 agents
 In complete silence.             sha256:<sealedBlobHash>
 No gossip. No sharing.           signed by Ed25519
```


Three agents — **Nakamoto** (Technical Analyst), **Szabo** (Macro Analyst), and **Finney** (On-chain Analyst) — independently analyze the same crypto market. Each forms a directional opinion: `bullish`, `bearish`, or `neutral`. Each seals that opinion cryptographically before seeing what the others concluded.


When all three reveal, the oracle aggregates their predictions into a verifiable consensus answer for the question: **"Will [TICKER] price be higher in 24h than $X?"**


The oracle answer — **YES**, **NO**, or **UNCERTAIN** — is not a price relay and not a human vote. It is the consensus of provably independent reasoning. The proof is the commitment hash: each agent's sealed blob, signed by its EigenCompute TEE hardware key, timestamped before any peer could have influenced it.


---


## The Independence Problem and LLM Sycophancy


This section explains why independence enforcement is necessary and cannot be solved by prompting.


### The Lorenz mechanism


In 2011, Lorenz, Rauhut, Schweitzer, and Helbing ran controlled experiments in which participants made numerical estimates before and after seeing their peers' answers. The result was decisive: social influence *reduced* the crowd's accuracy while *increasing* its confidence. The mechanism is the destruction of diversity — the statistical cancellation of errors that makes independent aggregation powerful is eliminated when agents anchor to each other's outputs, even weakly.


A crowd that thinks together makes correlated errors. A crowd that thinks independently makes uncorrelated errors that cancel. This is not a bug in human psychology specific to humans. It is a structural property of any aggregation system: independence of inputs is a prerequisite for the error-cancellation that makes aggregation more accurate than any individual. Galton (1907) documented this in weight-estimation; Hong and Page (2004) formalized it in terms of cognitive diversity. The insight scales directly to AI agents.


### The LLM failure mode


Language models are susceptible to the Lorenz mechanism at an architectural level, not just behaviorally. Sharma et al. (Anthropic, 2023) characterize sycophancy in LLMs — the tendency to produce outputs that match perceived preferences rather than factual accuracy — and demonstrate that it is resistant to prompting-based mitigation. It is a training-time property.


In a multi-agent LLM system with open gossip, Agent B reading Agent A's market conclusion before forming its own is not neutral consumption of evidence. It is exposure to social influence that biases B toward agreement at the training-data level. Three agents gossiping their bullish sentiment are not three independent analyses — they are one analysis reflected three times with superficial variation, producing high-confidence correlated errors.


For a prediction oracle, this is catastrophic. The signal you want — genuine disagreement between well-reasoned independent positions — is exactly what gossip-before-commitment destroys. Three sycophantic AIs agreeing on a bubble top while secretly each one is just anchoring to the first is not a prediction market. It is an echo chamber with a confidence score.


### The architectural fix


The only reliable fix is architectural: **enforce silence before commitment**. If agents cannot observe each other's outputs until after they have cryptographically sealed their own, the influence pathway is severed at the protocol level rather than patched at the prompt level.


This is computational pre-registration — analogous to clinical trial pre-registration (commit hypotheses before observing outcomes) but with cryptographic rather than procedural enforcement. The sealed blob proves the prediction existed before gossip began. The TEE hardware signature proves it ran inside an isolated enclave. Timestamps prove ordering.


---


## How Independence Is Proven


Swarm Mind uses **EigenCompute TEE containers** as the trust anchor. There is no EigenDA dependency — verifiability is entirely TEE-based.


### The TEE identity model


Each agent runs inside an EigenCompute Trusted Execution Environment (TDX or SGX-compatible enclave). At startup, the enclave generates an **Ed25519 keypair** from hardware entropy. The private key never leaves the enclave. The `EIGENCOMPUTE_INSTANCE_ID` environment variable provides the hardware-rooted instance identifier.


When an agent commits its sealed prediction:


1. **SealedBlob** is constructed: all prediction hashes from the explore phase, the agent's Ed25519 public key, the TEE instance ID, and a cryptographic independence proof.


2. **sealedBlobHash** = `sha256(JSON.stringify(sealedBlob))` — a deterministic fingerprint of everything the agent predicted, sealed at this exact moment.


3. **commitmentHash** = `sha256:<sealedBlobHash>` — the agent's public commitment, broadcast to peers and the coordinator.


4. **independenceProof** = Ed25519 signature over `agentId | teeInstanceId | sha256(sortedContentHashes)` — signs the commitment to the hardware instance, binding the prediction to the enclave that produced it.


5. The sealed blob and signature are broadcast to peers. Phase advances to `reveal`.


### What a verifier checks


```bash
# Step 1: Retrieve an agent's commitment hash
curl http://localhost:3002/commit | jq '.commitmentHash'
# → "sha256:a3f9c2d1e8b47f..."


# Step 2: Retrieve the oracle prediction (after reveal)
curl http://localhost:3002/oracle | jq '.current'
# → { answer: "YES", confidence: 0.78, ticker: "bitcoin", question: "Will bitcoin..." }


# Step 3: Inspect pre-commit proofs — all agents sealed before reveal
curl http://localhost:3001/api/oracle | jq '.byAgent[].commitmentHash'
# → "sha256:a3f9c2d1e8b47f..."   (Nakamoto)
# → "sha256:7b1e4f3d2c9a8e..."   (Szabo)
# → "sha256:4d8f9c2b1a7e3f..."   (Finney)


# Step 4: Verify independence — each commitmentHash was set before gossip began
# Timestamps on commitments precede pheromone reveal timestamps in the channel
curl http://localhost:3002/state | jq '{commitmentHash, commitTimestamp, cyclePhase}'
```


**The core verification logic:**


```
Ed25519.verify(
 message = sha256(sealedBlob),
 signature = independenceProof,
 publicKey = agent.identity.publicKey
) → true


Then: hash(revealed prediction content) === sealedBlob.findings[].contentHash
→ prediction matches commitment
→ commitment precedes reveal phase (timestamp check)
→ independence confirmed
```


The seal-then-reveal order is enforced by the coordinator's phase state machine (EXPLORE → COMMIT → REVEAL). The coordinator logs commit registrations with coordinator-side timestamps. Any agent that submits a commitment during the wrong phase receives a slash event.


---


## Architecture


```
╔══════════════════════════════════════════════════════════════════════════╗
║                     COORDINATOR  (port 3001)                            ║
║   Objective phase clock. Agents poll /api/coordinator.                  ║
║   Tracks commit registry. Records slash events.                          ║
║   Phase: explore → commit → reveal → synthesis → explore                ║
╠═══════════════════════╦═══════════════════════╦══════════════════════════╣
║   NAKAMOTO (3002)     ║   SZABO      (3003)   ║   FINNEY      (3004)    ║
║   Technical Analyst   ║   Macro Analyst       ║   On-chain Analyst      ║
║   curiosity: 0.9      ║   curiosity: 0.6      ║   curiosity: 0.5        ║
║   diligence: 0.7      ║   diligence: 0.5      ║   diligence: 0.9        ║
║   boldness:  0.3      ║   boldness:  0.4      ║   boldness:  0.7        ║
║   sociability: 0.5    ║   sociability: 0.95   ║   sociability: 0.4      ║
╚═══════════════════════╩═══════════════════════╩══════════════════════════╝
```


### Phase 1: EXPLORE (silence, ~30s)


Agents analyze real crypto market data with no gossip. Each agent fetches live price data from CoinGecko, 7-day price history, and the Fear & Greed index. LLM reasoning happens here. Agents accumulate pheromones locally — no pushing to peers, no pulling from peers.


This is where independent thought forms. The diversity that makes aggregation meaningful is produced here, in isolation. Nakamoto reads chart patterns and support/resistance levels. Szabo frames macro narrative: dollar dominance, risk-on/risk-off flows, correlation to traditional markets. Finney focuses on on-chain signals: exchange flows, whale accumulation, network activity metrics.


### Phase 2: COMMIT (one step, ~6s)


The coordinator's commit window opens. Each agent:


1. Constructs a `SealedBlob` with all prediction hashes from the explore phase, its Ed25519 public key, TEE instance ID, and independence proof
2. Computes `sealedBlobHash = sha256(JSON.stringify(sealedBlob))`
3. Sets `commitmentHash = "sha256:<sealedBlobHash>"`
4. Signs with TEE hardware key → `independenceProof`
5. Registers with coordinator, broadcasts to peers
6. Advances local phase to `reveal`


Agents that do not commit during this window receive a slash event in the coordinator's log.


### Phase 3: REVEAL (gossip, ~24s)


The coordinator opens the reveal window. Agents begin pulling from and pushing to peers. Every pheromone emitted in this phase carries `preCommitRef` — the commitment hash of the sealed blob — proving the content was sealed before this gossip began.


Cross-pollination: Szabo absorbs Nakamoto's technical signals and forms macro-technical correlations. Finney correlates on-chain flows with the macro picture Szabo revealed. This is deliberate social reasoning, not sycophancy, because each agent already committed an independent position.


### Phase 4: SYNTHESIS


The coordinator opens the synthesis window. The first agent to detect this:


1. Collects all three agents' revealed predictions
2. Calls `generateOracleConsensus()` — LLM synthesizes a collective oracle answer
3. Produces an `OracleConsensus` object: `{ answer: "YES"|"NO"|"UNCERTAIN", confidence, bullishVotes, bearishVotes, preCommitProofs }`
4. Pushes to `oracleHistory`, sets `currentOracleAnswer`
5. Notifies the coordinator, which resets to EXPLORE for the next cycle


### Why coordinator-driven (not density-based)


The previous version of Swarm Mind used a local pheromone density heuristic: when density exceeded a threshold, each agent independently declared phase transition. This has a fundamental verifiability problem — "density" is a local variable computed differently by each agent, with no external reference. A verifier cannot reconstruct what density each agent observed or why they fired at a particular moment.


The coordinator-driven approach replaces this with a wall-clock timer that all agents poll. Phase boundaries are:
- **Objective**: any external observer can verify when each window opened and closed
- **Consistent**: all agents react to the same phase signal
- **Auditable**: the coordinator logs commit registrations with coordinator-side timestamps (not agent-claimed timestamps)
- **Slashable**: late commits produce recorded slash events without ambiguity


---


## Agent Reasoning


### Personalities and decision scoring


Each agent has a four-dimensional personality vector. These are not labels — they shape decision scoring in `decider.ts`:


| Agent | Specialization | Curiosity | Diligence | Boldness | Sociability |
|-------|---------------|-----------|-----------|----------|-------------|
| Nakamoto | Technical Analyst | 0.9 | 0.7 | 0.3 | 0.5 |
| Szabo | Macro Analyst | 0.6 | 0.5 | 0.4 | 0.95 |
| Finney | On-chain Analyst | 0.5 | 0.9 | 0.7 | 0.4 |


**Curiosity** increases weight on `analyze_market` and `scan_sector`. **Sociability** increases weight on `share_prediction`. **Diligence + curiosity** together increase weight on `correlate_markets`. **Boldness** determines how strongly an agent asserts directional claims when confidence is borderline.


### The decision-thought cycle


Every agent step:


1. **Absorb** — ingest pheromones from channel (only during reveal phase)
2. **Think** — form a structured thought via LLM: `{reasoning, conclusion, suggestedActions, confidence}`
3. **Decide** — score candidate actions against personality, token budget, and novelty
4. **Execute** — fetch market data, analyze, correlate markets, or share prediction
5. **Emit** — if execution produced an artifact, create a pheromone (locally during explore; gossiped during reveal)


Every thought is compact structured JSON output (`maxTokens=380–550`), kept small to stay within rate limits:


```json
{
 "reasoning": "3 sentences referencing specific prices, percentages, and indicators",
 "conclusion": "a single directional market call with price reference",
 "direction": "bullish",
 "suggestedActions": ["analyze_market:ethereum", "correlate_markets:bitcoin,ethereum"],
 "confidence": 0.81
}
```


Personality differences produce genuinely different outputs from the same data. Given the same Bitcoin dataset at $95,000 with a 7-day uptrend:


- **Nakamoto** (Technical): "Support held at $93,400 for three consecutive days; RSI reset from overbought; likely breakout attempt toward $98,000 resistance. Cautiously bullish."
- **Szabo** (Macro): "Fear & Greed at 68 (Greed) correlates with late-stage momentum phases historically preceding 15–20% corrections. Risk-off bias from Fed language last week reinforces caution."
- **Finney** (On-chain): "Exchange outflows hit 6-month high — 47,000 BTC left exchanges in 7 days. Accumulation pattern from wallets >1,000 BTC. Structurally bullish, 30-day timeframe."


Three different frames, three different conclusions, possibly disagreeing. The commit-reveal cycle proves that divergence was natural, not manufactured after observing peers.


### Market data sources


All APIs are free, no key required:


| Source | API | What agents analyze |
|--------|-----|---------------------|
| CoinGecko | `/api/v3/simple/price` | Current price, 24h change, volume, market cap |
| CoinGecko | `/api/v3/coins/{id}/market_chart` | 7-day price history, volatility calculation |
| Alternative.me | `https://api.alternative.me/fng/` | Fear & Greed index (0–100) with label |


From raw data, `markets.ts` computes:
- **volatility7d**: standard deviation of daily returns over 7 days
- **trend7d**: `"up"` / `"down"` / `"sideways"` based on linear regression slope
- **supportLevel** / **resistanceLevel**: 7-day low/high with small buffers
- **predictionQuestion**: `"Will bitcoin price be higher in 24h than $95,234?"`
- **analysisContext**: compact JSON string fed directly to the LLM


Cache TTL is 5 minutes to avoid hammering free-tier APIs across three agents.


**Supported tickers:** `bitcoin`, `ethereum`, `solana`, `chainlink`, `polygon`


---


## Running Locally


**Prerequisites:** Node.js 20+


```bash
cd swarm-mind
cp .env.example .env
# Configure your LLM provider key (see Configuration below)
# No NASA API key needed. No EigenDA proxy needed.


npm install
npm run build
npm run start:multi
```


Dashboard: `http://localhost:3001`


The coordinator starts automatically inside the dashboard server. Agents on ports 3002–3004 begin polling it immediately. The first explore cycle takes ~30s; the first oracle answer appears after the synthesis phase (~72s from cold start).


### Running on EigenCompute


EigenCompute provides the TEE containers that give hardware-rooted identity to each agent:


```bash
# Each agent container sets this automatically in TEE mode
EIGENCOMPUTE_INSTANCE_ID=<hardware-generated-instance-id>


# The agent uses this as the teeInstanceId in its SealedBlob
# and includes it in the independenceProof signature payload
```


In TEE mode, `EIGENCOMPUTE_INSTANCE_ID` is injected by EigenCompute's enclave initialization. The Ed25519 keypair is generated from hardware entropy inside the enclave. The private key never leaves. The `teeInstanceId` in each sealed blob is hardware-attested — a verifier can confirm the keypair belongs to the claimed EigenCompute instance.


In local mode, `EIGENCOMPUTE_INSTANCE_ID` defaults to `"local"` — the protocol is identical; the trust assumption changes. Local keypairs are software-generated and not hardware-attested.


### Watch the cycle


```bash
# Follow coordinator phase in real time
watch -n2 'curl -s http://localhost:3001/api/coordinator | jq "{cycle: .cycleNumber, phase: .phase, window: .windowRemainingMs, commits: .commitCount}"'


# Watch an agent's current prediction form
watch -n3 'curl -s http://localhost:3002/thoughts | jq ".[0] | {conclusion, confidence}"'


# See the oracle answer after synthesis
watch -n5 'curl -s http://localhost:3001/api/oracle | jq ".aggregated"'
```


---


## Verifying an Oracle Answer


### Get the oracle answer


```bash
# Aggregated answer across all three agents
curl http://localhost:3001/api/oracle | jq '.aggregated'
# → { "answer": "YES", "confidence": 0.74, "participantCount": 3 }


# Per-agent breakdown
curl http://localhost:3001/api/oracle | jq '.byAgent[] | {teeInstance: .teeInstanceId, answer: .current.answer, question: .current.question}'


# Active prediction question
curl http://localhost:3001/api/questions | jq '.active'
# → ["Will bitcoin price be higher in 24h than $95,234?"]
```


### Verify independence (commitment hashes)


```bash
# Step 1: Read each agent's commitment hash
curl http://localhost:3002/commit | jq '{agent: .agentName, hash: .commitmentHash, at: .committedAt}'
curl http://localhost:3003/commit | jq '{agent: .agentName, hash: .commitmentHash, at: .committedAt}'
curl http://localhost:3004/commit | jq '{agent: .agentName, hash: .commitmentHash, at: .committedAt}'


# Step 2: Confirm hashes appear in oracle consensus preCommitProofs
curl http://localhost:3002/oracle | jq '.current.preCommitProofs'
# → { "nakamoto-uuid": "sha256:a3f9c2...", "szabo-uuid": "sha256:7b1e4f...", "finney-uuid": "sha256:4d8f9c..." }


# Step 3: Confirm commitment timestamps precede reveal-phase pheromones
curl http://localhost:3002/commit | jq '.committedAt'       # commit timestamp
curl http://localhost:3002/pheromones | jq '.[0].timestamp' # first reveal pheromone
# commitAt < pheromone.timestamp → sealed before gossip began


# Step 4: Verify Ed25519 signature (independence proof)
# Each agent exposes its public key
curl http://localhost:3002/identity | jq '.publicKey'


# The independenceProof field in the sealed blob was signed by this key over:
# payload = "<agentId>|<teeInstanceId>|<sha256(sortedContentHashes)>"
# Any Ed25519 verifier can confirm: verify(payload, proof, publicKey) = true
```


### Verify the oracle consensus is grounded in pre-commit predictions


```bash
# The collective report after synthesis
curl http://localhost:3001/api/collective | jq '.[0] | {
 preCommitProofs,
 question: .report.overview,
 answer:   .report.oracleAnswer,
 signals:  .report.keySignals
}'


# Each hash in preCommitProofs traces back to an independently sealed prediction.
# The answer cannot have been constructed by observing peers first.
```


### Slash events (commit violations)


```bash
# Check for agents that committed outside the commit window
curl http://localhost:3001/api/coordinator | jq '.slashEventCount'
curl http://localhost:3001/api/evidence | jq '.slashEvents'
```


---


## API Reference


### Dashboard / Coordinator (port 3001)


| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/coordinator` | GET | Current cycle phase, window timer, commit registry |
| `/api/coordinator/commit` | POST | Register commitment (called by agents during commit window) |
| `/api/oracle` | GET | Aggregated oracle answer + per-agent breakdown |
| `/api/questions` | GET | Active prediction questions across all agents |
| `/api/evidence` | GET | Machine-verifiable evidence bundle for current cycle |
| `/api/state` | GET | Aggregated swarm state including coordinator info |
| `/api/agents` | GET | All agent states merged |
| `/api/thoughts` | GET | All agent thoughts, merged and sorted by timestamp |
| `/api/pheromones` | GET | All pheromones in channel (deduped) |
| `/api/attestations` | GET | Agent attestations enriched with commit-reveal data |
| `/api/collective` | GET | Collective memories with `preCommitProofs` |


### Per-agent (ports 3002–3004)


| Endpoint | Description |
|----------|-------------|
| `/oracle` | This agent's current oracle answer + prediction history + commitmentHash |
| `/commit` | Agent's current commitment hash, timestamp, cycle phase |
| `/attestation` | Full agent attestation: identity, compute (TEE mode), stats |
| `/pheromones` | Agent's local pheromone channel |
| `/thoughts` | Agent's thoughts (last 50, newest first) |
| `/collective` | Collective memories generated by this agent |
| `/state` | Full agent state including cycle phase and explorationTarget |
| `/identity` | Agent's Ed25519 public key, fingerprint, EigenCompute instance ID |
| `/health` | LLM rate limit status: `{dailyCount, dailyLimit, minuteCount, minuteLimit}` |
| `/evidence` | Agent-local view of peer commitments received via gossip |


---


## Configuration


```bash
# ── LLM Provider ──────────────────────────────────────────────────────────────
LLM_PROVIDER=anthropic                   # anthropic | openai | eigenai
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-4-6


# OpenAI / Groq compatible
# OPENAI_API_URL=https://api.groq.com/openai/v1
# OPENAI_API_KEY=gsk_...
# OPENAI_MODEL=llama-3.1-8b-instant


# EigenAI
# EIGENAI_API_KEY=your_key
# EIGENAI_API_URL=https://api.eigenai.xyz/v1
# EIGENAI_MODEL=gpt-oss-120b-f16


# ── Rate Limiting (important for free-tier LLM providers) ─────────────────────
LLM_DAILY_LIMIT=4500    # per agent — 3 agents × 4,500 = 13,500 (under Groq's 14,400 RPD)
LLM_MINUTE_LIMIT=2      # per agent — 3 agents × 2 = 6 RPM


# ── EigenCompute (set automatically in TEE mode) ──────────────────────────────
# EIGENCOMPUTE_INSTANCE_ID=<hardware-generated>
# EIGENCOMPUTE_INSTANCE_TYPE=tdx-2xlarge


# ── Cycle Timing (coordinator-driven, wall-clock) ─────────────────────────────
EXPLORE_STEPS=20          # steps of LLM silence before commit (20 × 1.5s = 30s)
SYNC_INTERVAL_MS=1500     # step interval in milliseconds
# Commit window:   4 steps (6s)  — agents seal + register
# Reveal window:  16 steps (24s) — gossip + cross-pollination
# Synthesis:       8 steps (12s) — oracle consensus, then auto-reset to explore


# ── Swarm Dynamics ────────────────────────────────────────────────────────────
PHEROMONE_DECAY=0.12      # strength decay per step
CRITICAL_DENSITY=0.55     # displayed in dashboard (not used for phase control)
TOKEN_BUDGET_PER_AGENT=50000


# ── Multi-Agent Setup ─────────────────────────────────────────────────────────
DASHBOARD_PORT=3001
COORDINATOR_URL=http://localhost:3001


# Agent ports: 3002, 3003, 3004 (set per-process via AGENT_PORT + AGENT_INDEX)
# AGENT_URLS=http://127.0.0.1:3002,http://127.0.0.1:3003,http://127.0.0.1:3004
# PEER_URLS=http://localhost:3003,http://localhost:3004  (set per-agent, excludes self)
```


---


## Swarm Coordination (Stigmergy)


Agent coordination follows the stigmergic model — indirect coordination through environmental modification, first described by Grassé (1959) observing termite nest construction and formalized as Ant Colony Optimization by Dorigo, Maniezzo, and Colorni (1996).


In place of pheromone trails on a physical substrate, agents deposit **digital pheromones** into a shared channel:


- **Strength** — initializes at `0.5 + confidence × 0.3`, decays by `PHEROMONE_DECAY` each step
- **Connections** — IDs of pheromones that contributed to this one (provenance graph)
- **Domain** — the crypto ticker this signal concerns
- **Attestation** — Ed25519 signature binding content to agent identity and timestamp
- **preCommitRef** — commitment hash of the agent's sealed blob (reveal-phase only, proves content was sealed before this gossip)


During the reveal phase, high-strength pheromones from peers attract agents to the same markets. If Nakamoto emits a strong technical signal on `ethereum`, Finney — drawn by the gradient — examines Ethereum's on-chain data and forms its own correlated analysis. The resulting convergence on the same ticker with independent methodological frames produces the multi-perspective oracle answer.


---


## Why This Matters for Prediction Markets


### The oracle independence requirement


A prediction market is only as useful as its oracle. A manipulable oracle breaks the entire incentive structure: if a well-funded actor can influence the oracle's answer, they can take a large position, manipulate the oracle, and profit regardless of actual market outcomes. This is not a theoretical attack — it has happened repeatedly in DeFi.


The standard defense is economic: make manipulation more expensive than the profit from it. UMA's dispute bonds, Augur's REP staking, Kleros's juror deposits. These defenses work when the market is small. As prediction markets scale to billions in open interest, the economics of oracle manipulation become increasingly favorable.


Swarm Mind approaches the problem differently: **make the oracle unfalsifiable by construction**. Three AI agents independently commit sealed predictions before any coordination. An attacker who wants to manipulate the oracle must compromise all three TEE enclaves before the commit window opens. EigenCompute's hardware attestation makes this computationally infeasible at the same cost as the manipulation target.


This does not make Swarm Mind a complete oracle solution for arbitrary markets. For subjective claims ("did this event occur as described?"), human judgment remains irreplaceable. For data-computable claims ("is this market trending up?"), autonomous reasoning with TEE-enforced independence is structurally stronger than any optimistic oracle with a challenge window.


### Beyond price feeds


Chainlink provides price feeds. Swarm Mind provides **reasoned directional predictions with uncertainty quantification**. These are different products serving different needs:


- A price feed answers: "what is the price now?"
- Swarm Mind answers: "will the price be higher in 24h, and with what confidence, based on independent multi-frame analysis?"


The uncertainty quantification matters. An oracle that says "YES (confidence: 0.51)" is sending a very different signal than "YES (confidence: 0.89)." Traditional price feed oracles have no mechanism for expressing epistemic uncertainty. Swarm Mind produces `bullishVotes`, `bearishVotes`, and a weighted confidence across three distinct analytical frameworks.


### Decentralized AI governance


"Multiple independent AI systems all agree" is currently an unfalsifiable claim. Independent analysis and one analysis reflected N times produce identical outputs and identical confidence levels. Without verifiability infrastructure, there is no mechanism to distinguish them.


For AI-powered prediction markets, scientific advisory systems, and any context where AI consensus is being used to make consequential decisions, Swarm Mind's commit-reveal model provides the infrastructure to make independence claims auditable. Commitments are registered with coordinator-side timestamps. The independence proof is a direct cryptographic assertion binding the prediction to the enclave that produced it, timestamped before any peer coordination.


---


## References


### Prediction markets and oracle mechanisms


- **Augur whitepaper**: Peterson, J., Krug, J., Zoltu, M., Williams, A.K., & Alexander, S. (2019). *Augur: A Decentralized Oracle and Prediction Market Platform.* v2.0. — The foundational decentralized prediction market. Introduced REP token voting as a dispute oracle; the whitepaper honestly characterizes the attack surface. Read alongside the v1 post-mortems for a complete picture of what failed.


- **Prediction markets as oracles**: Hanson, R. (2003). Combinatorial Information Market Design. *Information Systems Frontiers* 5(1), 107–119. — Hanson's market scoring rule formalization. The theoretical basis for using market prices as information aggregators. Demonstrates where price aggregation works and where it requires exogenous truth resolution.


- **UMA optimistic oracle**: Hart, A., & Doyle, H. (2020). *UMA: Universal Market Access.* UMA Protocol. — The optimistic oracle design: propose-dispute-finalize with economic bonds. The mechanism Polymarket uses. Analysis of dispute window economics and collusion attack surface.


- **Polymarket**: Polymarket (2024). *Polymarket Technical Documentation.* — The production prediction market with >$1B trading volume. The existence proof that prediction markets have product-market fit. Notable for demonstrating oracle scalability limitations under adversarial conditions.


- **Oracle manipulation in DeFi**: Werner, S.M., Perez, D., Gudgeon, L., Klages-Mundt, A., Harz, D., & Knottenbelt, W.J. (2022). SoK: Decentralized Finance (DeFi). *FC 2022.* — Systematic review of oracle attacks in production DeFi. Documents historical oracle manipulation incidents and economic conditions under which attacks become profitable.


### The independence problem


- **Lorenz mechanism**: Lorenz, J., Rauhut, H., Schweitzer, F., & Helbing, D. (2011). How social influence can undermine the wisdom of crowd effect. *Proceedings of the National Academy of Sciences* 108(22), 9020–9025. — Controlled experiments demonstrating that social influence reduces crowd accuracy while increasing confidence. The empirical foundation for why multi-agent LLM gossip protocols are epistemically dangerous.


- **LLM sycophancy**: Sharma, M., Tully, M., Perez, E., Askell, A., Bai, Y., et al. (Anthropic, 2023). Towards Understanding Sycophancy in Language Models. *arXiv:2310.13548.* — Characterizes sycophancy as a training-time property resistant to prompt-level mitigation. The mechanistic basis for why LLM agents are architecturally biased toward agreement when exposed to peer outputs.


- **Wisdom of crowds**: Galton, F. (1907). Vox Populi. *Nature* 75(1949), 450–451. — Original formalization of independent aggregation as a mechanism for accuracy exceeding any individual. The property that gossip protocols destroy.


- **Cognitive diversity**: Hong, L., & Page, S.E. (2004). Groups of diverse problem solvers can outperform groups of high-ability problem solvers. *PNAS* 101(46), 16385–16389. — Shows that error cancellation via diversity is the mechanism, not individual ability. Agents with different specializations (Technical / Macro / On-chain) analyzing the same market produce diverse errors that cancel when synthesized.


### Trusted execution and verifiable computation


- **Intel TDX architecture**: Intel Corporation (2023). *Intel Trust Domain Extensions (Intel TDX) Module Architecture Specification.* — Reference for TDX-based TEE architecture, attestation quotes, and hardware-rooted key generation. Basis for EigenCompute's hardware independence guarantees.


- **Intel SGX**: Costan, V., & Devadas, S. (2016). Intel SGX Explained. *IACR ePrint Archive* 2016/086. — Detailed analysis of SGX enclave isolation, attestation, and the threat model. Explains what hardware sealing proves and does not prove.


- **EigenCompute**: Eigenlabs (2024). *EigenCompute: Verifiable Cloud Compute.* — EigenCompute's TEE-based compute model. Provides the hardware attestation that binds each agent's keypair to a specific enclave instance, making the independence proof hardware-anchored rather than software-asserted.


### Swarm intelligence and stigmergy


- **Stigmergy (original)**: Grassé, P.P. (1959). La reconstruction du nid et les coordinations inter-individuelles chez *Bellicositermes natalensis* et *Cubitermes* sp. *Insectes Sociaux* 6(1), 41–80. — Original description of indirect coordination through environmental modification. The biological basis for pheromone-based agent coordination.


- **Ant Colony Optimization**: Dorigo, M., Maniezzo, V., & Colorni, A. (1996). Ant System: Optimization by a Colony of Cooperating Agents. *IEEE Transactions on Systems, Man, and Cybernetics* 26(1), 29–41. — Foundational formalization of ACO; introduces pheromone deposit, evaporation, and reinforcement as algorithmic primitives.


- **Swarm intelligence**: Bonabeau, E., Dorigo, M., & Theraulaz, G. (1999). *Swarm Intelligence: From Natural to Artificial Systems.* Oxford University Press. — Comprehensive treatment of emergent collective intelligence from local agent interactions.


### Distributed systems and verifiability


- **Non-repudiation**: ITU-T (2000). *RFC 2479: Non-Repudiation Framework for Internet Commerce.* — Formalizes the distinction between proof-of-origin evidence (achievable via signing) and proof-of-receipt evidence (requires active cooperation; cannot be forced cryptographically). The formal basis for why proving message delivery is categorically harder than proving authorship.


- **Byzantine fault tolerance**: Lamport, L., Shostak, R., & Pease, M. (1982). The Byzantine Generals Problem. *ACM Transactions on Programming Languages and Systems* 4(3), 382–401.


- **Clinical pre-registration**: Nosek, B.A., Ebersole, C.R., DeHaven, A.C., & Mellor, D.T. (2018). The preregistration revolution. *PNAS* 115(11), 2600–2606. — The scientific pre-registration model that commit-reveal implements computationally: seal hypotheses before observing outcomes, with cryptographic rather than procedural enforcement.


---


*Built on EigenCompute TEE containers. Market data from CoinGecko and Alternative.me.*



