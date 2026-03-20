# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClaudeClaw is a daemon plugin for Claude Code that runs prompts on a schedule, responds via Telegram and Discord, transcribes voice, and provides a web dashboard. It runs entirely within a Claude Code subscription — no separate API keys needed.

## Commands

```bash
# Run the daemon
bun run src/index.ts start --trigger --web --replace-existing

# Dev mode (auto-reload on file changes)
bun run dev:web

# One-shot prompt execution
bun run src/index.ts start --prompt "Your prompt"

# Standalone Telegram bot
bun run src/index.ts telegram

# Standalone Discord bot
bun run src/index.ts discord

# Check daemon status
bun run src/index.ts status          # current project
bun run src/index.ts status --all    # all projects

# Stop daemon
bun run src/index.ts --stop
bun run src/index.ts --stop-all

# Clear session state
bun run src/index.ts --clear
```

No test suite or linter is configured. TypeScript is compiled on-the-fly by Bun.

## Architecture

**Runtime:** Bun with TypeScript (ESNext target, ESM modules). Only runtime dependency is `ogg-opus-decoder` for voice message handling.

**Entry point:** `src/index.ts` — CLI dispatcher that routes to command handlers in `src/commands/`.

### Core Components

- **`src/commands/start.ts`** — Daemon lifecycle. Handles one-shot mode, persistent daemon with heartbeat scheduling, cron job execution (60s tick), config hot-reload (30s), Telegram/Discord integration, and web UI startup.

- **`src/runner.ts`** — Spawns Claude Code as a child process. Manages session creation (JSON output) vs resumption (text output with `--resume`). Includes rate-limit detection with automatic fallback model retry. Uses a serial Promise queue to prevent concurrent `--resume` on the same session.

- **`src/config.ts`** — Settings from `.claude/claudeclaw/settings.json`. Exports typed interfaces (`Settings`, `HeartbeatConfig`, `TelegramConfig`, `DiscordConfig`, `SecurityConfig`, `SttConfig`). Supports prompt resolution from file paths (`.md`, `.txt`, `.prompt`).

- **`src/sessions.ts`** — Global session persistence in `.claude/claudeclaw/session.json`. Session is created on first run and reused for context continuity across heartbeats and messages.

- **`src/jobs.ts`** — Parses cron jobs from `.claude/claudeclaw/jobs/*.md` files using YAML frontmatter (schedule, prompt, recurring, notify fields) + markdown body.

- **`src/cron.ts`** — Custom cron expression parser. Supports standard 5-field syntax with ranges, steps, and lists. Timezone-aware.

- **`src/commands/telegram.ts`** — Telegram bot via raw HTTP long-polling (no SDK). Handles text, images, voice messages, callback queries, group chat triggers, and `[react:<emoji>]` syntax for native reactions.

- **`src/commands/discord.ts`** — Discord bot via raw WebSocket gateway (no SDK). Handles text, images, voice messages, slash commands (`/start`, `/reset`), button interactions (secretary workflow), guild triggers (mentions/replies), and `[react:<emoji>]` reactions. Uses Discord Gateway v10 with heartbeat, identify, and resume.

- **`src/whisper.ts`** — Voice transcription via whisper.cpp binaries (auto-downloaded per platform) or external OpenAI-compatible STT API. Handles OGG/Opus to WAV conversion.

- **`src/ui/`** — Web dashboard: HTTP server with REST API (`/api/state`, `/api/settings`, `/api/jobs`, `/api/logs`) and HTML/CSS/JS SPA.

- **`src/statusline.ts`** — Generates `.claude/statusline.cjs` for Claude Code status bar integration.

### Prompt System

Prompt files in `prompts/` are concatenated and appended as system prompt on every Claude invocation:
1. `IDENTITY.md` — Bot name/creature/vibe
2. `USER.md` — User context (name, timezone, notes)
3. `SOUL.md` — Personality and behavior guidelines
4. `heartbeat/HEARTBEAT.md` — Template for heartbeat tasks

### Data Directory Layout

All runtime data lives under `.claude/claudeclaw/`:
- `settings.json` — Configuration
- `session.json` — Active Claude session ID
- `state.json` — Runtime state (next execution times)
- `jobs/*.md` — Cron job definitions (frontmatter + markdown)
- `logs/*.log` — Execution logs
- `whisper/` — Cached whisper binary and model

### Security Model

Four levels control tool access when spawning Claude: `locked` (read-only), `strict` (no Bash/web), `moderate` (all tools, directory-scoped), `unrestricted` (no restrictions). A directory-scope system prompt constrains file access for non-unrestricted levels.

### Key Patterns

- **Config hot-reload:** Daemon re-reads `settings.json` every 30s and restarts timers on change.
- **Serial execution queue:** Promise-chaining in `runner.ts` ensures only one Claude process runs at a time per session.
- **Rate-limit fallback:** If primary model hits limits, automatically retries with configured fallback model.
- **Telegram without SDK:** All Telegram API calls use raw `fetch` against `api.telegram.org`.
- **Discord without SDK:** Discord gateway uses Bun's native `WebSocket`, REST calls use raw `fetch` against `discord.com/api/v10`. Discord user IDs are stored as strings (snowflakes exceed `Number.MAX_SAFE_INTEGER`).
- **Env isolation:** Child Claude processes get a cleaned env (strips `CLAUDECODE` var) to avoid nesting detection.
