<p align="center">
  <img src="images/claudeclaw-banner.svg" alt="ClaudeClaw Banner" />
</p>

<p align="center"><b>Autonomous AI daemon — turns Claude Code into a persistent familiar that lives in your terminal and your chat apps.</b></p>

---

## What is ClaudeClaw?

ClaudeClaw wraps Claude Code with persistent identity, multi-channel communication, memory, scheduling, and integrations. It runs as a background daemon, responding to messages across platforms, executing scheduled tasks, controlling smart home devices, and maintaining context across sessions.

## Architecture

```
                              ClaudeClaw Daemon
                    ┌──────────────────────────────────┐
                    │         Core Runtime             │
                    │  ┌────────────┐  ┌────────────┐  │
                    │  │  Runner    │  │  Queue     │  │
                    │  │  (session  │  │  (serial + │  │
                    │  │   resume)  │  │  overflow) │  │
                    │  └────────────┘  └────────────┘  │
                    │  ┌────────────┐  ┌────────────┐  │
                    │  │ Scheduler  │  │  State     │  │
                    │  │ (cron +    │  │  Manager   │  │
                    │  │  heartbeat)│  │  (.json)   │  │
                    │  └────────────┘  └────────────┘  │
                    └──────────┬───────────────────────┘
                               │
          ┌────────────────────┼────────────────────────┐
          │                    │                        │
  ┌───────▼───────┐   ┌───────▼───────┐       ┌───────▼───────┐
  │ Communication │   │    Memory     │       │  Integrations │
  │   Channels    │   │   Systems     │       │   & Tools     │
  ├───────────────┤   ├───────────────┤       ├───────────────┤
  │ Discord       │   │ CLAUDE.md     │       │ Home Asst.    │
  │ Telegram      │   │ (identity)    │       │ CalDAV        │
  │ Slack         │   │               │       │ Notion        │
  │ WhatsApp      │   │ Observations  │       │ Obsidian      │
  │ Matrix        │   │ (SQLite+FTS)  │       │ Browser       │
  │ Alexa         │   │               │       │ MCP Servers   │
  │               │   │ claude-mem    │       │ Whisper STT   │
  │               │   │ (semantic)    │       │ Dev Sessions  │
  └───────────────┘   └───────────────┘       └───────────────┘
```

## Features

### Communication (6 Channels)
- **Discord** — Gateway WebSocket, DMs, server messages, slash commands, voice transcription, streaming responses
- **Telegram** — Bot API, text/image/voice, markdown formatting, reactions
- **Slack** — Bolt + Socket Mode, channels, threads, slash commands
- **WhatsApp** — whatsapp-web.js, individual & group chats, voice transcription
- **Matrix** — SDK integration, room/DM support, user filtering
- **Alexa** — ASK SDK, voice skill with progressive responses

### Heartbeat & Scheduling
- **Heartbeat** — configurable interval (default 15min), custom prompts, quiet hours, timezone-aware
- **Cron Jobs** — standard 5-field cron, YAML+markdown format, recurring/one-shot, parallel execution

### Memory & Persistence
- **CLAUDE.md** — persistent identity, user context, preferences across sessions
- **Observations DB** — SQLite + FTS5 full-text search, activity logging
- **claude-mem** — semantic search across all stored observations
- **Session Resume** — continuous context via `--resume` flag

### Parallelism
- **Queue System** — serialized main queue + overflow sessions for concurrent work
- **Dev Sessions** — SSH into remote servers, launch autonomous Claude Code in `screen`
- **Subagents** — specialized agents for focused parallel tasks

### Integrations
- **Home Assistant** — device control, state queries, scenes, entity history
- **CalDAV** — events CRUD, agenda view (Nextcloud, Google, iCloud)
- **Notion** — pages, databases, search, content management
- **Obsidian** — vault access, note search, create, edit
- **Browser** — Puppeteer automation, screenshots, form interaction
- **MCP Servers** — extensible tool access (Atlassian, Trello, Supabase, trading APIs, etc.)

### Voice
- **Whisper.cpp** — local speech-to-text, auto-downloaded models
- Cross-platform binaries (Linux/macOS, x64/arm64)
- OGG/MP3/WAV/M4A support

### Security
- Four levels: locked, strict, moderate, unrestricted
- Per-platform user whitelisting
- Project directory scope enforcement

### System
- **Web Dashboard** — real-time SSE activity feed, job management, settings
- **Status Line** — terminal status bar with daemon health, heartbeat countdown, platform indicators
- **Auto-Update** — GitHub release checking, automatic plugin installation
- **Skills System** — modular capabilities as SKILL.md files

## Quick Start

```bash
claude plugin marketplace add moazbuilds/claudeclaw
claude plugin install claudeclaw
```

Then in Claude Code:
```
/claudeclaw:start
```

The setup wizard configures heartbeat, communication channels, and security — then your daemon goes live.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun (TypeScript) |
| AI | Claude Code CLI (session resume) |
| Database | SQLite + FTS5 |
| Voice | Whisper.cpp |
| Browser | Puppeteer-core |
| Calendar | tsdav (CalDAV) |
| Scheduling | Custom cron parser |

## Full Feature Documentation

See [FEATURES.md](FEATURES.md) for the complete feature reference with architecture diagrams and detailed descriptions.

## Credits

Based on [ClaudeClaw](https://github.com/moazbuilds/claudeclaw) by [@moazbuilds](https://github.com/moazbuilds).
