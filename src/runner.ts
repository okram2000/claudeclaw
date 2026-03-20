import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { getSession, createSession } from "./sessions";
import { getSettings, type ModelConfig, type SecurityConfig, type OverflowConfig } from "./config";
import { buildClockPromptPrefix } from "./timezone";
import { emit as sseEmit } from "./sse";

const LOGS_DIR = join(process.cwd(), ".claude/claudeclaw/logs");
// Resolve prompts relative to the claudeclaw installation, not the project dir
const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");
const HEARTBEAT_PROMPT_FILE = join(PROMPTS_DIR, "heartbeat", "HEARTBEAT.md");
// Project-level prompt overrides live here (gitignored, user-owned)
const PROJECT_PROMPTS_DIR = join(process.cwd(), ".claude", "claudeclaw", "prompts");
const PROJECT_CLAUDE_MD = join(process.cwd(), "CLAUDE.md");
const LEGACY_PROJECT_CLAUDE_MD = join(process.cwd(), ".claude", "CLAUDE.md");
const CLAUDECLAW_BLOCK_START = "<!-- claudeclaw:managed:start -->";
const CLAUDECLAW_BLOCK_END = "<!-- claudeclaw:managed:end -->";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const RATE_LIMIT_PATTERN = /you.ve hit your limit|out of extra usage/i;

// --- Queue with overflow support ---
// The main queue serializes access to the persistent session (--resume).
// When the queue has been busy longer than the overflow threshold,
// interactive messages bypass it and run on ephemeral (no-resume) sessions.

let queue: Promise<unknown> = Promise.resolve();
let queueBusySince: number | null = null; // timestamp when current task started

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const wrapped = async () => {
    queueBusySince = Date.now();
    try {
      return await fn();
    } finally {
      queueBusySince = null;
    }
  };
  const task = queue.then(wrapped, wrapped);
  queue = task.catch(() => {});
  return task;
}

/** How long (ms) the main queue has been busy, or 0 if idle. */
function queueBusyMs(): number {
  return queueBusySince ? Date.now() - queueBusySince : 0;
}

/** Whether the main queue is busy beyond the overflow threshold. */
function shouldOverflow(overflow: OverflowConfig): boolean {
  if (!overflow.enabled) return false;
  const busyMs = queueBusyMs();
  return busyMs > overflow.thresholdSeconds * 1000;
}

function extractRateLimitMessage(stdout: string, stderr: string): string | null {
  const candidates = [stdout, stderr];
  for (const text of candidates) {
    const trimmed = text.trim();
    if (trimmed && RATE_LIMIT_PATTERN.test(trimmed)) return trimmed;
  }
  return null;
}

function sameModelConfig(a: ModelConfig, b: ModelConfig): boolean {
  return a.model.trim().toLowerCase() === b.model.trim().toLowerCase() && a.api.trim() === b.api.trim();
}

function hasModelConfig(value: ModelConfig): boolean {
  return value.model.trim().length > 0 || value.api.trim().length > 0;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") return true;
  const message = String((error as { message?: unknown }).message ?? "");
  return /enoent|no such file or directory/i.test(message);
}

function buildChildEnv(baseEnv: Record<string, string>, model: string, api: string): Record<string, string> {
  const childEnv: Record<string, string> = { ...baseEnv };
  const normalizedModel = model.trim().toLowerCase();

  if (api.trim()) childEnv.ANTHROPIC_AUTH_TOKEN = api.trim();

  if (normalizedModel === "glm") {
    childEnv.ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
    childEnv.API_TIMEOUT_MS = "3000000";
  }

  return childEnv;
}

async function runClaudeOnce(
  baseArgs: string[],
  model: string,
  api: string,
  baseEnv: Record<string, string>
): Promise<{ rawStdout: string; stderr: string; exitCode: number }> {
  const args = [...baseArgs];
  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") args.push("--model", model.trim());

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(baseEnv, model, api),
  });

  const [rawStdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  return {
    rawStdout,
    stderr,
    exitCode: proc.exitCode ?? 1,
  };
}

const PROJECT_DIR = process.cwd();

const DIR_SCOPE_PROMPT = [
  `CRITICAL SECURITY CONSTRAINT: You are scoped to the project directory: ${PROJECT_DIR}`,
  "You MUST NOT read, write, edit, or delete any file outside this directory.",
  "You MUST NOT run bash commands that modify anything outside this directory (no cd /, no /etc, no ~/, no ../.. escapes).",
  "If a request requires accessing files outside the project, refuse and explain why.",
].join("\n");

