# ClaudeClaw — Feature Overview

ClaudeClaw is an autonomous AI daemon that wraps Claude Code with persistent identity, multi-channel communication, memory, scheduling, and smart home integration. It turns Claude from a one-shot CLI tool into a always-on familiar that lives in your terminal and your chat apps.

---

## Architecture Diagram

```
                                    ClaudeClaw Daemon
                          ┌──────────────────────────────────┐
                          │         Core Runtime             │
                          │  ┌────────────┐  ┌────────────┐  │
                          │  │  Runner     │  │  Queue     │  │
                          │  │  (session   │  │  (serial + │  │
                          │  │   resume)   │  │  overflow) │  │
                          │  └────────────┘  └────────────┘  │
                          │  ┌────────────┐  ┌────────────┐  │
                          │  │ Scheduler  │  │  State     │  │
                          │  │ (cron +    │  │  Manager   │  │
                          │  │  heartbeat)│  │  (.json)   │  │
                          │  └────────────┘  └────────────┘  │
                          └──────────┬───────────────────────┘
                                     │
            ┌────────────────────────┼────────────────────────┐
            │                        │                        │
    ┌───────▼───────┐       ┌───────▼───────┐       ┌───────▼───────┐
    │ Communication │       │    Memory     │       │  Integrations │
    │   Channels    │       │   Systems    │       │   & Tools     │
    ├───────────────┤       ├──────────────┤       ├───────────────┤
    │ Discord       │       │ CLAUDE.md    │       │ Home Asst.    │
    │ Telegram      │       │ (identity)   │       │ CalDAV        │
    │ Slack         │       │              │       │ Notion        │
    │ WhatsApp      │       │ Observations │       │ Obsidian      │
    │ Matrix        │       │ (SQLite+FTS) │       │ Browser       │
    │ Alexa         │       │              │       │ MCP Servers   │
    │               │       │ claude-mem   │       │ Whisper STT   │
    │               │       │ (semantic)   │       │ Dev Sessions  │
    └───────────────┘       └──────────────┘       └───────────────┘
```

---

## 1. Heartbeat System

The heartbeat is ClaudeClaw's pulse — a periodic self-check that keeps the daemon aware and responsive.

- **Configurable interval** (default 15min)
- **Custom prompt** — inline text or external `.md`/`.prompt` file
- **Quiet hours** — time windows and weekdays to suppress heartbeats
- **Timezone-aware** scheduling
- **Automatic forwarding** to chat channels
- **`HEARTBEAT_OK` convention** — if nothing needs attention, respond with just this string; only message the user when something genuinely requires it

---

## 2. Memory & Persistence

ClaudeClaw maintains continuity across sessions through multiple memory layers:

### CLAUDE.md (Identity & Context)
- Lives at project root, loaded every session
- Managed blocks (`claudeclaw:managed:start/end`) for auto-injected config
- Stores: identity (Claw), user info, preferences, behavioral rules

### Observations Database
- **SQLite + FTS5** at `.claude/claudeclaw/observations.db`
- Types: `heartbeat`, `job`, `message`, `tool_use`, `error`, `system`, `custom`
- Full-text search with time-range queries
- Fire-and-forget async recording (never blocks execution)

### claude-mem (Semantic Search)
- Optional HTTP worker at `127.0.0.1:37777`
- Records observations with automatic fact extraction
- **Semantic search** across all stored observations
- **Timeline view** for chronological context
- Graceful degradation if worker is down

### Session Management
- Global session tracking (`session.json`)
- Session resume via `--resume` flag for context continuity
- Session backup with incremental indexing
- Clean session reset on daemon restart

---

## 3. Parallelism & Execution

### Queue System
- **Main queue** — serializes access to the persistent Claude session
- **Overflow sessions** — ephemeral sessions spawn when main queue is busy >60s
- **Interactive bypass** — user messages skip queue when threshold exceeded

### Execution Modes
| Mode | Behavior |
|------|----------|
| `run()` | Standard execution, resumes existing session |
| `runParallel()` | Fire-and-forget background task |
| `runInteractive()` | Blocking, user-facing execution |
| `runInteractiveStreaming()` | Progressive message updates with streaming |

### Dev Sessions (Remote)
- SSH into remote servers
- Launch Claude Code in detached `screen` sessions
- `--dangerously-skip-permissions` for fully autonomous operation
- Progress monitoring via log files
- Multiple simultaneous remote sessions

### Subagents
- Specialized agents for focused tasks (code review, exploration, planning)
- Isolated worktree support for parallel code changes
- Background execution with completion notifications

---

## 4. Communication Channels

ClaudeClaw connects to 6 chat platforms simultaneously:

```
┌──────────┬────────────┬───────────┬──────────┬─────────┬─────────┐
│ Discord  │ Telegram   │ Slack     │ WhatsApp │ Matrix  │ Alexa   │
├──────────┼────────────┼───────────┼──────────┼─────────┼─────────┤
│ Gateway  │ Bot API    │ Bolt +    │ web.js   │ SDK     │ ASK SDK │
│ WebSocket│ (raw HTTP) │ Socket    │          │         │         │
│ v10      │            │ Mode      │          │         │         │
├──────────┴────────────┴───────────┴──────────┴─────────┴─────────┤
│ Shared capabilities across all channels:                         │
│  - Text messages (send/receive)                                  │
│  - Voice transcription (Whisper STT)                             │
│  - Image attachments                                             │
│  - Streaming/progressive responses                               │
│  - User authorization (whitelist)                                │
│  - Reaction directives [react:emoji]                             │
│  - Channel/room listening                                        │
└──────────────────────────────────────────────────────────────────┘
```

