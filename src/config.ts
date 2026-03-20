import { join, isAbsolute } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { normalizeTimezoneName, resolveTimezoneOffsetMinutes } from "./timezone";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(HEARTBEAT_DIR, "settings.json");
const JOBS_DIR = join(HEARTBEAT_DIR, "jobs");
const LOGS_DIR = join(HEARTBEAT_DIR, "logs");

const DEFAULT_SETTINGS: Settings = {
  model: "",
  api: "",
  fallback: {
    model: "",
    api: "",
  },
  timezone: "UTC",
  timezoneOffsetMinutes: 0,
  heartbeat: {
    enabled: false,
    interval: 15,
    prompt: "",
    excludeWindows: [],
    forwardToTelegram: true,
  },
  telegram: { token: "", allowedUserIds: [] },
  discord: { token: "", allowedUserIds: [], listenChannels: [] },
  slack: { token: "", appToken: "", allowedUserIds: [], listenChannels: [] },
alexa: { enabled: false, port: 3456, skillId: "", allowedUserIds: [], skipVerification: false, tunnelType: "none" },
whatsapp: { allowedNumbers: [], groupsEnabled: false },
  matrix: { homeserverUrl: "", accessToken: "", userId: "", allowedUserIds: [], listenRooms: [] },
  security: { level: "moderate", allowedTools: [], disallowedTools: [] },
  overflow: { enabled: true, thresholdSeconds: 60 },
  web: { enabled: false, host: "127.0.0.1", port: 4632 },
  stt: { baseUrl: "", model: "" },
update: {
    autoUpdate: false,
    checkInterval: "0 4 * * *",
    repo: "okram2000/claudeclaw",
    branch: "master",
    notifyOnUpdate: true,
  },
  browser: {
    enabled: false,
    chromePath: "",
    headless: true,
    userDataDir: "",
    defaultViewport: { width: 1280, height: 800 },
  },
  activityFeed: { discordChannel: "" },
  streaming: { enabled: false, updateInterval: 1000, platforms: ["discord", "telegram", "slack"] },
homeassistant: { enabled: false, baseUrl: "", token: "", defaultEntities: [] },
integrations: {
    notion: { token: "", defaultDatabase: "" },
    obsidian: { vaultPath: "" },
    calendar: { url: "", username: "", password: "" },
  },
};

export interface HeartbeatExcludeWindow {
  days?: number[];
  start: string;
  end: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  interval: number;
  prompt: string;
  excludeWindows: HeartbeatExcludeWindow[];
  forwardToTelegram: boolean;
}

export interface TelegramConfig {
  token: string;
  allowedUserIds: number[];
}

export interface DiscordConfig {
  token: string;
  allowedUserIds: string[]; // Discord snowflake IDs exceed Number.MAX_SAFE_INTEGER
  listenChannels: string[]; // Channel IDs where bot responds to all messages (no mention needed)
}

export interface SlackConfig {
  token: string;     // Bot token (xoxb-)
  appToken: string;  // Socket Mode app-level token (xapp-)
  allowedUserIds: string[];
  listenChannels: string[]; // Channel IDs where bot responds to all messages (no mention needed)
}

export type AlexaTunnelType = "cloudflared" | "ngrok" | "none";

export interface AlexaConfig {
  enabled: boolean;
  port: number;
  skillId: string;         // Alexa Skill ID from Developer Console (amzn1.ask.skill.*)
  allowedUserIds: string[]; // Alexa user IDs to restrict access (empty = allow all)
  skipVerification: boolean; // Disable signature verification for local dev (never in prod)
  tunnelType: AlexaTunnelType;
}

export interface WhatsAppConfig {
  /** Phone numbers in international format without +, e.g. "14155551234". Empty = all allowed. */
  allowedNumbers: string[];
  /** Whether to respond to messages in group chats (only when mentioned). */
  groupsEnabled: boolean;
}

export interface MatrixConfig {
  /** Homeserver URL, e.g. "https://matrix.org" */
  homeserverUrl: string;
  /** Bot access token */
  accessToken: string;
  /** Bot's Matrix user ID, e.g. "@bot:matrix.org" */
  userId: string;
  /** Allowed Matrix user IDs. Empty = all allowed. */
  allowedUserIds: string[];
  /** Room IDs where the bot responds to all messages (no mention needed). */
  listenRooms: string[];
}

