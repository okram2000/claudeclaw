// updater.ts — Auto-update logic for ClaudeClaw plugin

import { join } from "path";
import { homedir, tmpdir } from "os";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  rmSync,
  mkdtempSync,
  readFileSync,
  renameSync,
} from "fs";
import { writeFile, readFile, mkdir } from "fs/promises";
import { execSync, type ExecSyncOptions } from "child_process";

// ── Paths ──────────────────────────────────────────────────────────

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const UPDATE_STATE_FILE = join(HEARTBEAT_DIR, "update-state.json");
const PLUGINS_DIR = join(homedir(), ".claude", "plugins");
const INST_FILE = join(PLUGINS_DIR, "installed_plugins.json");

export const DEFAULT_REPO = "moazbuilds/claudeclaw";
export const DEFAULT_BRANCH = "master";

// ── Types ──────────────────────────────────────────────────────────

export interface UpdateState {
  lastCheck: string | null;
  currentSHA: string | null;
  previousSHA: string | null;
  lastUpdate: string | null;
  updateAvailable: boolean;
  latestSHA: string | null;
}

export interface UpdateConfig {
  autoUpdate: boolean;
  checkInterval: string; // cron expression, e.g. "0 4 * * *"
  repo: string;          // "owner/repo"
  branch: string;
  notifyOnUpdate: boolean;
  githubToken?: string;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentSHA: string | null;
  latestSHA: string;
  commits: CommitInfo[];
}

export interface ApplyResult {
  success: boolean;
  previousSHA: string | null;
  newSHA: string;
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function sh(cmd: string, opts: ExecSyncOptions = {}): string {
  const result = execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts });
  return (result ?? "").toString().trim();
}

function copyDirSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function makeApiHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "claudeclaw-updater",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

// ── Plugin path detection ──────────────────────────────────────────

export function getPluginInstallPath(): string {
  // Try installed_plugins.json first
  try {
    const raw = readFileSync(INST_FILE, "utf-8");
    const instData = JSON.parse(raw);
    const entries = instData.plugins?.["claudeclaw@claudeclaw"];
    if (entries?.length > 0 && existsSync(entries[0].installPath)) {
      return entries[0].installPath;
    }
  } catch {
    // ignore
  }

  // Scan cache directory for any claudeclaw version
  const cacheBase = join(PLUGINS_DIR, "cache", "claudeclaw", "claudeclaw");
  if (existsSync(cacheBase)) {
    try {
      const versions = readdirSync(cacheBase).filter(
        (v) => v !== "backup" && existsSync(join(cacheBase, v))
      );
      if (versions.length > 0) {
        // Sort to prefer non-hash-looking versions (e.g. "1.0.0") or take last
        versions.sort();
        return join(cacheBase, versions[versions.length - 1]);
      }
    } catch {
      // ignore
    }
  }

  return join(PLUGINS_DIR, "cache", "claudeclaw", "claudeclaw", "1.0.0");
}

export function getBackupPath(): string {
  return join(PLUGINS_DIR, "cache", "claudeclaw", "claudeclaw", "backup");
}

// ── State persistence ──────────────────────────────────────────────

export async function loadUpdateState(): Promise<UpdateState> {
  try {
    const raw = await readFile(UPDATE_STATE_FILE, "utf-8");
    return JSON.parse(raw) as UpdateState;
  } catch {
    return {
      lastCheck: null,
      currentSHA: null,
      previousSHA: null,
      lastUpdate: null,
      updateAvailable: false,
      latestSHA: null,
    };
  }
}

