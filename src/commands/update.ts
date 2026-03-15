// update.ts — `claudeclaw update` command

import {
  checkForUpdates,
  applyUpdate,
  rollback,
  restartDaemon,
  loadUpdateState,
  getPluginInstallPath,
  formatChangelog,
  DEFAULT_REPO,
  DEFAULT_BRANCH,
  type UpdateConfig,
} from "../updater";
import { loadSettings } from "../config";
import { initConfig } from "../config";

function printHelp() {
  console.log(`Usage: claudeclaw update [options]

Options:
  (none)         Check for and apply available update
  --check        Only check for updates, don't apply
  --force        Force update even if already up to date
  --rollback     Revert to the previous version
  --no-restart   Don't restart the daemon after update
  --help         Show this help message

Examples:
  claudeclaw update             # Check and apply update
  claudeclaw update --check     # Check only
  claudeclaw update --force     # Force re-apply latest
  claudeclaw update --rollback  # Revert to backup
`);
}

function getUpdateConfig(settings: Awaited<ReturnType<typeof loadSettings>>): UpdateConfig {
  const uc = (settings as any).update as Partial<UpdateConfig> | undefined;
  return {
    autoUpdate: uc?.autoUpdate ?? false,
    checkInterval: uc?.checkInterval ?? "0 4 * * *",
    repo: uc?.repo ?? DEFAULT_REPO,
    branch: uc?.branch ?? DEFAULT_BRANCH,
    notifyOnUpdate: uc?.notifyOnUpdate ?? true,
    githubToken: uc?.githubToken,
  };
}

export async function update(args: string[] = []) {
  const checkOnly = args.includes("--check");
  const force = args.includes("--force");
  const doRollback = args.includes("--rollback");
  const noRestart = args.includes("--no-restart");
  const help = args.includes("--help") || args.includes("-h");

  if (help) {
    printHelp();
    return;
  }

  await initConfig();

  // ── Rollback ────────────────────────────────────────────────────
  if (doRollback) {
    console.log("Rolling back to previous version...");
    try {
      await rollback();
      console.log("\x1b[32m✓ Rollback successful.\x1b[0m");
      console.log("Restart the daemon to apply: claudeclaw stop && claudeclaw start");
    } catch (err) {
      console.error(`\x1b[31m✗ Rollback failed: ${err instanceof Error ? err.message : err}\x1b[0m`);
      process.exit(1);
    }
    return;
  }

  // ── Load config ──────────────────────────────────────────────────
  let config: UpdateConfig;
  try {
    const settings = await loadSettings();
    config = getUpdateConfig(settings);
  } catch {
    config = {
      autoUpdate: false,
      checkInterval: "0 4 * * *",
      repo: DEFAULT_REPO,
      branch: DEFAULT_BRANCH,
      notifyOnUpdate: true,
    };
  }

  // ── Check ────────────────────────────────────────────────────────
  console.log(`Checking for updates (${config.repo}@${config.branch})...`);

  let checkResult: Awaited<ReturnType<typeof checkForUpdates>>;
  try {
    checkResult = await checkForUpdates(config);
  } catch (err) {
    console.error(`\x1b[31m✗ Update check failed: ${err instanceof Error ? err.message : err}\x1b[0m`);
    process.exit(1);
  }

  const { updateAvailable, currentSHA, latestSHA, commits } = checkResult;

  if (currentSHA) {
    console.log(`  Current: ${currentSHA.slice(0, 8)}`);
  }
  console.log(`  Latest:  ${latestSHA.slice(0, 8)}`);

  if (!updateAvailable && !force) {
    console.log("\x1b[32m✓ Already up to date.\x1b[0m");
    return;
  }

  if (updateAvailable) {
    console.log(`\n\x1b[33mUpdate available!\x1b[0m`);
    if (commits.length > 0) {
      console.log("\nChanges:");
      console.log(formatChangelog(commits));
    }
  } else {
    console.log("\n(Forcing update despite being up to date)");
  }

  if (checkOnly) {
    const state = await loadUpdateState();
    if (state.updateAvailable) {
      console.log("\nRun \x1b[1mclaudeclaw update\x1b[0m to apply.");
    }
    return;
  }

  // ── Apply ────────────────────────────────────────────────────────
  console.log("\nApplying update...");
  const result = await applyUpdate(config, (msg) => console.log(`  ${msg}`));

  if (!result.success) {
    console.error(`\x1b[31m✗ Update failed: ${result.error}\x1b[0m`);
    process.exit(1);
  }

  console.log(`\n\x1b[32m✓ Updated: ${result.previousSHA?.slice(0, 8) ?? "?"} → ${result.newSHA.slice(0, 8)}\x1b[0m`);

  // ── Restart daemon ───────────────────────────────────────────────
  if (!noRestart) {
    const installPath = getPluginInstallPath();
    try {
      await restartDaemon(installPath, (msg) => console.log(`  ${msg}`));
    } catch (err) {
      console.warn(`  Could not restart daemon: ${err instanceof Error ? err.message : err}`);
      console.log("  Restart manually: claudeclaw stop && claudeclaw start");
    }
  } else {
    console.log("Restart the daemon to apply: claudeclaw stop && claudeclaw start");
  }
}