export type SecurityLevel =
  | "locked"
  | "strict"
  | "moderate"
  | "unrestricted";

export interface SecurityConfig {
  level: SecurityLevel;
  allowedTools: string[];
  disallowedTools: string[];
}

export interface Settings {
  model: string;
  api: string;
  fallback: ModelConfig;
  timezone: string;
  timezoneOffsetMinutes: number;
  heartbeat: HeartbeatConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  slack: SlackConfig;
  alexa: AlexaConfig;
  whatsapp: WhatsAppConfig;
  matrix: MatrixConfig;
  security: SecurityConfig;
  overflow: OverflowConfig;
  activityFeed: ActivityFeedConfig;
  web: WebConfig;
  stt: SttConfig;
  update: UpdateConfig;
  browser: BrowserConfig;
  streaming: StreamingConfig;
  homeassistant: HomeAssistantConfig;
  integrations: IntegrationsConfig;
}

export interface ModelConfig {
  model: string;
  api: string;
}

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface SttConfig {
  /** Base URL of an OpenAI-compatible STT API, e.g. "http://127.0.0.1:8000".
   *  When set, claudeclaw routes voice transcription through this API instead
   *  of the bundled whisper.cpp binary. */
  baseUrl: string;
  /** Model name passed to the API (default: "Systran/faster-whisper-large-v3") */
  model: string;
}

export interface UpdateConfig {
  /** Whether to automatically apply updates once daily. Default: false (opt-in). */
  autoUpdate: boolean;
  /** Cron expression for auto-update schedule. Default: "0 4 * * *" (4 AM daily). */
  checkInterval: string;
  /** GitHub repo to pull updates from ("owner/repo"). Default: "okram2000/claudeclaw". */
  repo: string;
  /** Branch to track. Default: "master". */
  branch: string;
  /** Send a notification when an update is applied. Default: true. */
  notifyOnUpdate: boolean;
  /** Optional GitHub personal access token (increases API rate limits). */
  githubToken?: string;
}

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserConfig {
  /** Enable the browser automation module. */
  enabled: boolean;
  /** Path to the Chromium/Chrome executable. Auto-detected if empty. */
  chromePath: string;
  /** Run in headless mode (no visible window). Default: true. */
  headless: boolean;
  /** Directory for browser profile / session persistence. */
  userDataDir: string;
  /** Default viewport size. */
  defaultViewport: BrowserViewport;
}

export interface ActivityFeedConfig {
  /** Discord channel ID to forward activity summaries to. Empty = disabled. */
  discordChannel: string;
}

export interface OverflowConfig {
  /** Enable ephemeral overflow sessions when the main queue is busy. Default: true. */
  enabled: boolean;
  /** Seconds the main queue must be busy before interactive messages overflow. Default: 60. */
  thresholdSeconds: number;
}

export interface StreamingConfig {
  /** Enable progressive message updates while Claude is generating. */
  enabled: boolean;
  /** Minimum ms between message edits (platform rate limit guard). Default: 1000 */
  updateInterval: number;
  /** Which platforms get streaming updates. Default: all. */
  platforms: string[];
}

export interface HomeAssistantConfig {
  enabled: boolean;
  /** Base URL of the Home Assistant instance, e.g. "http://homeassistant.local:8123" */
  baseUrl: string;
  /** Long-lived access token from HA profile page */
  token: string;
  /** Entity IDs to highlight in status summaries (optional) */
  defaultEntities: string[];
}

export interface NotionIntegrationConfig {
  /** Notion integration token (secret_...) */
  token: string;
  /** Default database ID to use when none is specified */
  defaultDatabase: string;
}

export interface ObsidianIntegrationConfig {
  /** Absolute path to the Obsidian vault directory */
  vaultPath: string;
}

export interface CalendarIntegrationConfig {
  /** CalDAV server URL (e.g. https://nextcloud.example.com/remote.php/dav) */
  url: string;
  username: string;
  password: string;
}