export async function ensureProjectClaudeMd(): Promise<void> {
  // Preflight-only initialization: never rewrite an existing project CLAUDE.md.
  if (existsSync(PROJECT_CLAUDE_MD)) return;

  const promptContent = (await loadPrompts()).trim();
  const managedBlock = [
    CLAUDECLAW_BLOCK_START,
    promptContent,
    CLAUDECLAW_BLOCK_END,
  ].join("\n");

  let content = "";

  if (existsSync(LEGACY_PROJECT_CLAUDE_MD)) {
    try {
      const legacy = await readFile(LEGACY_PROJECT_CLAUDE_MD, "utf8");
      content = legacy.trim();
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read legacy .claude/CLAUDE.md:`, e);
      return;
    }
  }

  const normalized = content.trim();
  const hasManagedBlock =
    normalized.includes(CLAUDECLAW_BLOCK_START) && normalized.includes(CLAUDECLAW_BLOCK_END);
  const managedPattern = new RegExp(
    `${CLAUDECLAW_BLOCK_START}[\\s\\S]*?${CLAUDECLAW_BLOCK_END}`,
    "m"
  );

  const merged = hasManagedBlock
    ? `${normalized.replace(managedPattern, managedBlock)}\n`
    : normalized
      ? `${normalized}\n\n${managedBlock}\n`
      : `${managedBlock}\n`;

  try {
    await writeFile(PROJECT_CLAUDE_MD, merged, "utf8");
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] Failed to write project CLAUDE.md:`, e);
  }
}

function buildSecurityArgs(security: SecurityConfig): string[] {
  const args: string[] = ["--dangerously-skip-permissions"];

  switch (security.level) {
    case "locked":
      args.push("--tools", "Read,Grep,Glob");
      break;
    case "strict":
      args.push("--disallowedTools", "Bash,WebSearch,WebFetch");
      break;
    case "moderate":
      // all tools available, scoped to project dir via system prompt
      break;
    case "unrestricted":
      // all tools, no directory restriction
      break;
  }

  if (security.allowedTools.length > 0) {
    args.push("--allowedTools", security.allowedTools.join(" "));
  }
  if (security.disallowedTools.length > 0) {
    args.push("--disallowedTools", security.disallowedTools.join(" "));
  }

  return args;
}

