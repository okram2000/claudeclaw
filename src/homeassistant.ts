/**
 * Home Assistant REST API client.
 * Uses only fetch() — no external HA libraries.
 */

export interface HaConfig {
  baseUrl: string;
  token: string;
  defaultEntities: string[];
}

export interface HaEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  context: {
    id: string;
    parent_id: string | null;
    user_id: string | null;
  };
}

export interface HaServiceCallParams {
  entity_id?: string | string[];
  [key: string]: unknown;
}

// --- Internal cache ---

let entityCache: HaEntityState[] | null = null;
let entityCacheAt = 0;
const CACHE_TTL_MS = 30_000;

// --- Helpers ---

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function haFetch<T>(
  baseUrl: string,
  token: string,
  path: string,
  options?: RequestInit
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        ...authHeaders(token),
        ...(options?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new Error(
      `Home Assistant unreachable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // ignore
    }
    throw new Error(`Home Assistant API ${response.status}: ${body}`);
  }
  return response.json() as Promise<T>;
}

// --- Connection ---

/** Verify HA is reachable and the token is valid. */
export async function checkConnection(
  config: HaConfig
): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await haFetch<{ message: string }>(
      config.baseUrl,
      config.token,
      "/api/"
    );
    return { ok: true, message: result.message ?? "API running" };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- State ---

/** Get all entity states. Results are cached for 30 s unless forced. */
export async function getAllStates(
  config: HaConfig,
  force = false
): Promise<HaEntityState[]> {
  const now = Date.now();
  if (!force && entityCache && now - entityCacheAt < CACHE_TTL_MS) {
    return entityCache;
  }
  const states = await haFetch<HaEntityState[]>(
    config.baseUrl,
    config.token,
    "/api/states"
  );
  entityCache = states;
  entityCacheAt = now;
  return states;
}

/** Get a single entity's state (never cached). */
export async function getState(
  config: HaConfig,
  entityId: string
): Promise<HaEntityState> {
  return haFetch<HaEntityState>(
    config.baseUrl,
    config.token,
    `/api/states/${entityId}`
  );
}

/** Force-invalidate the entity cache (call after any state-changing service call). */
export function invalidateCache(): void {
  entityCache = null;
  entityCacheAt = 0;
}

// --- Services ---

/** Generic service call. Returns the list of affected entity states. */
export async function callService(
  config: HaConfig,
  domain: string,
  service: string,
  params: HaServiceCallParams = {}
): Promise<HaEntityState[]> {
  const result = await haFetch<HaEntityState[]>(
    config.baseUrl,
    config.token,
    `/api/services/${domain}/${service}`,
    { method: "POST", body: JSON.stringify(params) }
  );
  invalidateCache();
  return result;
}

/** Turn an entity on. Optionally pass brightness (0-255), color_temp, etc. */
export async function turnOn(
  config: HaConfig,
  entityId: string,
  extra: Record<string, unknown> = {}
): Promise<HaEntityState[]> {
  const domain = entityId.split(".")[0];
  return callService(config, domain, "turn_on", { entity_id: entityId, ...extra });
}

/** Turn an entity off. */
export async function turnOff(
  config: HaConfig,
  entityId: string
): Promise<HaEntityState[]> {
  const domain = entityId.split(".")[0];
  return callService(config, domain, "turn_off", { entity_id: entityId });
}

/** Toggle an entity. */
export async function toggleEntity(
  config: HaConfig,
  entityId: string
): Promise<HaEntityState[]> {
  const domain = entityId.split(".")[0];
  return callService(config, domain, "toggle", { entity_id: entityId });
}

/** Set climate temperature. */
export async function setTemperature(
  config: HaConfig,
  entityId: string,
  temperature: number
): Promise<HaEntityState[]> {
  return callService(config, "climate", "set_temperature", {
    entity_id: entityId,
    temperature,
  });
}

/** Set climate HVAC mode (heat, cool, heat_cool, off, auto, fan_only, dry). */
export async function setHvacMode(
  config: HaConfig,
  entityId: string,
  hvacMode: string
): Promise<HaEntityState[]> {
  return callService(config, "climate", "set_hvac_mode", {
    entity_id: entityId,
    hvac_mode: hvacMode,
  });
}

/** Activate a scene. */
export async function activateScene(
  config: HaConfig,
  sceneId: string
): Promise<HaEntityState[]> {
  return callService(config, "scene", "turn_on", { entity_id: sceneId });
}

/** Set media player volume (0.0–1.0). */
export async function setVolume(
  config: HaConfig,
  entityId: string,
  volume: number
): Promise<HaEntityState[]> {
  return callService(config, "media_player", "volume_set", {
    entity_id: entityId,
    volume_level: Math.max(0, Math.min(1, volume)),
  });
}

/** Open/close a cover. */
export async function controlCover(
  config: HaConfig,
  entityId: string,
  action: "open_cover" | "close_cover" | "stop_cover" | "toggle"
): Promise<HaEntityState[]> {
  return callService(config, "cover", action, { entity_id: entityId });
}

// --- History ---

/** Get entity state history for the last N hours. */
export async function getHistory(
  config: HaConfig,
  entityId: string,
  hoursBack = 24
): Promise<HaEntityState[][]> {
  const start = new Date(Date.now() - hoursBack * 3_600_000).toISOString();
  return haFetch<HaEntityState[][]>(
    config.baseUrl,
    config.token,
    `/api/history/period/${start}?filter_entity_id=${encodeURIComponent(entityId)}`
  );
}

// --- Discovery helpers ---

/** Get all entities belonging to a domain (e.g. "light", "switch"). */
export async function getEntitiesByDomain(
  config: HaConfig,
  domain: string
): Promise<HaEntityState[]> {
  const all = await getAllStates(config);
  return all.filter((e) => e.entity_id.startsWith(`${domain}.`));
}

/**
 * Find an entity by partial name / entity_id match.
 * Priority: exact entity_id → exact friendly_name → partial match.
 */
export async function findEntity(
  config: HaConfig,
  query: string
): Promise<HaEntityState | null> {
  const states = await getAllStates(config);
  const q = query.toLowerCase().replace(/[-_]/g, " ");

  const exact = states.find(
    (e) => e.entity_id.toLowerCase() === query.toLowerCase()
  );
  if (exact) return exact;

  const byFriendlyExact = states.find(
    (e) =>
      ((e.attributes.friendly_name as string) || "").toLowerCase() === q
  );
  if (byFriendlyExact) return byFriendlyExact;

  const byPartial = states.find((e) => {
    const name = ((e.attributes.friendly_name as string) || "").toLowerCase();
    const id = e.entity_id.toLowerCase();
    return (
      name.includes(q) ||
      id.replace(/[._]/g, " ").includes(q) ||
      id.includes(query.toLowerCase())
    );
  });
  return byPartial ?? null;
}

// --- Status summary ---

const PRIORITY_DOMAINS = [
  "light",
  "switch",
  "climate",
  "cover",
  "media_player",
  "input_boolean",
  "fan",
  "vacuum",
  "sensor",
  "binary_sensor",
];

const ACTIVE_STATES = new Set([
  "on",
  "open",
  "playing",
  "paused",
  "heat",
  "cool",
  "heat_cool",
  "auto",
  "fan_only",
  "dry",
  "cleaning",
]);

/** Build a human-readable status overview grouped by domain. */
export async function getStatusSummary(config: HaConfig): Promise<string> {
  let states: HaEntityState[];
  try {
    states = await getAllStates(config, true);
  } catch (err) {
    return `Unable to reach Home Assistant: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  const byDomain: Record<string, HaEntityState[]> = {};
  for (const entity of states) {
    const domain = entity.entity_id.split(".")[0];
    (byDomain[domain] ??= []).push(entity);
  }

  const lines: string[] = [
    `Home Assistant — ${states.length} entities`,
    `Connected: ${config.baseUrl}`,
  ];

  for (const domain of PRIORITY_DOMAINS) {
    const entities = byDomain[domain];
    if (!entities || entities.length === 0) continue;

    const active = entities.filter((e) => ACTIVE_STATES.has(e.state));
    lines.push(`\n## ${domain} (${active.length}/${entities.length} active)`);

    const shown = entities.slice(0, 25);
    for (const e of shown) {
      const name = (e.attributes.friendly_name as string) || e.entity_id;
      const extra = formatEntityExtra(e);
      const flag = ACTIVE_STATES.has(e.state) ? "●" : "○";
      lines.push(
        `  ${flag} ${e.entity_id}: ${e.state}${extra ? ` (${extra})` : ""} — ${name}`
      );
    }
    if (entities.length > 25) {
      lines.push(`  … and ${entities.length - 25} more`);
    }
  }

  // List any unlisted domains
  const listed = new Set(PRIORITY_DOMAINS);
  for (const [domain, entities] of Object.entries(byDomain)) {
    if (!listed.has(domain)) {
      const active = entities.filter((e) => ACTIVE_STATES.has(e.state));
      lines.push(`\n## ${domain} (${active.length}/${entities.length} active)`);
      for (const e of entities.slice(0, 10)) {
        const name = (e.attributes.friendly_name as string) || e.entity_id;
        lines.push(`  ${e.entity_id}: ${e.state} — ${name}`);
      }
      if (entities.length > 10)
        lines.push(`  … and ${entities.length - 10} more`);
    }
  }

  return lines.join("\n");
}

function formatEntityExtra(entity: HaEntityState): string {
  const a = entity.attributes;
  const parts: string[] = [];
  if (typeof a.brightness === "number") {
    parts.push(`${Math.round(((a.brightness as number) / 255) * 100)}% bright`);
  }
  if (typeof a.temperature === "number")
    parts.push(`set ${a.temperature}°`);
  if (typeof a.current_temperature === "number")
    parts.push(`now ${a.current_temperature}°`);
  if (a.hvac_mode) parts.push(`mode: ${a.hvac_mode}`);
  if (a.media_title) parts.push(`"${a.media_title}"`);
  if (typeof a.volume_level === "number")
    parts.push(`vol ${Math.round((a.volume_level as number) * 100)}%`);
  if (typeof a.unit_of_measurement === "string" && a.unit_of_measurement)
    parts.push(a.unit_of_measurement as string);
  return parts.join(", ");
}