export interface IntegrationsConfig {
  notion: NotionIntegrationConfig;
  obsidian: ObsidianIntegrationConfig;
  calendar: CalendarIntegrationConfig;
}

let cached: Settings | null = null;

export async function initConfig(): Promise<void> {
  await mkdir(HEARTBEAT_DIR, { recursive: true });
  await mkdir(JOBS_DIR, { recursive: true });
  await mkdir(LOGS_DIR, { recursive: true });

  if (!existsSync(SETTINGS_FILE)) {
    await Bun.write(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
  }
}

const VALID_LEVELS = new Set<SecurityLevel>([
  "locked",
  "strict",
  "moderate",
  "unrestricted",
]);

function parseSettings(raw: Record<string, any>, discordUserIds?: string[]): Settings {
  const rawLevel = raw.security?.level;
  const level: SecurityLevel =
    typeof rawLevel === "string" && VALID_LEVELS.has(rawLevel as SecurityLevel)
      ? (rawLevel as SecurityLevel)
      : "moderate";

  const parsedTimezone = parseTimezone(raw.timezone);

  return {
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    api: typeof raw.api === "string" ? raw.api.trim() : "",
    fallback: {
      model: typeof raw.fallback?.model === "string" ? raw.fallback.model.trim() : "",
      api: typeof raw.fallback?.api === "string" ? raw.fallback.api.trim() : "",
    },
    timezone: parsedTimezone,
    timezoneOffsetMinutes: parseTimezoneOffsetMinutes(raw.timezoneOffsetMinutes, parsedTimezone),
    heartbeat: {
      enabled: raw.heartbeat?.enabled ?? false,
      interval: raw.heartbeat?.interval ?? 15,
      prompt: raw.heartbeat?.prompt ?? "",
      excludeWindows: parseExcludeWindows(raw.heartbeat?.excludeWindows),
      forwardToTelegram: raw.heartbeat?.forwardToTelegram ?? false,
    },
    telegram: {
      token: raw.telegram?.token ?? "",
      allowedUserIds: raw.telegram?.allowedUserIds ?? [],
    },
    discord: {
      token: typeof raw.discord?.token === "string" ? raw.discord.token.trim() : "",
      allowedUserIds: discordUserIds && discordUserIds.length > 0
        ? discordUserIds
        : Array.isArray(raw.discord?.allowedUserIds)
          ? raw.discord.allowedUserIds.map(String)
          : [],
      listenChannels: Array.isArray(raw.discord?.listenChannels)
        ? raw.discord.listenChannels.map(String)
        : [],
    },
    slack: {
      token: typeof raw.slack?.token === "string" ? raw.slack.token.trim() : "",
      appToken: typeof raw.slack?.appToken === "string" ? raw.slack.appToken.trim() : "",
      allowedUserIds: Array.isArray(raw.slack?.allowedUserIds)
        ? raw.slack.allowedUserIds.map(String)
        : [],
      listenChannels: Array.isArray(raw.slack?.listenChannels)
        ? raw.slack.listenChannels.map(String)
        : [],
    },
    alexa: {
      enabled: raw.alexa?.enabled ?? false,
      port: Number.isFinite(raw.alexa?.port) ? Number(raw.alexa.port) : 3456,
      skillId: typeof raw.alexa?.skillId === "string" ? raw.alexa.skillId.trim() : "",
      allowedUserIds: Array.isArray(raw.alexa?.allowedUserIds)
        ? raw.alexa.allowedUserIds.map(String)
        : [],
      skipVerification: raw.alexa?.skipVerification ?? false,
      tunnelType: (["cloudflared", "ngrok", "none"] as const).includes(raw.alexa?.tunnelType)
        ? raw.alexa.tunnelType as AlexaTunnelType
        : "none",
    },
    whatsapp: {
      allowedNumbers: Array.isArray(raw.whatsapp?.allowedNumbers)
        ? raw.whatsapp.allowedNumbers.map(String)
        : [],
      groupsEnabled: raw.whatsapp?.groupsEnabled ?? false,
    },
    matrix: {
      homeserverUrl: typeof raw.matrix?.homeserverUrl === "string" ? raw.matrix.homeserverUrl.trim() : "",
      accessToken: typeof raw.matrix?.accessToken === "string" ? raw.matrix.accessToken.trim() : "",
      userId: typeof raw.matrix?.userId === "string" ? raw.matrix.userId.trim() : "",
      allowedUserIds: Array.isArray(raw.matrix?.allowedUserIds)
        ? raw.matrix.allowedUserIds.map(String)
        : [],
      listenRooms: Array.isArray(raw.matrix?.listenRooms)
        ? raw.matrix.listenRooms.map(String)
        : [],
    },
    security: {
      level,
      allowedTools: Array.isArray(raw.security?.allowedTools)
        ? raw.security.allowedTools
        : [],
      disallowedTools: Array.isArray(raw.security?.disallowedTools)
        ? raw.security.disallowedTools
        : [],
    },
    overflow: {
      enabled: raw.overflow?.enabled ?? true,
      thresholdSeconds: Number.isFinite(raw.overflow?.thresholdSeconds)
        ? Math.max(10, Math.round(Number(raw.overflow.thresholdSeconds)))
        : 60,
    },
    activityFeed: {
      discordChannel: typeof raw.activityFeed?.discordChannel === "string"
        ? raw.activityFeed.discordChannel.trim()
        : "",
    },
    web: {
      enabled: raw.web?.enabled ?? false,
      host: raw.web?.host ?? "127.0.0.1",
      port: Number.isFinite(raw.web?.port) ? Number(raw.web.port) : 4632,
    },
    stt: {
      baseUrl: typeof raw.stt?.baseUrl === "string" ? raw.stt.baseUrl.trim() : "",
      model: typeof raw.stt?.model === "string" ? raw.stt.model.trim() : "",
    },
    update: {
      autoUpdate: raw.update?.autoUpdate ?? false,
      checkInterval: typeof raw.update?.checkInterval === "string" ? raw.update.checkInterval.trim() : "0 4 * * *",
      repo: typeof raw.update?.repo === "string" ? raw.update.repo.trim() : "okram2000/claudeclaw",
      branch: typeof raw.update?.branch === "string" ? raw.update.branch.trim() : "master",
      notifyOnUpdate: raw.update?.notifyOnUpdate ?? true,
      githubToken: typeof raw.update?.githubToken === "string" ? raw.update.githubToken.trim() : undefined,
    },
    browser: {
      enabled: raw.browser?.enabled ?? false,
      chromePath: typeof raw.browser?.chromePath === "string" ? raw.browser.chromePath.trim() : "",
      headless: raw.browser?.headless ?? true,
      userDataDir: typeof raw.browser?.userDataDir === "string" ? raw.browser.userDataDir.trim() : "",
      defaultViewport: {
        width: Number.isFinite(raw.browser?.defaultViewport?.width) ? Number(raw.browser.defaultViewport.width) : 1280,
        height: Number.isFinite(raw.browser?.defaultViewport?.height) ? Number(raw.browser.defaultViewport.height) : 800,
      },
    },
    streaming: {
      enabled: raw.streaming?.enabled ?? false,
      updateInterval: Number.isFinite(raw.streaming?.updateInterval) ? Math.max(500, Number(raw.streaming.updateInterval)) : 1000,
      platforms: Array.isArray(raw.streaming?.platforms) ? raw.streaming.platforms.map(String) : ["discord", "telegram", "slack"],
    },
    homeassistant: {
      enabled: raw.homeassistant?.enabled ?? false,
      baseUrl: typeof raw.homeassistant?.baseUrl === "string" ? raw.homeassistant.baseUrl.trim() : "",
      token: typeof raw.homeassistant?.token === "string" ? raw.homeassistant.token.trim() : "",
      defaultEntities: Array.isArray(raw.homeassistant?.defaultEntities)
        ? raw.homeassistant.defaultEntities.map(String)
        : [],
    },
    integrations: {
      notion: {
        token: typeof raw.integrations?.notion?.token === "string" ? raw.integrations.notion.token.trim() : "",
        defaultDatabase: typeof raw.integrations?.notion?.defaultDatabase === "string" ? raw.integrations.notion.defaultDatabase.trim() : "",
      },
      obsidian: {
        vaultPath: typeof raw.integrations?.obsidian?.vaultPath === "string" ? raw.integrations.obsidian.vaultPath.trim() : "",
      },
      calendar: {
        url: typeof raw.integrations?.calendar?.url === "string" ? raw.integrations.calendar.url.trim() : "",
        username: typeof raw.integrations?.calendar?.username === "string" ? raw.integrations.calendar.username.trim() : "",
        password: typeof raw.integrations?.calendar?.password === "string" ? raw.integrations.calendar.password.trim() : "",
      },
    },
  };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function parseTimezone(value: unknown): string {
  return normalizeTimezoneName(value);
}

function parseExcludeWindows(value: unknown): HeartbeatExcludeWindow[] {
  if (!Array.isArray(value)) return [];
  const out: HeartbeatExcludeWindow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const start = typeof (entry as any).start === "string" ? (entry as any).start.trim() : "";
    const end = typeof (entry as any).end === "string" ? (entry as any).end.trim() : "";
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) continue;

    const rawDays = Array.isArray((entry as any).days) ? (entry as any).days : [];
    const parsedDays = rawDays
      .map((d: unknown) => Number(d))
      .filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6);
    const uniqueDays = Array.from(new Set<number>(parsedDays)).sort((a: number, b: number) => a - b);

    out.push({
      start,
      end,
      days: uniqueDays.length > 0 ? uniqueDays : [...ALL_DAYS],
    });
  }
  return out;
}

