/**
 * claude-mem integration for ClaudeClaw
 *
 * HTTP client for the OpenClaw claude-mem worker API.
 * All operations are optional — if the worker isn't running, we log a
 * warning and return gracefully so ClaudeClaw keeps working.
 */

const CLAUDE_MEM_BASE = process.env.CLAUDE_MEM_URL ?? "http://127.0.0.1:37777";
const DEFAULT_TIMEOUT_MS = 5_000;

// ── Types ───────────────────────────────────────────────────────────

export interface Observation {
  id?: string;
  title: string;
  summary: string;
  facts: string[];
  project?: string;
  timestamp?: string;
}

export interface SearchResult {
  id: string;
  title: string;
  summary: string;
  facts: string[];
  project?: string;
  timestamp: string;
  score?: number;
}

export interface TimelineEntry {
  id: string;
  title: string;
  summary: string;
  timestamp: string;
  project?: string;
}

// ── Internal helpers ────────────────────────────────────────────────

let _workerAvailable: boolean | null = null;

async function fetchMem(
  path: string,
  init?: RequestInit & { timeout?: number },
): Promise<Response | null> {
  const timeout = init?.timeout ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${CLAUDE_MEM_BASE}${path}`, {
      ...init,
      signal: controller.signal,
    });
    _workerAvailable = true;
    return res;
  } catch (err: any) {
    if (_workerAvailable !== false) {
      console.warn(
        `[claude-mem] Worker unavailable at ${CLAUDE_MEM_BASE}: ${err.message ?? err}`,
      );
      _workerAvailable = false;
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Health check ────────────────────────────────────────────────────

export async function isWorkerRunning(): Promise<boolean> {
  const res = await fetchMem("/api/health");
  if (!res) return false;
  return res.ok;
}

// ── Record an observation ───────────────────────────────────────────

export async function recordObservation(
  title: string,
  summary: string,
  facts: string[],
  project?: string,
): Promise<Observation | null> {
  const body: Observation = { title, summary, facts };
  if (project) body.project = project;

  const res = await fetchMem("/api/sessions/observations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res) return null;
  if (!res.ok) {
    console.warn(`[claude-mem] recordObservation failed: ${res.status} ${res.statusText}`);
    return null;
  }

  try {
    return (await res.json()) as Observation;
  } catch {
    return body; // return the input as confirmation
  }
}

// ── Search memory ───────────────────────────────────────────────────

export async function searchMemory(
  query: string,
  limit = 10,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ query, limit: String(limit) });
  const res = await fetchMem(`/api/search/observations?${params}`);

  if (!res) return [];
  if (!res.ok) {
    console.warn(`[claude-mem] searchMemory failed: ${res.status}`);
    return [];
  }

  try {
    const data = await res.json();
    return (data.results ?? data) as SearchResult[];
  } catch {
    return [];
  }
}

// ── Recent context ──────────────────────────────────────────────────

export async function getRecentContext(
  project?: string,
  limit = 5,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (project) params.set("project", project);

  const res = await fetchMem(`/api/context/recent?${params}`);

  if (!res) return [];
  if (!res.ok) {
    console.warn(`[claude-mem] getRecentContext failed: ${res.status}`);
    return [];
  }

  try {
    const data = await res.json();
    return (data.results ?? data) as SearchResult[];
  } catch {
    return [];
  }
}

// ── Timeline ────────────────────────────────────────────────────────

export async function getTimeline(query: string): Promise<TimelineEntry[]> {
  const params = new URLSearchParams({ query });
  const res = await fetchMem(`/api/timeline/by-query?${params}`);

  if (!res) return [];
  if (!res.ok) {
    console.warn(`[claude-mem] getTimeline failed: ${res.status}`);
    return [];
  }

  try {
    const data = await res.json();
    return (data.results ?? data) as TimelineEntry[];
  } catch {
    return [];
  }
}

// ── Convenience: format context for prompt injection ────────────────

export function formatContextForPrompt(entries: SearchResult[]): string {
  if (!entries.length) return "";

  const lines = entries.map((e) => {
    const ts = e.timestamp ? new Date(e.timestamp).toLocaleString() : "unknown";
    const facts = e.facts?.length ? `\n  Facts: ${e.facts.join("; ")}` : "";
    return `- [${ts}] ${e.title}: ${e.summary}${facts}`;
  });

  return `## Recent memory context\n${lines.join("\n")}`;
}

// ── Convenience: format search results for display ──────────────────

export function formatSearchResults(results: SearchResult[]): string {
  if (!results.length) return "No results found.";

  return results
    .map((r, i) => {
      const ts = r.timestamp ? new Date(r.timestamp).toLocaleString() : "—";
      const proj = r.project ? ` [${r.project}]` : "";
      const score = r.score != null ? ` (relevance: ${(r.score * 100).toFixed(0)}%)` : "";
      const facts = r.facts?.length ? `\n   Facts: ${r.facts.join("; ")}` : "";
      return `${i + 1}. **${r.title}**${proj}${score}\n   ${ts} — ${r.summary}${facts}`;
    })
    .join("\n\n");
}
