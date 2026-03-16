---
description: Restart the ClaudeClaw daemon gracefully. Use when the user asks to restart, reboot, or reload the daemon, pick up new configs, or apply changes without re-running setup. Trigger phrases include "restart", "reboot", "reload daemon", "restart claudeclaw", "pick up changes", "/restart".
user_invocable: true
---

# Restart ClaudeClaw

Gracefully restart the ClaudeClaw daemon to pick up code changes, config updates, and plugin modifications — without re-running the initial setup wizard.

## What it does

1. Finds the running daemon process
2. Sends SIGTERM for a graceful shutdown
3. Waits for it to exit
4. Spawns a fresh daemon with the same settings

## Instructions

Run the restart command using bash:

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts restart
```

If the user asks what happens during restart, explain:
- Settings are re-read from `~/.claude/claudeclaw/settings.json`
- All integrations (Discord, Telegram, Slack, etc.) reconnect
- Cron jobs and heartbeat resume automatically
- The Claude session resets (fresh context)
- No setup questions are asked — existing config is preserved

If no daemon is running, tell the user and suggest using `/start` instead.
