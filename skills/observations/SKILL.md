---
name: observations
description: >
  Search and browse Claw's observation history — a local SQLite-backed
  log of everything Claw has done across sessions. Trigger phrases include
  "observations", "what have you done", "activity log", "past actions",
  "/observations search", "/observations recent", "/observations timeline",
  "/observations stats", "show me your history", "what did you do".
---

# Observations

Search and browse Claw's cross-session observation history stored in `.claude/claudeclaw/observations.db`.

## Commands

Use `$ARGUMENTS` to determine which subcommand to run.

### /observations search <query>

Search past observations by text.

```bash
bun run src/observations.ts search $QUERY
```

Display the results. If no results found, say so. Keep output concise.

### /observations recent [limit]

Show the most recent observations. Default limit is 20.

```bash
bun run src/observations.ts recent $LIMIT
```

### /observations timeline [since]

Show a chronological timeline of activity. Optionally pass an ISO date to filter (e.g., `2026-03-17`).

```bash
bun run src/observations.ts timeline $SINCE
```

### /observations stats

Show observation statistics — total count, breakdown by type, date range.

```bash
bun run src/observations.ts stats
```

### /observations record <type> <title> [summary]

Manually record an observation. Types: heartbeat, job, message, tool_use, error, system, custom.

```bash
bun run src/observations.ts record $TYPE "$TITLE" "$SUMMARY"
```

## Notes

- The database is at `.claude/claudeclaw/observations.db` (SQLite, WAL mode)
- Observations are recorded automatically by the daemon after heartbeats, jobs, and messages
- Text search uses SQLite FTS5 for fast full-text matching
- All timestamps are UTC in the database, displayed in Europe/Berlin
- The CLI module is at `src/observations.ts` — run directly with `bun run`
