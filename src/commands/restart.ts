// restart.ts — `claudeclaw restart` command
// Gracefully restarts the daemon with fresh config, without re-running setup.

import { restartDaemon, getPluginInstallPath } from "../updater";
import { checkExistingDaemon } from "../pid";

export async function restart(args: string[] = []) {
  const help = args.includes("--help") || args.includes("-h");

  if (help) {
    console.log(`Usage: claudeclaw restart [options]

Gracefully restart the ClaudeClaw daemon.
Picks up new code, config changes, and plugin updates without re-running setup.

Options:
  --help    Show this help message
`);
    return;
  }

  const existingPid = await checkExistingDaemon();
  if (!existingPid) {
    console.log("No daemon running. Use 'claudeclaw start' to start one.");
    return;
  }

  console.log(`Restarting ClaudeClaw daemon (PID ${existingPid})...`);

  const installPath = getPluginInstallPath();
  try {
    await restartDaemon(installPath, (msg) => console.log(`  ${msg}`));
    console.log("\x1b[32m✓ Daemon restarted successfully.\x1b[0m");
  } catch (err) {
    console.error(`\x1b[31m✗ Restart failed: ${err instanceof Error ? err.message : err}\x1b[0m`);
    console.log("Try manually: claudeclaw stop && claudeclaw start");
    process.exit(1);
  }
}
