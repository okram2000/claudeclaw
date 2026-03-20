/**
 * Local observation recording system for ClaudeClaw
 *
 * Stores structured observations in a SQLite database for cross-session
 * memory. Uses bun:sqlite for zero-dependency local storage.
 *
 * Each observation captures: timestamp, type, title, summary, and optional
 * metadata. Provides search by text, type, and time range.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

// ── Types ───────────────────────────────────────────────────────────

export type ObservationType =
  | "heartbeat"
  | "job"
  | "message"
  | "tool_use"
  | "error"
  | "system"
  | "custom";

export interface Observation {
  id?: number;
  timestamp: string;
  type: ObservationType;
  title: string;
  summary: string;
  metadata?: string; // JSON string for extra context
}

export interface ObservationQuery {
  text?: string;
  type?: ObservationType;
  since?: string; // ISO timestamp
  until?: string; // ISO timestamp
  limit?: number;
  offset?: number;
}

// ── Database ────────────────────────────────────────────────────────

const DB_DIR = join(process.cwd(), ".claude", "claudeclaw");
const DB_PATH = join(DB_DIR, "observations.db");

let _db: Database | null = null;

function getDb(): Database {
  if (_db) return _db;

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA synchronous = NORMAL");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      type TEXT NOT NULL DEFAULT 'custom',
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      metadata TEXT DEFAULT NULL
    )
  `);

  _db.exec(`
    CREATE INDEX IF NOT EXISTS idx_obs_timestamp ON observations(timestamp DESC)
  `);
  _db.exec(`
    CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(type)
  `);

  // FTS for text search
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      title, summary, content=observations, content_rowid=id
    )
  `);

  // Keep FTS in sync via triggers
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, summary)
      VALUES (new.id, new.title, new.summary);
    END
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, summary)
      VALUES ('delete', old.id, old.title, old.summary);
    END
  `);
  _db.exec(`
    CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, summary)
      VALUES ('delete', old.id, old.title, old.summary);
      INSERT INTO observations_fts(rowid, title, summary)
      VALUES (new.id, new.title, new.summary);
    END
  `);

  return _db;
}

// ── Record ──────────────────────────────────────────────────────────

export function record(
  type: ObservationType,
  title: string,
  summary: string,
  metadata?: Record<string, unknown>,
): number {
  const db = getDb();
  const metaStr = metadata ? JSON.stringify(metadata) : null;
  const stmt = db.prepare(
    "INSERT INTO observations (type, title, summary, metadata) VALUES (?, ?, ?, ?)",
  );
  const result = stmt.run(type, title, summary, metaStr);
  return Number(result.lastInsertRowid);
}

/**
 * Fire-and-forget recording. Logs errors but never throws.
 */
export function recordAsync(
  type: ObservationType,
  title: string,
  summary: string,
  metadata?: Record<string, unknown>,
): void {
  try {
    record(type, title, summary, metadata);
  } catch (err: any) {
    console.warn(`[observations] Failed to record: ${err.message}`);
  }
}

// ── Query ───────────────────────────────────────────────────────────