/** Load and concatenate all prompt files from the prompts/ directory. */
async function loadPrompts(): Promise<string> {
  const selectedPromptFiles = [
    join(PROMPTS_DIR, "IDENTITY.md"),
    join(PROMPTS_DIR, "USER.md"),
    join(PROMPTS_DIR, "SOUL.md"),
  ];
  const parts: string[] = [];

  for (const file of selectedPromptFiles) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) parts.push(content.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read prompt file ${file}:`, e);
    }
  }

  return parts.join("\n\n");
}

/**
 * Load the heartbeat prompt template.
 * Project-level override takes precedence: place a file at
 * .claude/claudeclaw/prompts/HEARTBEAT.md to fully replace the built-in template.
 */
export async function loadHeartbeatPromptTemplate(): Promise<string> {
  const projectOverride = join(PROJECT_PROMPTS_DIR, "HEARTBEAT.md");
  for (const file of [projectOverride, HEARTBEAT_PROMPT_FILE]) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) return content.trim();
    } catch (e) {
      if (!isNotFoundError(e)) {
        console.warn(`[${new Date().toLocaleTimeString()}] Failed to read heartbeat prompt file ${file}:`, e);
      }
    }
  }
  return "";
}

async function execClaude(name: string, prompt: string): Promise<RunResult> {
  await mkdir(LOGS_DIR, { recursive: true });

  const existing = await getSession();
  const isNew = !existing;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOGS_DIR, `${name}-${timestamp}.log`);

  const { security, model, api, fallback } = getSettings();
  const primaryConfig: ModelConfig = { model, api };
  const fallbackConfig: ModelConfig = {
    model: fallback?.model ?? "",
    api: fallback?.api ?? "",
  };
  const securityArgs = buildSecurityArgs(security);

  console.log(
    `[${new Date().toLocaleTimeString()}] Running: ${name} (${isNew ? "new session" : `resume ${existing.sessionId.slice(0, 8)}`}, security: ${security.level})`
  );

  // New session: use json output to capture Claude's session_id
  // Resumed session: use text output with --resume
  const outputFormat = isNew ? "json" : "text";
  const args = ["claude", "-p", prompt, "--output-format", outputFormat, ...securityArgs];

  if (!isNew) {
    args.push("--resume", existing.sessionId);
  }

  // Build the appended system prompt: prompt files + directory scoping
  // This is passed on EVERY invocation (not just new sessions) because
  // --append-system-prompt does not persist across --resume.
  const promptContent = await loadPrompts();
  const appendParts: string[] = [
    "You are running inside ClaudeClaw.",
  ];
  if (promptContent) appendParts.push(promptContent);

  // Load the project's CLAUDE.md if it exists
  if (existsSync(PROJECT_CLAUDE_MD)) {
    try {
      const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
      if (claudeMd.trim()) appendParts.push(claudeMd.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read project CLAUDE.md:`, e);
    }
  }

  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);
  if (appendParts.length > 0) {
    args.push("--append-system-prompt", appendParts.join("\n\n"));
  }

  // Strip CLAUDECODE env var so child claude processes don't think they're nested
  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const baseEnv = { ...cleanEnv } as Record<string, string>;

  let exec = await runClaudeOnce(args, primaryConfig.model, primaryConfig.api, baseEnv);
  const primaryRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);
  let usedFallback = false;

  if (primaryRateLimit && hasModelConfig(fallbackConfig) && !sameModelConfig(primaryConfig, fallbackConfig)) {
    console.warn(
      `[${new Date().toLocaleTimeString()}] Claude limit reached; retrying with fallback${fallbackConfig.model ? ` (${fallbackConfig.model})` : ""}...`
    );
    exec = await runClaudeOnce(args, fallbackConfig.model, fallbackConfig.api, baseEnv);
    usedFallback = true;
  }

  const rawStdout = exec.rawStdout;
  const stderr = exec.stderr;
  const exitCode = exec.exitCode;
  let stdout = rawStdout;
  let sessionId = existing?.sessionId ?? "unknown";
  const rateLimitMessage = extractRateLimitMessage(rawStdout, stderr);

  if (rateLimitMessage) {
    stdout = rateLimitMessage;
  }

  // For new sessions, parse the JSON to extract session_id and result text
  if (!rateLimitMessage && isNew && exitCode === 0) {
    try {
      const json = JSON.parse(rawStdout);
      sessionId = json.session_id;
      stdout = json.result ?? "";
      // Save the real session ID from Claude Code
      await createSession(sessionId);
      console.log(`[${new Date().toLocaleTimeString()}] Session created: ${sessionId}`);
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to parse session from Claude output:`, e);
    }
  }

  const result: RunResult = {
    stdout,
    stderr,
    exitCode,
  };

  const output = [
    `# ${name}`,
    `Date: ${new Date().toISOString()}`,
    `Session: ${sessionId} (${isNew ? "new" : "resumed"})`,
    `Model config: ${usedFallback ? "fallback" : "primary"}`,
    `Prompt: ${prompt}`,
    `Exit code: ${result.exitCode}`,
    "",
    "## Output",
    stdout,
    ...(stderr ? ["## Stderr", stderr] : []),
  ].join("\n");

  await Bun.write(logFile, output);
  console.log(`[${new Date().toLocaleTimeString()}] Done: ${name} → ${logFile}`);

  return result;
}

export async function run(name: string, prompt: string): Promise<RunResult> {
  return enqueue(() => execClaude(name, prompt));
}

// --- Parallel sessions ---
// Independent Claude sessions that run outside the serialized queue.
// Each gets its own session ID and doesn't block the main queue.

interface ParallelSession {
  id: string;
  name: string;
  startedAt: number;
  proc: ReturnType<typeof Bun.spawn> | null;
  promise: Promise<RunResult>;
}

const activeSessions = new Map<string, ParallelSession>();

