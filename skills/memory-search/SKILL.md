---
name: memory-search
version: 1.0.0
description: "Search claude-mem observations from within ClaudeClaw."
metadata:
  openclaw:
    category: "memory"
    requires:
      services: ["claude-mem"]
---

# /memory-search

Search the claude-mem observation store for past context, decisions, and facts.

## Usage

```
/memory-search <query>
```

## How it works

This skill queries the claude-mem worker API at `http://127.0.0.1:37777` to search stored observations. Results include titles, summaries, facts, timestamps, and relevance scores.

## Steps

1. **Check worker availability** — `GET http://127.0.0.1:37777/api/health`
   - If the worker is not running, report that claude-mem is unavailable and suggest starting it.

2. **Search observations** — `GET http://127.0.0.1:37777/api/search/observations?query=<query>&limit=10`

3. **Format and display results:**

For each result, display:

```
<number>. <title> [<project>] (relevance: <score>%)
   <timestamp> — <summary>
   Facts: <fact1>; <fact2>; ...
```

If no results are found, say so clearly.

## Examples

```
/memory-search trading strategy
/memory-search Lilly milestones
/memory-search heartbeat errors
/memory-search comfyui workflow
```

## Implementation

When this skill is invoked, use `curl` or `fetch` to call the API directly:

```bash
# Check health
curl -sf http://127.0.0.1:37777/api/health

# Search
curl -sf "http://127.0.0.1:37777/api/search/observations?query=QUERY&limit=10"
```

Parse the JSON response and format the results as described above. If the worker is unreachable, output:

> claude-mem worker is not running at `http://127.0.0.1:37777`. Start it to enable memory search.

## Optional flags

| Flag | Description |
|------|-------------|
| `--limit <n>` | Max results to return (default: 10) |
| `--project <name>` | Filter results to a specific project |
| `--timeline` | Use timeline endpoint instead of search |

### Timeline mode

When `--timeline` is passed, use the timeline endpoint instead:

```bash
curl -sf "http://127.0.0.1:37777/api/timeline/by-query?query=QUERY"
```

This returns chronologically ordered entries, useful for seeing how something evolved over time.
