/**
 * Claude CLI Subprocess LLM Provider
 *
 * Uses the locally-installed `claude` CLI as the LLM endpoint, inheriting
 * the user's Claude Code OAuth credentials. No ANTHROPIC_API_KEY needed.
 *
 * Important: do NOT pass --bare. --bare strictly requires ANTHROPIC_API_KEY
 * and refuses to read keychain/OAuth — exactly what we don't want here.
 */

import { spawn } from "child_process";

export interface ClaudeCLIResult {
  content: string;
  tokensUsed: number;
  costUsd: number;
}

export interface ClaudeCLIOptions {
  maxBudgetUsd?: number;
  model?: string;
  timeoutMs?: number;
}

const DISALLOWED_TOOLS =
  "Read,Edit,Write,Bash,Glob,Grep,WebFetch,WebSearch,Agent,NotebookEdit,Skill,TaskCreate,TaskUpdate,TaskList";

export async function callClaudeCLI(
  systemPrompt: string,
  userPrompt: string,
  options: ClaudeCLIOptions = {}
): Promise<ClaudeCLIResult> {
  // Note: with OAuth subscription auth (Max), API calls cost $0 but the CLI
  // still computes a virtual cost and enforces this cap. Set generously.
  const maxBudget = options.maxBudgetUsd ?? 1.0;
  const model = options.model || "sonnet";
  const timeoutMs = options.timeoutMs ?? 90_000;

  return new Promise<ClaudeCLIResult>((resolve, reject) => {
    const args = [
      "-p", userPrompt,
      "--append-system-prompt", systemPrompt,
      "--output-format", "json",
      "--model", model,
      "--no-session-persistence",
      "--disallowedTools", DISALLOWED_TOOLS,
      "--max-budget-usd", String(maxBudget),
    ];

    const proc = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => { stdout += d.toString(); });
    proc.stderr.on("data", d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`claude CLI timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`claude CLI spawn failed: ${err.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        return reject(new Error(`claude CLI exit ${code}: ${stderr.slice(0, 300) || stdout.slice(0, 300)}`));
      }
      try {
        const json = JSON.parse(stdout) as {
          result?: string;
          is_error?: boolean;
          usage?: { input_tokens?: number; output_tokens?: number };
          total_cost_usd?: number;
        };

        if (json.is_error) {
          return reject(new Error(`claude CLI returned error: ${json.result || "unknown"}`));
        }

        resolve({
          content: (json.result || "").trim(),
          tokensUsed: (json.usage?.input_tokens || 0) + (json.usage?.output_tokens || 0),
          costUsd: json.total_cost_usd || 0,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reject(new Error(`Bad JSON from claude CLI (${msg}): ${stdout.slice(0, 200)}`));
      }
    });
  });
}

/** Strip ```json fences and trim, in case the model wraps its output. */
export function stripCodeFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```json")) t = t.slice(7);
  else if (t.startsWith("```")) t = t.slice(3);
  if (t.endsWith("```")) t = t.slice(0, -3);
  return t.trim();
}