export async function saveUpdateState(state: UpdateState): Promise<void> {
  await mkdir(HEARTBEAT_DIR, { recursive: true });
  await writeFile(UPDATE_STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

// ── Version file in install dir ────────────────────────────────────

function readInstallVersion(installPath: string): string | null {
  try {
    const vf = join(installPath, "version.json");
    const data = JSON.parse(readFileSync(vf, "utf-8"));
    return data.sha ?? null;
  } catch {
    return null;
  }
}

async function writeInstallVersion(installPath: string, sha: string): Promise<void> {
  await writeFile(
    join(installPath, "version.json"),
    JSON.stringify({ sha, updatedAt: new Date().toISOString() }, null, 2) + "\n"
  );
}

// ── GitHub API ─────────────────────────────────────────────────────

export async function fetchLatestCommit(
  repo: string,
  branch: string,
  token?: string
): Promise<{ sha: string; message: string; author: string; date: string }> {
  const url = `https://api.github.com/repos/${repo}/commits/${branch}`;
  const res = await fetch(url, { headers: makeApiHeaders(token) });

  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as {
    sha: string;
    commit: { message: string; author: { name: string; date: string } };
  };

  return {
    sha: data.sha,
    message: data.commit.message.split("\n")[0],
    author: data.commit.author.name,
    date: data.commit.author.date,
  };
}

export async function fetchCommitRange(
  repo: string,
  baseSHA: string,
  headBranch: string,
  token?: string
): Promise<CommitInfo[]> {
  // GET /repos/{owner}/{repo}/compare/{base}...{head}
  const url = `https://api.github.com/repos/${repo}/compare/${baseSHA}...${headBranch}`;
  try {
    const res = await fetch(url, { headers: makeApiHeaders(token) });
    if (!res.ok) return [];

    const data = await res.json() as {
      commits?: Array<{
        sha: string;
        commit: { message: string; author: { name: string; date: string } };
      }>;
    };

    return (data.commits ?? []).map((c) => ({
      sha: c.sha.slice(0, 8),
      message: c.commit.message.split("\n")[0],
      author: c.commit.author.name,
      date: c.commit.author.date,
    }));
  } catch {
    return [];
  }
}

// ── Core: check for updates ────────────────────────────────────────

export async function checkForUpdates(config: UpdateConfig): Promise<UpdateCheckResult> {
  const state = await loadUpdateState();
  const now = new Date().toISOString();

  const latest = await fetchLatestCommit(config.repo, config.branch, config.githubToken);

  // Determine current SHA: prefer version.json in install dir, fall back to state file
  const installPath = getPluginInstallPath();
  const installedSHA = readInstallVersion(installPath) ?? state.currentSHA;

  let commits: CommitInfo[] = [];
  let updateAvailable = false;

  if (!installedSHA) {
    // First run: no baseline — assume up to date, seed the state
    await saveUpdateState({
      ...state,
      lastCheck: now,
      currentSHA: latest.sha,
      latestSHA: latest.sha,
      updateAvailable: false,
    });
    return { updateAvailable: false, currentSHA: null, latestSHA: latest.sha, commits: [] };
  }

  updateAvailable = installedSHA !== latest.sha;

  if (updateAvailable) {
    commits = await fetchCommitRange(config.repo, installedSHA, config.branch, config.githubToken);
  }

  await saveUpdateState({
    ...state,
    lastCheck: now,
    currentSHA: installedSHA,
    latestSHA: latest.sha,
    updateAvailable,
  });

  return { updateAvailable, currentSHA: installedSHA, latestSHA: latest.sha, commits };
}

// ── Core: apply update ─────────────────────────────────────────────

export async function applyUpdate(
  config: UpdateConfig,
  onProgress?: (msg: string) => void
): Promise<ApplyResult> {
  const log = (msg: string) => onProgress?.(msg);
  const state = await loadUpdateState();
  const installPath = getPluginInstallPath();
  const backupPath = getBackupPath();
  const currentSHA = readInstallVersion(installPath) ?? state.currentSHA;

  log("Fetching latest commit info...");
  const latest = await fetchLatestCommit(config.repo, config.branch, config.githubToken);
  const newSHA = latest.sha;

  let tempDir: string | null = null;
  let tempTarball: string | null = null;
  let backedUp = false;

  try {
    // 1. Download tarball
    log(`Downloading ${config.repo}@${config.branch} (${newSHA.slice(0, 8)})...`);
    const tarballUrl = `https://api.github.com/repos/${config.repo}/tarball/${config.branch}`;
    const res = await fetch(tarballUrl, { headers: makeApiHeaders(config.githubToken) });
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${await res.text()}`);

    const tarball = await res.arrayBuffer();
    tempDir = mkdtempSync(join(tmpdir(), "claudeclaw-update-"));
    tempTarball = join(tempDir, "update.tar.gz");
    await writeFile(tempTarball, Buffer.from(tarball));

    // 2. Extract tarball (strip the top-level generated directory)
    const extractDir = join(tempDir, "extracted");
    mkdirSync(extractDir, { recursive: true });
    sh(`tar xzf "${tempTarball}" -C "${extractDir}" --strip-components=1`);
    log("Extraction complete.");

    // 3. Backup current installation
    log("Backing up current installation...");
    if (existsSync(backupPath)) {
      rmSync(backupPath, { recursive: true, force: true });
    }
    if (existsSync(installPath)) {
      copyDirSync(installPath, backupPath);
      backedUp = true;
    }

    // 4. Check if package.json changed
    const oldPkgJson = existsSync(join(installPath, "package.json"))
      ? readFileSync(join(installPath, "package.json"), "utf-8")
      : null;
    const newPkgJson = existsSync(join(extractDir, "package.json"))
      ? readFileSync(join(extractDir, "package.json"), "utf-8")
      : null;
    const pkgChanged = oldPkgJson !== newPkgJson;

    // 5. Replace install dir contents
    log("Applying update...");
    mkdirSync(installPath, { recursive: true });
    // Remove old files (except node_modules to avoid full reinstall when unchanged)
    for (const entry of readdirSync(installPath, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const p = join(installPath, entry.name);
      if (entry.isDirectory()) rmSync(p, { recursive: true, force: true });
      else rmSync(p, { force: true });
    }
    // Copy new files
    for (const entry of readdirSync(extractDir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const src = join(extractDir, entry.name);
      const dst = join(installPath, entry.name);
      if (entry.isDirectory()) copyDirSync(src, dst);
      else copyFileSync(src, dst);
    }

    // 6. Run bun install if package.json changed or node_modules missing
    const nodeModulesPath = join(installPath, "node_modules");
    if (pkgChanged || !existsSync(nodeModulesPath)) {
      log("Running bun install...");
      try {
        sh("bun install", { cwd: installPath, stdio: "inherit" });
      } catch {
        // Try npm as fallback
        try {
          sh("npm install", { cwd: installPath, stdio: "inherit" });
        } catch (e) {
          log(`Warning: dependency install failed: ${e}`);
        }
      }
    }

    // 7. Write version.json to install dir
    await writeInstallVersion(installPath, newSHA);

    // 8. Update registered version in installed_plugins.json
    try {
      const raw = readFileSync(INST_FILE, "utf-8");
      const instData = JSON.parse(raw);
      const entries: Array<Record<string, unknown>> = instData.plugins?.["claudeclaw@claudeclaw"] ?? [];
      if (entries.length > 0) {
        entries[0].gitCommitSha = newSHA;
        entries[0].version = newSHA.slice(0, 12);
        entries[0].lastUpdated = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
        const instJson = JSON.stringify(instData, null, 2) + "\n";
        await writeFile(INST_FILE, instJson);
      }
    } catch {
      // non-fatal
    }

    // 9. Save update state
    await saveUpdateState({
      lastCheck: new Date().toISOString(),
      currentSHA: newSHA,
      previousSHA: currentSHA,
      lastUpdate: new Date().toISOString(),
      updateAvailable: false,
      latestSHA: newSHA,
    });

    log(`Update complete: ${currentSHA?.slice(0, 8) ?? "?"} → ${newSHA.slice(0, 8)}`);
    return { success: true, previousSHA: currentSHA, newSHA };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Update failed: ${errorMsg}`);

    // Rollback if we backed up
    if (backedUp) {
      log("Rolling back...");
      try {
        await rollback();
        log("Rollback successful.");
      } catch (rbErr) {
        log(`Rollback also failed: ${rbErr}`);
      }
    }

    return { success: false, previousSHA: currentSHA, newSHA, error: errorMsg };
  } finally {
    if (tempDir && existsSync(tempDir)) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }
}

// ── Core: rollback ─────────────────────────────────────────────────

export async function rollback(): Promise<void> {
  const backupPath = getBackupPath();
  if (!existsSync(backupPath)) {
    throw new Error("No backup found to roll back to.");
  }

  const installPath = getPluginInstallPath();
  if (existsSync(installPath)) {
    rmSync(installPath, { recursive: true, force: true });
  }
  copyDirSync(backupPath, installPath);

  // Restore state
  const state = await loadUpdateState();
  if (state.previousSHA) {
    await saveUpdateState({
      ...state,
      currentSHA: state.previousSHA,
      previousSHA: null,
      updateAvailable: false,
    });
  }
}

// ── Daemon restart ─────────────────────────────────────────────────

/**
 * Gracefully restart the running daemon.
 * Sends SIGTERM to the current daemon PID, waits for it to exit,
 * then spawns a fresh daemon.
 */
export async function restartDaemon(
  installPath: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  const log = (msg: string) => onProgress?.(msg);
  const pidFile = join(process.cwd(), ".claude", "claudeclaw", "daemon.pid");

  let oldPid: number | null = null;
  try {
    const raw = readFileSync(pidFile, "utf-8").trim();
    oldPid = Number(raw);
    if (!oldPid || isNaN(oldPid)) oldPid = null;
  } catch {
    // No daemon running
  }

  if (oldPid) {
    log(`Stopping daemon (PID ${oldPid})...`);
    try {
      process.kill(oldPid, "SIGTERM");
    } catch {
      // already dead
    }

    // Wait up to 5s for it to exit
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(oldPid, 0);
        await Bun.sleep(100);
      } catch {
        break;
      }
    }
  }

  log("Starting updated daemon...");
  const indexScript = join(installPath, "src", "index.ts");
  const proc = Bun.spawn([process.execPath, "run", indexScript, "start"], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
  });
  proc.unref();
  log(`Daemon started (PID ${proc.pid})`);
}

