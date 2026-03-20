---
description: Start a remote development session on a server (e.g. apoc) in a detached screen session with Claude Code running autonomously. Use when asked to start a dev session, kick off work on apoc, run a task on a remote server, launch a coding session, or delegate work to a remote Claude. Trigger phrases include "dev session", "start session on apoc", "remote session", "kick off on apoc", "launch dev session", "start working on apoc", "development session", "remote dev", "delegate to apoc", "/dev-session".
user_invocable: true
---

# Remote Development Session

Start an autonomous Claude Code session on a remote server inside a `screen` session. Claw monitors progress periodically instead of blocking the main session.

## Usage

```
/dev-session <host> <project-dir> <task-description>
/dev-session status [session-name]
/dev-session list
/dev-session stop <session-name>
/dev-session log <session-name> [lines]
```

**Defaults:**
- `host`: `apoc.sky.home` (if omitted)
- SSH: `ssh -i ~/.ssh/id_ed25519 -o IdentityAgent=none acid@<host>`

## Instructions

### Starting a session: `/dev-session <host> <project-dir> <task>`

1. Generate a short session name from the task (e.g. `holowar-tests`, `autotrader-optimize`)
2. SSH into the host and start a detached screen session with Claude Code:

```bash
ssh -i ~/.ssh/id_ed25519 -o IdentityAgent=none acid@<host> "screen -dmS <session-name> bash -c 'cd <project-dir> && claude -p \"<task-description>\" --dangerously-skip-permissions --output-format text 2>&1 | tee /tmp/devsession-<session-name>.log; echo \"SESSION_COMPLETE\" >> /tmp/devsession-<session-name>.log'"
```

3. Confirm to the user that the session started
4. Tell the user you'll check in on progress during heartbeats
5. Save the session info so heartbeats can check:

```bash
echo '<session-name>|<host>|<project-dir>|<timestamp>' >> /home/acid/claudeclaw/.claude/claudeclaw/dev-sessions.txt
```

### Checking status: `/dev-session status [name]`

SSH into the host and check the screen session + log:

```bash
ssh -i ~/.ssh/id_ed25519 -o IdentityAgent=none acid@<host> "screen -ls | grep <session-name> && echo '---RUNNING---' || echo '---FINISHED---'; echo '=== LAST 30 LINES ==='; tail -30 /tmp/devsession-<session-name>.log"
```

If the log contains `SESSION_COMPLETE`, the session is done. Report the final output to the user.

### Listing sessions: `/dev-session list`

```bash
cat /home/acid/claudeclaw/.claude/claudeclaw/dev-sessions.txt 2>/dev/null
```

Also SSH to each host and check which screens are still active.

### Stopping a session: `/dev-session stop <name>`

```bash
ssh -i ~/.ssh/id_ed25519 -o IdentityAgent=none acid@<host> "screen -S <session-name> -X quit"
```

Remove from dev-sessions.txt.

### Reading full log: `/dev-session log <name> [lines]`

```bash
ssh -i ~/.ssh/id_ed25519 -o IdentityAgent=none acid@<host> "tail -<lines> /tmp/devsession-<session-name>.log"
```

Default: 50 lines.

## Heartbeat Integration

During heartbeats, if there are active dev sessions in `dev-sessions.txt`:
1. Check if each session's screen is still running
2. If a session finished (screen gone or `SESSION_COMPLETE` in log), read the last 30 lines and notify the user with a summary
3. Remove completed sessions from the tracking file

## Important Notes

- NEVER run Claude Code sessions in the foreground over SSH — always use `screen -dmS`
- The `--dangerously-skip-permissions` flag is required since there's no interactive terminal
- Log output goes to `/tmp/devsession-<name>.log` for later review
- Multiple sessions can run in parallel on the same or different hosts
- If the user just says "start on apoc" without a host, default to `apoc.sky.home`
- Session names should be short, lowercase, hyphenated (e.g. `holowar-e2e`, `trader-optimize`)
