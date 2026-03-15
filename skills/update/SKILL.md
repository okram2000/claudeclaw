---
name: update
description: Check for and apply ClaudeClaw updates. Use when the user asks to update claudeclaw, check for updates, upgrade the daemon, install the latest version, rollback an update, or revert claudeclaw. Trigger phrases include "update claudeclaw", "check for updates", "upgrade claudeclaw", "latest version", "/update", "/update check", "/update rollback", "rollback claudeclaw".
---

# ClaudeClaw Update

Manage ClaudeClaw updates based on `$ARGUMENTS`.

## Commands

| Invocation | Action |
|---|---|
| `/update` or `/update apply` | Check for and apply latest update, then restart daemon |
| `/update check` | Check for updates only, show changelog, don't apply |
| `/update rollback` | Revert to previous version (from backup) |
| `/update force` | Force re-apply latest even if already up to date |
| `/update status` | Show current version and update state |

## Steps

### `/update check`
1. Run: `claudeclaw update --check`
2. Report whether an update is available, current SHA, latest SHA, and the changelog.
3. If update is available, suggest running `/update` to apply it.

### `/update` or `/update apply`
1. Run: `claudeclaw update`
2. This will: check for updates → show changelog → download → backup → apply → bun install → restart daemon.
3. Report the outcome (success with new version, or error details).

### `/update force`
1. Run: `claudeclaw update --force`
2. Forces update even if already at latest. Use when you want a clean reinstall.

### `/update rollback`
1. Run: `claudeclaw update --rollback`
2. This reverts to the backup copy saved before the last update.
3. Then restart the daemon: `claudeclaw stop && claudeclaw start`
4. Report success or failure.

### `/update status`
1. Read `.claude/claudeclaw/update-state.json` to show:
   - Current SHA
   - Last check time
   - Last update time
   - Whether an update is available
2. Also show install path from `claudeclaw update --check`.

## Notes
- Auto-update is **disabled by default**. Enable it in settings: `update.autoUpdate: true`
- To use a fork as the update source, set `update.repo: "okram2000/claudeclaw"` in settings
- Backups are stored at `~/.claude/plugins/cache/claudeclaw/claudeclaw/backup/`
- Only one backup is kept (the version before the last update)