// ── Notify channels ────────────────────────────────────────────────

export interface NotifyChannels {
  telegram?: { send: (chatId: number, text: string) => Promise<void>; userIds: number[] };
  discord?: { send: (userId: string, text: string) => Promise<void>; userIds: string[] };
  slack?: { send: (userId: string, text: string) => Promise<void>; userIds: string[] };
}

export async function notifyChannels(channels: NotifyChannels, message: string): Promise<void> {
  const tasks: Promise<void>[] = [];

  if (channels.telegram) {
    const { send, userIds } = channels.telegram;
    for (const id of userIds) {
      tasks.push(send(id, message).catch((e) => console.error(`[update] Telegram notify failed: ${e}`)));
    }
  }

  if (channels.discord) {
    const { send, userIds } = channels.discord;
    for (const id of userIds) {
      tasks.push(send(id, message).catch((e) => console.error(`[update] Discord notify failed: ${e}`)));
    }
  }

  if (channels.slack) {
    const { send, userIds } = channels.slack;
    for (const id of userIds) {
      tasks.push(send(id, message).catch((e) => console.error(`[update] Slack notify failed: ${e}`)));
    }
  }

  await Promise.allSettled(tasks);
}

// ── Changelog summary ──────────────────────────────────────────────

export function formatChangelog(commits: CommitInfo[]): string {
  if (commits.length === 0) return "(no commit details available)";
  return commits
    .slice(0, 10) // cap at 10
    .map((c) => `• ${c.sha} ${c.message}`)
    .join("\n");
}