function generateSessionId(): string {
  return `par-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function runParallel(name: string, prompt: string): Promise<RunResult> {
  const sessionId = generateSessionId();

  const promise = execClaudeParallel(sessionId, name, prompt);
  const session: ParallelSession = {
    id: sessionId,
    name,
    startedAt: Date.now(),
    proc: null,
    promise,
  };
  activeSessions.set(sessionId, session);

  try {
    const result = await promise;
    return result;
  } finally {
    activeSessions.delete(sessionId);
  }
}

export function listActiveSessions(): Array<{ id: string; name: string; startedAt: number; runningMs: number }> {
  const now = Date.now();
  return Array.from(activeSessions.values()).map((s) => ({
    id: s.id,
    name: s.name,
    startedAt: s.startedAt,
    runningMs: now - s.startedAt,
  }));
}

export function killSession(id: string): boolean {
  const session = activeSessions.get(id);
  if (!session) return false;
  if (session.proc) {
    try { session.proc.kill(); } catch {}
  }
  activeSessions.delete(id);
  return true;
}

async function execClaudeParallel(sessionId: string, name: string, prompt: string): Promise<RunResult> {
  await mkdir(LOGS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOGS_DIR, `${name}-parallel-${timestamp}.log`);

  const { security, model, api, fallback } = getSettings();
  const primaryConfig: ModelConfig = { model, api };
  const fallbackConfig: ModelConfig = {
    model: fallback?.model ?? "",
    api: fallback?.api ?? "",
  };
  const securityArgs = buildSecurityArgs(security);

  console.log(
    `[${new Date().toLocaleTimeString()}] Parallel: ${name} (session ${sessionId}, security: ${security.level})`
  );

  // Always new session with json output — no --resume (independent session)
  const args = ["claude", "-p", prompt, "--output-format", "json", ...securityArgs];

  const promptContent = await loadPrompts();
  const appendParts: string[] = [
    "You are running inside ClaudeClaw.",
    "This is a parallel session — you have your own independent context. Focus on the current task.",
  ];
  if (promptContent) appendParts.push(promptContent);

  if (existsSync(PROJECT_CLAUDE_MD)) {
    try {
      const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
      if (claudeMd.trim()) appendParts.push(claudeMd.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read project CLAUDE.md:`, e);
    }
  }

  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);
  if (appendParts.length > 0) {
    args.push("--append-system-prompt", appendParts.join("\n\n"));
  }

  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const baseEnv = { ...cleanEnv } as Record<string, string>;

  let exec = await runClaudeOnceTracked(sessionId, args, primaryConfig.model, primaryConfig.api, baseEnv);
  const primaryRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);
  let usedFallback = false;

  if (primaryRateLimit && hasModelConfig(fallbackConfig) && !sameModelConfig(primaryConfig, fallbackConfig)) {
    console.warn(
      `[${new Date().toLocaleTimeString()}] Claude limit reached (parallel); retrying with fallback${fallbackConfig.model ? ` (${fallbackConfig.model})` : ""}...`
    );
    exec = await runClaudeOnceTracked(sessionId, args, fallbackConfig.model, fallbackConfig.api, baseEnv);
    usedFallback = true;
  }

  let stdout = exec.rawStdout;
  const stderr = exec.stderr;
  const exitCode = exec.exitCode;
  const rateLimitMessage = extractRateLimitMessage(stdout, stderr);

  if (rateLimitMessage) {
    stdout = rateLimitMessage;
  } else if (exitCode === 0) {
    try {
      const json = JSON.parse(exec.rawStdout);
      stdout = json.result ?? "";
    } catch {
      // leave stdout as raw
    }
  }

  const result: RunResult = { stdout, stderr, exitCode };

  const output = [
    `# ${name}`,
    `Date: ${new Date().toISOString()}`,
    `Session: ${sessionId} (parallel)`,
    `Model config: ${usedFallback ? "fallback" : "primary"}`,
    `Prompt: ${prompt}`,
    `Exit code: ${result.exitCode}`,
    "",
    "## Output",
    stdout,
    ...(stderr ? ["## Stderr", stderr] : []),
  ].join("\n");

  await Bun.write(logFile, output);
  console.log(`[${new Date().toLocaleTimeString()}] Done (parallel): ${name} → ${logFile}`);

  return result;
}

/** Like runClaudeOnce but tracks the spawned process in activeSessions for killability. */
async function runClaudeOnceTracked(
  sessionId: string,
  baseArgs: string[],
  model: string,
  api: string,
  baseEnv: Record<string, string>
): Promise<{ rawStdout: string; stderr: string; exitCode: number }> {
  const args = [...baseArgs];
  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") args.push("--model", model.trim());

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(baseEnv, model, api),
  });

  // Track the process so killSession() can terminate it
  const session = activeSessions.get(sessionId);
  if (session) session.proc = proc;

  const [rawStdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  // Clear proc reference after completion
  if (session) session.proc = null;

  return {
    rawStdout,
    stderr,
    exitCode: proc.exitCode ?? 1,
  };
}