### Key Capabilities
- **Streaming responses** — progressive message updates as Claude thinks
- **Voice transcription** — Whisper.cpp with auto-downloaded models, OGG→WAV conversion
- **Reaction directives** — `[react:emoji]` syntax for native platform reactions
- **User filtering** — per-platform authorization (user IDs, phone numbers)
- **Activity feed** — real-time SSE broadcast + optional Discord activity channel

---

## 5. Tool Usage & MCP Servers

ClaudeClaw extends Claude's capabilities through Model Context Protocol servers:

### Currently Configured MCP Servers
- **Atlassian** — Jira/Confluence for project management
- **cTrader** — FIX 4.4 protocol for trading portfolio access
- **SaxoTrader** — REST API for Saxo Bank portfolio + trade history
- **Supabase** — Database management
- **Trello** — Board/card management
- **Context7** — Library documentation lookup
- **Microsoft Learn** — Azure/Microsoft documentation
- **Slack** — Workspace communication
- **Canva** — Design creation and management
- **Miro** — Whiteboard and diagram collaboration

### Built-in Tools
- **Browser automation** — Puppeteer-based, screenshots, form interaction, content extraction
- **File system** — Read, Write, Edit, Glob, Grep
- **Bash execution** — sandboxed shell commands
- **Git operations** — commits, PRs, branch management

---

## 6. Scheduling & Cron

### Cron Jobs
- Standard 5-field cron expressions (`* * * * *`)
- YAML frontmatter + markdown prompt body
- Stored in `.claude/claudeclaw/jobs/`
- Timezone-aware matching
- Recurring or one-shot execution
- Parallel execution flag
- Notification control (`true`/`false`/`"error"`)

### Examples
```yaml
---
schedule: "0 8,13,20 * * *"
recurring: true
notify: true
timezone: Europe/Berlin
---
Send a gratitude reminder to the user.
```

---

## 7. Integrations

| Integration | Protocol | Capabilities |
|-------------|----------|-------------|
| **Home Assistant** | REST API | Device control, state queries, scenes, entity history |
| **CalDAV** | RFC 4791 | Events (CRUD), agenda view, Nextcloud/Google/iCloud |
| **Notion** | REST API | Pages, databases, search, content append |
| **Obsidian** | Filesystem | Note search, create, read, edit, frontmatter parsing |
| **ComfyUI** | REST API | Image generation queue, workflow submission, status monitoring |

---

## 8. Skills System

Skills are modular capabilities defined as `SKILL.md` files with YAML frontmatter:

| Skill | Description |
|-------|-------------|
| `dev-session` | Remote Claude Code sessions on SSH servers |
| `browse` | Browser automation and screenshots |
| `calendar` | CalDAV event management |
| `home` | Home Assistant device control |
| `notes` | Obsidian vault access |
| `notion` | Notion workspace integration |
| `jobs` | Cron job management |
| `observations` | Activity log search |
| `memory-search` | claude-mem semantic search |
| `create-skill` | Create new skills |
| `install-skill` | Install skills from skills.sh |
| `self-update-config` | Update MCP config and restart |
| `restart` | Daemon restart |
| `update` | Auto-update from GitHub |
| `discord` / `telegram` | Channel status and management |
| `alexa-setup` | Voice assistant configuration |

---

## 9. Security & Access Control

```
┌─────────────────────────────────────────┐
│           Security Levels               │
├──────────┬──────────────────────────────┤
│ locked   │ No tool access               │
│ strict   │ Read-only tools              │
│ moderate │ Read + safe write tools      │
│ unrestricted │ Full access              │
├──────────┴──────────────────────────────┤
│ Per-platform user whitelisting          │
│ Project directory scope enforcement     │
│ Alexa signature verification (RSA-SHA1) │
│ Environment-based API token protection  │
└─────────────────────────────────────────┘
```

---

## 10. System Infrastructure

### Web Dashboard
- HTTP server (default `127.0.0.1:4632`)
- Real-time activity feed via Server-Sent Events
- Job management, settings editor, live status

### Auto-Update
- GitHub release checking
- Automatic plugin installation
- Changelog generation from commit history
- SHA-based version comparison

### Status Line
- Terminal status bar showing: daemon status, heartbeat countdown, active jobs, connected platforms
- Unicode box-drawing display
- PID-based health monitoring

### Voice Processing
- **Whisper.cpp** — local speech-to-text
- Platform-specific binaries (Linux/macOS/Windows, x64/arm64)
- Auto-downloaded models from HuggingFace
- OGG→WAV JavaScript conversion
- Fallback to OpenAI-compatible STT API

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun (TypeScript) |
| AI | Claude Code CLI (session resume) |
| Database | SQLite + FTS5 (observations) |
| Communication | WebSocket (Discord), HTTP (Telegram, Slack, HA), web.js (WhatsApp) |
| Voice | Whisper.cpp (native binaries) |
| Browser | Puppeteer-core (Chromium) |
| Calendar | tsdav (CalDAV) |
| MCP | Model Context Protocol servers (stdio/SSE) |
| Scheduling | Custom cron parser with timezone support |