export function search(query: ObservationQuery): Observation[] {
  const db = getDb();
  const limit = Math.min(query.limit ?? 50, 200);
  const offset = query.offset ?? 0;

  // Full-text search path
  if (query.text) {
    const conditions: string[] = [];
    const params: unknown[] = [];

    // FTS match
    const ftsQuery = query.text
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w}"*`)
      .join(" OR ");

    if (!ftsQuery) return [];

    let sql = `
      SELECT o.id, o.timestamp, o.type, o.title, o.summary, o.metadata
      FROM observations o
      JOIN observations_fts fts ON fts.rowid = o.id
      WHERE observations_fts MATCH ?
    `;
    params.push(ftsQuery);

    if (query.type) {
      sql += " AND o.type = ?";
      params.push(query.type);
    }
    if (query.since) {
      sql += " AND o.timestamp >= ?";
      params.push(query.since);
    }
    if (query.until) {
      sql += " AND o.timestamp <= ?";
      params.push(query.until);
    }

    sql += " ORDER BY o.timestamp DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    return db.prepare(sql).all(...params) as Observation[];
  }

  // Non-text query
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.type) {
    conditions.push("type = ?");
    params.push(query.type);
  }
  if (query.since) {
    conditions.push("timestamp >= ?");
    params.push(query.since);
  }
  if (query.until) {
    conditions.push("timestamp <= ?");
    params.push(query.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT id, timestamp, type, title, summary, metadata FROM observations ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(sql).all(...params) as Observation[];
}

export function recent(limit = 20): Observation[] {
  return search({ limit });
}

export function timeline(since?: string, limit = 50): Observation[] {
  const db = getDb();
  const params: unknown[] = [];
  let sql = `
    SELECT id, timestamp, type, title, summary, metadata
    FROM observations
  `;

  if (since) {
    sql += " WHERE timestamp >= ?";
    params.push(since);
  }

  sql += " ORDER BY timestamp ASC LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params) as Observation[];
}

export function stats(): { total: number; byType: Record<string, number>; earliest: string | null; latest: string | null } {
  const db = getDb();
  const total = (db.prepare("SELECT COUNT(*) as count FROM observations").get() as any).count;
  const byTypeRows = db.prepare("SELECT type, COUNT(*) as count FROM observations GROUP BY type").all() as { type: string; count: number }[];
  const byType: Record<string, number> = {};
  for (const row of byTypeRows) byType[row.type] = row.count;
  const earliest = (db.prepare("SELECT MIN(timestamp) as ts FROM observations").get() as any)?.ts ?? null;
  const latest = (db.prepare("SELECT MAX(timestamp) as ts FROM observations").get() as any)?.ts ?? null;
  return { total, byType, earliest, latest };
}

// ── Formatting ──────────────────────────────────────────────────────

export function formatObservations(obs: Observation[]): string {
  if (!obs.length) return "No observations found.";

  return obs
    .map((o) => {
      const ts = o.timestamp
        ? new Date(o.timestamp + "Z").toLocaleString("en-US", {
            timeZone: "Europe/Berlin",
            dateStyle: "short",
            timeStyle: "short",
          })
        : "?";
      const meta = o.metadata ? ` | ${o.metadata}` : "";
      return `[${ts}] (${o.type}) **${o.title}**\n  ${o.summary || "(no summary)"}`;
    })
    .join("\n\n");
}

export function formatTimeline(obs: Observation[]): string {
  if (!obs.length) return "No activity recorded.";

  let currentDate = "";
  const lines: string[] = [];

  for (const o of obs) {
    const dt = new Date(o.timestamp + "Z");
    const dateStr = dt.toLocaleDateString("en-US", {
      timeZone: "Europe/Berlin",
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const timeStr = dt.toLocaleTimeString("en-US", {
      timeZone: "Europe/Berlin",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    if (dateStr !== currentDate) {
      if (currentDate) lines.push("");
      lines.push(`--- ${dateStr} ---`);
      currentDate = dateStr;
    }

    lines.push(`  ${timeStr}  [${o.type}] ${o.title}`);
    if (o.summary) {
      const short = o.summary.length > 100 ? o.summary.slice(0, 97) + "..." : o.summary;
      lines.push(`          ${short}`);
    }
  }

  return lines.join("\n");
}

export function formatStats(s: ReturnType<typeof stats>): string {
  const lines = [`Total observations: ${s.total}`];
  if (s.earliest) lines.push(`First: ${s.earliest}`);
  if (s.latest) lines.push(`Latest: ${s.latest}`);
  if (Object.keys(s.byType).length > 0) {
    lines.push("By type:");
    for (const [type, count] of Object.entries(s.byType).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${type}: ${count}`);
    }
  }
  return lines.join("\n");
}

// ── CLI entry point ─────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "search" && args[1]) {
    const results = search({ text: args.slice(1).join(" ") });
    console.log(formatObservations(results));
  } else if (cmd === "recent") {
    const limit = args[1] ? parseInt(args[1]) : 20;
    const results = recent(limit);
    console.log(formatObservations(results));
  } else if (cmd === "timeline") {
    const since = args[1] || undefined;
    const results = timeline(since);
    console.log(formatTimeline(results));
  } else if (cmd === "stats") {
    console.log(formatStats(stats()));
  } else if (cmd === "record") {
    // record <type> <title> [summary]
    const type = (args[1] || "custom") as ObservationType;
    const title = args[2] || "manual entry";
    const summary = args.slice(3).join(" ");
    const id = record(type, title, summary);
    console.log(`Recorded observation #${id}`);
  } else {
    console.log("Usage:");
    console.log("  bun run src/observations.ts search <query>");
    console.log("  bun run src/observations.ts recent [limit]");
    console.log("  bun run src/observations.ts timeline [since-iso]");
    console.log("  bun run src/observations.ts stats");
    console.log("  bun run src/observations.ts record <type> <title> [summary]");
  }
}