function prefixUserMessageWithClock(prompt: string): string {
  try {
    const settings = getSettings();
    const prefix = buildClockPromptPrefix(new Date(), settings.timezoneOffsetMinutes);
    return `${prefix}\n${prompt}`;
  } catch {
    const prefix = buildClockPromptPrefix(new Date(), 0);
    return `${prefix}\n${prompt}`;
  }
}

export async function runUserMessage(name: string, prompt: string): Promise<RunResult> {
  return run(name, prefixUserMessageWithClock(prompt));
}

// --- Ephemeral overflow sessions ---
// These run without --resume, creating a throwaway session.
// Used when the main queue is busy and an interactive message needs immediate attention.

async function execClaudeEphemeral(name: string, prompt: string): Promise<RunResult> {
  await mkdir(LOGS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOGS_DIR, `${name}-ephemeral-${timestamp}.log`);

  const { security, model, api, fallback } = getSettings();
  const primaryConfig: ModelConfig = { model, api };
  const fallbackConfig: ModelConfig = {
    model: fallback?.model ?? "",
    api: fallback?.api ?? "",
  };
  const securityArgs = buildSecurityArgs(security);

  console.log(
    `[${new Date().toLocaleTimeString()}] Overflow: ${name} (ephemeral session, security: ${security.level})`
  );

  // Always new session with json output — no --resume
  const args = ["claude", "-p", prompt, "--output-format", "json", ...securityArgs];

  const promptContent = await loadPrompts();
  const appendParts: string[] = [
    "You are running inside ClaudeClaw.",
    "This is an ephemeral overflow session — you do NOT have conversation history from prior messages. Focus on the current request.",
  ];
  if (promptContent) appendParts.push(promptContent);

  if (existsSync(PROJECT_CLAUDE_MD)) {
    try {
      const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
      if (claudeMd.trim()) appendParts.push(claudeMd.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read project CLAUDE.md:`, e);
    }
  }

  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);
  if (appendParts.length > 0) {
    args.push("--append-system-prompt", appendParts.join("\n\n"));
  }

  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const baseEnv = { ...cleanEnv } as Record<string, string>;

  let exec = await runClaudeOnce(args, primaryConfig.model, primaryConfig.api, baseEnv);
  const primaryRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);
  let usedFallback = false;

  if (primaryRateLimit && hasModelConfig(fallbackConfig) && !sameModelConfig(primaryConfig, fallbackConfig)) {
    console.warn(
      `[${new Date().toLocaleTimeString()}] Claude limit reached (overflow); retrying with fallback${fallbackConfig.model ? ` (${fallbackConfig.model})` : ""}...`
    );
    exec = await runClaudeOnce(args, fallbackConfig.model, fallbackConfig.api, baseEnv);
    usedFallback = true;
  }

  let stdout = exec.rawStdout;
  const stderr = exec.stderr;
  const exitCode = exec.exitCode;
  const rateLimitMessage = extractRateLimitMessage(stdout, stderr);

  if (rateLimitMessage) {
    stdout = rateLimitMessage;
  } else if (exitCode === 0) {
    // Parse JSON output — but do NOT save the session ID (ephemeral)
    try {
      const json = JSON.parse(exec.rawStdout);
      stdout = json.result ?? "";
    } catch {
      // leave stdout as raw
    }
  }

  const result: RunResult = { stdout, stderr, exitCode };

  const output = [
    `# ${name}`,
    `Date: ${new Date().toISOString()}`,
    `Session: ephemeral (overflow)`,
    `Model config: ${usedFallback ? "fallback" : "primary"}`,
    `Prompt: ${prompt}`,
    `Exit code: ${result.exitCode}`,
    "",
    "## Output",
    stdout,
    ...(stderr ? ["## Stderr", stderr] : []),
  ].join("\n");

  await Bun.write(logFile, output);
  console.log(`[${new Date().toLocaleTimeString()}] Done (overflow): ${name} → ${logFile}`);

  return result;
}

async function execClaudeEphemeralStreaming(
  name: string,
  prompt: string,
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<RunResult> {
  await mkdir(LOGS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOGS_DIR, `${name}-ephemeral-${timestamp}.log`);

  const { security, model, api, fallback } = getSettings();
  const primaryConfig: ModelConfig = { model, api };
  const fallbackConfig: ModelConfig = {
    model: fallback?.model ?? "",
    api: fallback?.api ?? "",
  };
  const securityArgs = buildSecurityArgs(security);

  console.log(
    `[${new Date().toLocaleTimeString()}] Overflow streaming: ${name} (ephemeral, security: ${security.level})`
  );

  // No --resume, always stream-json
  const args = ["claude", "-p", prompt, "--output-format", "stream-json", ...securityArgs];

  const promptContent = await loadPrompts();
  const appendParts: string[] = [
    "You are running inside ClaudeClaw.",
    "This is an ephemeral overflow session — you do NOT have conversation history from prior messages. Focus on the current request.",
  ];
  if (promptContent) appendParts.push(promptContent);
  if (existsSync(PROJECT_CLAUDE_MD)) {
    try {
      const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
      if (claudeMd.trim()) appendParts.push(claudeMd.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read project CLAUDE.md:`, e);
    }
  }
  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);
  if (appendParts.length > 0) args.push("--append-system-prompt", appendParts.join("\n\n"));

  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const baseEnv = { ...cleanEnv } as Record<string, string>;
  const childEnv = buildChildEnv(baseEnv, primaryConfig.model, primaryConfig.api);
  const normalizedModel = primaryConfig.model.trim().toLowerCase();
  const fullArgs = [...args];
  if (primaryConfig.model.trim() && normalizedModel !== "glm") {
    fullArgs.push("--model", primaryConfig.model.trim());
  }

  const proc = Bun.spawn(fullArgs, { stdout: "pipe", stderr: "pipe", env: childEnv });
  const stderrPromise = new Response(proc.stderr).text();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let finalResultText = "";
  let resultIsError = false;

  try {
    while (true) {
      if (signal?.aborted) { proc.kill(); break; }
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (event.type === "assistant" && event.message?.content) {
            const text = extractAssistantText(event.message.content);
            if (text) onText(text);
          } else if (event.type === "result") {
            finalResultText = String(event.result ?? "");
            resultIsError = event.is_error ?? false;
          }
        } catch {}
      }
    }
    if (lineBuffer.trim()) {
      try {
        const event = JSON.parse(lineBuffer.trim());
        if (event.type === "result") {
          finalResultText = String(event.result ?? "");
          resultIsError = event.is_error ?? false;
        }
      } catch {}
    }
  } finally {
    reader.releaseLock();
  }

  await proc.exited;
  const stderr = await stderrPromise;
  const exitCode = proc.exitCode ?? 1;

  let stdout = finalResultText;
  const rateLimitMessage = extractRateLimitMessage(stdout, stderr);
  let usedFallback = false;

  if (rateLimitMessage && hasModelConfig(fallbackConfig) && !sameModelConfig(primaryConfig, fallbackConfig)) {
    console.warn(`[${new Date().toLocaleTimeString()}] Claude limit reached (overflow streaming); retrying with fallback...`);
    const fbArgs = [...args];
    if (fallbackConfig.model.trim() && fallbackConfig.model.trim().toLowerCase() !== "glm") {
      fbArgs.push("--model", fallbackConfig.model.trim());
    }
    const fbExec = await runClaudeOnce(fbArgs, fallbackConfig.model, fallbackConfig.api, baseEnv);
    const parsed = parseStreamJsonOutput(fbExec.rawStdout);
    stdout = parsed.text || extractRateLimitMessage(fbExec.rawStdout, fbExec.stderr) || fbExec.rawStdout;
    usedFallback = true;
    if (stdout) onText(stdout);
  }

  const result: RunResult = { stdout, stderr, exitCode };

  const output = [
    `# ${name}`,
    `Date: ${new Date().toISOString()}`,
    `Session: ephemeral (overflow) [streaming]`,
    `Model config: ${usedFallback ? "fallback" : "primary"}`,
    `Prompt: ${prompt}`,
    `Exit code: ${result.exitCode}`,
    "",
    "## Output",
    stdout,
    ...(stderr ? ["## Stderr", stderr] : []),
  ].join("\n");

  await Bun.write(logFile, output);
  console.log(`[${new Date().toLocaleTimeString()}] Done (overflow streaming): ${name} → ${logFile}`);

  return result;
}

// --- Interactive run functions (overflow-aware) ---
// These check if the main queue is busy. If it's been busy longer than
// the configured threshold, they bypass the queue and run ephemerally.

export async function runInteractive(name: string, prompt: string): Promise<RunResult> {
  sseEmit("message_received", `Message from ${name}`, { source: name, preview: prompt.slice(0, 120) });
  const { overflow } = getSettings();
  let result: RunResult;
  if (shouldOverflow(overflow)) {
    const busySec = Math.round(queueBusyMs() / 1000);
    console.log(`[${new Date().toLocaleTimeString()}] Main queue busy for ${busySec}s > ${overflow.thresholdSeconds}s threshold — using ephemeral overflow`);
    result = await execClaudeEphemeral(name, prefixUserMessageWithClock(prompt));
  } else {
    result = await enqueue(() => execClaude(name, prefixUserMessageWithClock(prompt)));
  }
  sseEmit("message_response", `Response to ${name}`, { source: name, exitCode: result.exitCode, preview: result.stdout.slice(0, 200) });
  return result;
}

export async function runInteractiveStreaming(
  name: string,
  prompt: string,
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<RunResult> {
  sseEmit("message_received", `Message from ${name}`, { source: name, preview: prompt.slice(0, 120) });
  const { overflow } = getSettings();
  let result: RunResult;
  if (shouldOverflow(overflow)) {
    const busySec = Math.round(queueBusyMs() / 1000);
    console.log(`[${new Date().toLocaleTimeString()}] Main queue busy for ${busySec}s > ${overflow.thresholdSeconds}s threshold — using ephemeral overflow (streaming)`);
    result = await execClaudeEphemeralStreaming(name, prefixUserMessageWithClock(prompt), onText, signal);
  } else {
    result = await enqueue(() => execClaudeStreaming(name, prefixUserMessageWithClock(prompt), onText, signal));
  }
  sseEmit("message_response", `Response to ${name}`, { source: name, exitCode: result.exitCode, preview: result.stdout.slice(0, 200) });
  return result;
}

// --- Streaming support ---

/** Parse NDJSON stream-json output and extract the final result text + session_id. */
function parseStreamJsonOutput(rawOutput: string): { text: string; sessionId: string | null; isError: boolean } {
  let text = "";
  let sessionId: string | null = null;
  let isError = false;
  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event.type === "result") {
        text = String(event.result ?? "");
        sessionId = typeof event.session_id === "string" ? event.session_id : null;
        isError = event.is_error ?? false;
      }
    } catch {
      // not JSON
    }
  }
  return { text, sessionId, isError };
}

/** Extract visible text from an assistant event's content array. */
function extractAssistantText(content: unknown[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text as string)
    .join("");
}

async function execClaudeStreaming(
  name: string,
  prompt: string,
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<RunResult> {
  await mkdir(LOGS_DIR, { recursive: true });

  const existing = await getSession();
  const isNew = !existing;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOGS_DIR, `${name}-${timestamp}.log`);

  const { security, model, api, fallback } = getSettings();
  const primaryConfig: ModelConfig = { model, api };
  const fallbackConfig: ModelConfig = {
    model: fallback?.model ?? "",
    api: fallback?.api ?? "",
  };
  const securityArgs = buildSecurityArgs(security);

  console.log(
    `[${new Date().toLocaleTimeString()}] Streaming: ${name} (${isNew ? "new session" : `resume ${existing!.sessionId.slice(0, 8)}`}, security: ${security.level})`
  );

  // Always use stream-json — gives us the session_id in the result event
  const args = ["claude", "-p", prompt, "--output-format", "stream-json", ...securityArgs];
  if (!isNew) args.push("--resume", existing!.sessionId);

  const promptContent = await loadPrompts();
  const appendParts: string[] = ["You are running inside ClaudeClaw."];
  if (promptContent) appendParts.push(promptContent);
  if (existsSync(PROJECT_CLAUDE_MD)) {
    try {
      const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
      if (claudeMd.trim()) appendParts.push(claudeMd.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read project CLAUDE.md:`, e);
    }
  }
  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);
  if (appendParts.length > 0) args.push("--append-system-prompt", appendParts.join("\n\n"));

  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const baseEnv = { ...cleanEnv } as Record<string, string>;

  const childEnv = buildChildEnv(baseEnv, primaryConfig.model, primaryConfig.api);
  const normalizedModel = primaryConfig.model.trim().toLowerCase();
  const fullArgs = [...args];
  if (primaryConfig.model.trim() && normalizedModel !== "glm") {
    fullArgs.push("--model", primaryConfig.model.trim());
  }

  const proc = Bun.spawn(fullArgs, { stdout: "pipe", stderr: "pipe", env: childEnv });

  const stderrPromise = new Response(proc.stderr).text();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let finalResultText = "";
  let resultSessionId: string | null = null;
  let resultIsError = false;

  try {
    while (true) {
      if (signal?.aborted) {
        proc.kill();
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;

      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (event.type === "assistant" && event.message?.content) {
            const text = extractAssistantText(event.message.content);
            if (text) onText(text);
          } else if (event.type === "result") {
            finalResultText = String(event.result ?? "");
            resultSessionId = typeof event.session_id === "string" ? event.session_id : null;
            resultIsError = event.is_error ?? false;
          }
        } catch {
          // not JSON
        }
      }
    }
    // Process any remaining buffer
    if (lineBuffer.trim()) {
      try {
        const event = JSON.parse(lineBuffer.trim());
        if (event.type === "result") {
          finalResultText = String(event.result ?? "");
          resultSessionId = typeof event.session_id === "string" ? event.session_id : null;
          resultIsError = event.is_error ?? false;
        }
      } catch {}
    }
  } finally {
    reader.releaseLock();
  }

  await proc.exited;
  const stderr = await stderrPromise;
  const exitCode = proc.exitCode ?? 1;

  // Handle session creation for new sessions
  if (isNew && resultSessionId) {
    await createSession(resultSessionId);
    console.log(`[${new Date().toLocaleTimeString()}] Session created (streaming): ${resultSessionId}`);
  }

  let stdout = finalResultText;

  // Rate limit detection → retry with fallback (non-streaming)
  const rateLimitMessage = extractRateLimitMessage(stdout, stderr);
  let usedFallback = false;
  if (rateLimitMessage && hasModelConfig(fallbackConfig) && !sameModelConfig(primaryConfig, fallbackConfig)) {
    console.warn(
      `[${new Date().toLocaleTimeString()}] Claude limit reached (streaming); retrying with fallback...`
    );
    const fbArgs = [...args];
    if (fallbackConfig.model.trim() && fallbackConfig.model.trim().toLowerCase() !== "glm") {
      fbArgs.push("--model", fallbackConfig.model.trim());
    }
    const fbExec = await runClaudeOnce(fbArgs, fallbackConfig.model, fallbackConfig.api, baseEnv);
    const parsed = parseStreamJsonOutput(fbExec.rawStdout);
    stdout = parsed.text || extractRateLimitMessage(fbExec.rawStdout, fbExec.stderr) || fbExec.rawStdout;
    if (parsed.sessionId && isNew) {
      await createSession(parsed.sessionId);
    }
    usedFallback = true;
    // Notify caller with the fallback result so the platform can update
    if (stdout) onText(stdout);
  }

  const result: RunResult = { stdout, stderr, exitCode };

  const sessionIdForLog = resultSessionId ?? existing?.sessionId ?? "unknown";
  const output = [
    `# ${name}`,
    `Date: ${new Date().toISOString()}`,
    `Session: ${sessionIdForLog} (${isNew ? "new" : "resumed"})`,
    `Model config: ${usedFallback ? "fallback" : "primary"} [streaming]`,
    `Prompt: ${prompt}`,
    `Exit code: ${result.exitCode}`,
    "",
    "## Output",
    stdout,
    ...(stderr ? ["## Stderr", stderr] : []),
  ].join("\n");

  await Bun.write(logFile, output);
  console.log(`[${new Date().toLocaleTimeString()}] Done (streaming): ${name} → ${logFile}`);

  return result;
}

/**
 * Run a user message with streaming output.
 * `onText` is called with accumulated assistant text as it arrives.
 * Returns the final RunResult (stdout = complete response).
 * Falls back to non-streaming on rate limit.
 */
export async function runUserMessageStreaming(
  name: string,
  prompt: string,
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<RunResult> {
  return enqueue(() => execClaudeStreaming(name, prefixUserMessageWithClock(prompt), onText, signal));
}

/**
 * Bootstrap the session: fires Claude with the system prompt so the
 * session is created immediately. No-op if a session already exists.
 */
export async function bootstrap(): Promise<void> {
  const existing = await getSession();
  if (existing) return;

  console.log(`[${new Date().toLocaleTimeString()}] Bootstrapping new session...`);
  await execClaude("bootstrap", "Wakeup, my friend!");
  console.log(`[${new Date().toLocaleTimeString()}] Bootstrap complete — session is live.`);
}