function parseTimezoneOffsetMinutes(value: unknown, timezoneFallback?: string): number {
  return resolveTimezoneOffsetMinutes(value, timezoneFallback);
}

/**
 * Extract discord.allowedUserIds as raw strings from the JSON text.
 * JSON.parse destroys precision on large numeric snowflakes (>2^53),
 * so we regex them out of the raw text first.
 */
function extractDiscordUserIds(rawText: string): string[] {
  // Match the "discord" object's "allowedUserIds" array values
  const discordBlock = rawText.match(/"discord"\s*:\s*\{[\s\S]*?\}/);
  if (!discordBlock) return [];
  const arrayMatch = discordBlock[0].match(/"allowedUserIds"\s*:\s*\[([\s\S]*?)\]/);
  if (!arrayMatch) return [];
  const items: string[] = [];
  // Match both quoted strings and bare numbers
  for (const m of arrayMatch[1].matchAll(/("(\d+)"|(\d+))/g)) {
    items.push(m[2] ?? m[3]);
  }
  return items;
}

export async function loadSettings(): Promise<Settings> {
  if (cached) return cached;
  const rawText = await Bun.file(SETTINGS_FILE).text();
  const raw = JSON.parse(rawText);
  cached = parseSettings(raw, extractDiscordUserIds(rawText));
  return cached;
}

/** Re-read settings from disk, bypassing cache. */
export async function reloadSettings(): Promise<Settings> {
  const rawText = await Bun.file(SETTINGS_FILE).text();
  const raw = JSON.parse(rawText);
  cached = parseSettings(raw, extractDiscordUserIds(rawText));
  return cached;
}

export function getSettings(): Settings {
  if (!cached) throw new Error("Settings not loaded. Call loadSettings() first.");
  return cached;
}

const PROMPT_EXTENSIONS = [".md", ".txt", ".prompt"];

/**
 * If the prompt string looks like a file path (ends with .md, .txt, or .prompt),
 * read and return the file contents. Otherwise return the string as-is.
 * Relative paths are resolved from the project root (cwd).
 */
export async function resolvePrompt(prompt: string): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed) return trimmed;

  const isPath = PROMPT_EXTENSIONS.some((ext) => trimmed.endsWith(ext));
  if (!isPath) return trimmed;

  const resolved = isAbsolute(trimmed) ? trimmed : join(process.cwd(), trimmed);
  try {
    const content = await Bun.file(resolved).text();
    return content.trim();
  } catch {
    console.warn(`[config] Prompt path "${trimmed}" not found, using as literal string`);
    return trimmed;
  }
}
