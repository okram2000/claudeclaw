/**
 * Home Assistant standalone command / polling mode.
 *
 * Usage:
 *   bun run src/index.ts home              — start polling loop
 *   bun run src/index.ts home --check      — one-shot connection check
 *   bun run src/index.ts home --status     — one-shot status dump
 *   bun run src/index.ts home --poll 60    — poll every N seconds (default 60)
 */

import { loadSettings, getSettings } from "../config";
import {
  checkConnection,
  getStatusSummary,
  getAllStates,
  type HaEntityState,
} from "../homeassistant";

function ts(): string {
  return new Date().toLocaleTimeString();
}

function printHelp(): void {
  console.log(`Usage: claudeclaw home [options]

Options:
  --check         Verify Home Assistant connection and exit
  --status        Print current status of all devices and exit
  --poll [N]      Poll for state changes every N seconds (default: 60)
  --domain <dom>  Filter --status output to a specific domain (e.g. light, climate)

Configuration (in .claude/claudeclaw/settings.json):
  homeassistant.enabled   true/false
  homeassistant.baseUrl   http://homeassistant.local:8123
  homeassistant.token     long-lived access token
`);
}

function stateKey(e: HaEntityState): string {
  return `${e.entity_id}=${e.state}|${JSON.stringify(e.attributes)}`;
}

async function pollLoop(intervalSec: number): Promise<void> {
  const config = getSettings().homeassistant;

  console.log(`[${ts()}] Home Assistant polling started`);
  console.log(`  URL: ${config.baseUrl}`);
  console.log(`  Poll interval: ${intervalSec}s`);

  const { ok, message } = await checkConnection(config);
  if (!ok) {
    console.error(`[${ts()}] Connection failed: ${message}`);
    console.error("Check homeassistant.baseUrl and homeassistant.token in settings.json");
    process.exit(1);
  }
  console.log(`[${ts()}] Connected: ${message}`);

  let previousStates: Map<string, string> = new Map();

  async function tick(): Promise<void> {
    try {
      const states = await getAllStates(config, true);
      const changed: HaEntityState[] = [];

      for (const entity of states) {
        const key = stateKey(entity);
        const prev = previousStates.get(entity.entity_id);
        if (prev !== undefined && prev !== key) {
          changed.push(entity);
        }
      }

      if (previousStates.size > 0 && changed.length > 0) {
        console.log(`[${ts()}] ${changed.length} state change(s):`);
        for (const e of changed) {
          const name = (e.attributes.friendly_name as string) || e.entity_id;
          console.log(`  ${e.entity_id} (${name}): ${e.state}`);
        }
      }

      previousStates = new Map(states.map((e) => [e.entity_id, stateKey(e)]));
    } catch (err) {
      console.error(
        `[${ts()}] Poll error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  await tick();
  setInterval(tick, intervalSec * 1000);

  // Keep the process alive
  await new Promise(() => {});
}

export async function home(args: string[] = []): Promise<void> {
  await loadSettings();
  const config = getSettings().homeassistant;

  let checkFlag = false;
  let statusFlag = false;
  let pollFlag = false;
  let pollInterval = 60;
  let domainFilter: string | null = null;
  let helpFlag = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") {
      checkFlag = true;
    } else if (arg === "--status") {
      statusFlag = true;
    } else if (arg === "--poll") {
      pollFlag = true;
      const next = args[i + 1];
      if (next && /^\d+$/.test(next)) {
        pollInterval = parseInt(next, 10);
        i++;
      }
    } else if (arg === "--domain") {
      domainFilter = args[i + 1] ?? null;
      if (domainFilter) i++;
    } else if (arg === "--help" || arg === "-h") {
      helpFlag = true;
    }
  }

  if (helpFlag) {
    printHelp();
    return;
  }

  if (!config.enabled || !config.baseUrl || !config.token) {
    console.error(
      "Home Assistant is not configured. Set homeassistant.enabled, homeassistant.baseUrl, and homeassistant.token in .claude/claudeclaw/settings.json"
    );
    process.exit(1);
  }

  // --check: verify connection only
  if (checkFlag) {
    const { ok, message } = await checkConnection(config);
    if (ok) {
      console.log(`[home] Connected to Home Assistant: ${message}`);
      console.log(`  URL: ${config.baseUrl}`);
    } else {
      console.error(`[home] Connection failed: ${message}`);
      process.exit(1);
    }
    return;
  }

  // --status: one-shot status dump
  if (statusFlag) {
    if (domainFilter) {
      const { getEntitiesByDomain } = await import("../homeassistant");
      try {
        const entities = await getEntitiesByDomain(config, domainFilter);
        if (entities.length === 0) {
          console.log(`No entities found for domain: ${domainFilter}`);
          return;
        }
        console.log(`${domainFilter} entities (${entities.length}):`);
        for (const e of entities) {
          const name = (e.attributes.friendly_name as string) || e.entity_id;
          console.log(`  ${e.entity_id}: ${e.state} — ${name}`);
        }
      } catch (err) {
        console.error(
          `Failed to fetch ${domainFilter} entities: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        process.exit(1);
      }
    } else {
      const summary = await getStatusSummary(config);
      console.log(summary);
    }
    return;
  }

  // Default or --poll: run polling loop
  await pollLoop(pollInterval);
}
