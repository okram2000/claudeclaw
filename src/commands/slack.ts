import { App as BoltApp, LogLevel } from "@slack/bolt";
import { ensureProjectClaudeMd, runUserMessage } from "../runner";
import { getSettings, loadSettings } from "../config";
import { resetSession } from "../sessions";
import { transcribeAudioToText } from "../whisper";
import { resolveSkillPrompt } from "../skills";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";

// --- State ---

let app: BoltApp | null = null;
let running = false;
let slackDebug = false;
let botUserId: string | null = null;

// In-memory cache to avoid repeated users.info calls
const userNameCache = new Map<string, string>();

// --- Debug ---

function debugLog(message: string): void {
  if (!slackDebug) return;
  console.log(`[Slack][debug] ${message}`);
}

// --- Reaction directive (same pattern as discord.ts / telegram.ts) ---

function extractReactionDirective(text: string): { cleanedText: string; reactionEmoji: string | null } {
  let reactionEmoji: string | null = null;
  const cleanedText = text
    .replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (!reactionEmoji && candidate) reactionEmoji = candidate;
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, reactionEmoji };
}

// --- Message sending ---

/** Send a message to a channel, splitting at 3000 chars. Used by heartbeat forwarding. */
export async function sendMessage(channel: string, text: string, threadTs?: string): Promise<void> {
  if (!app) return;
  const config = getSettings().slack;
  const normalized = text.replace(/\[react:[^\]\r\n]+\]/gi, "").trim();
  if (!normalized) return;
  const MAX_LEN = 3000;
  for (let i = 0; i < normalized.length; i += MAX_LEN) {
    await app.client.chat.postMessage({
      token: config.token,
      channel,
      text: normalized.slice(i, i + MAX_LEN),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }
}

/** Open a DM channel with userId and send a message. Used by heartbeat forwarding. */
export async function sendMessageToUser(userId: string, text: string): Promise<void> {
  if (!app) return;
  const config = getSettings().slack;
  const result = await app.client.conversations.open({
    token: config.token,
    users: userId,
  });
  const channelId = (result.channel as any)?.id as string | undefined;
  if (!channelId) return;
  await sendMessage(channelId, text);
}

// --- Reactions ---

async function addReaction(channel: string, ts: string, name: string): Promise<void> {
  if (!app) return;
  const config = getSettings().slack;
  try {
    await app.client.reactions.add({ token: config.token, channel, timestamp: ts, name });
  } catch {
    // best-effort
  }
}

async function removeReaction(channel: string, ts: string, name: string): Promise<void> {
  if (!app) return;
  const config = getSettings().slack;
  try {
    await app.client.reactions.remove({ token: config.token, channel, timestamp: ts, name });
  } catch {
    // best-effort
  }
}

// --- User name lookup (cached) ---

async function getUserName(userId: string): Promise<string> {
  if (userNameCache.has(userId)) return userNameCache.get(userId)!;
  if (!app) return userId;
  const config = getSettings().slack;
  try {
    const result = await app.client.users.info({ token: config.token, user: userId });
    const user = result.user as any;
    const name: string = user?.profile?.display_name || user?.name || userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

// --- File download ---

interface SlackFile {
  url_private: string;
  name: string;
  mimetype: string;
  subtype?: string;
}

async function downloadSlackFile(
  url: string,
  token: string,
  type: "image" | "voice",
  filename: string,
): Promise<string | null> {
  const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "slack");
  await mkdir(dir, { recursive: true });

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Slack file download failed: ${response.status}`);

  const ext = extname(filename) || (type === "voice" ? ".ogg" : ".jpg");
  const localFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const localPath = join(dir, localFilename);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await Bun.write(localPath, bytes);
  debugLog(`File downloaded: ${localPath} (${bytes.length} bytes)`);
  return localPath;
}

// --- Core message handler ---

async function handleIncomingMessage(params: {
  text: string;
  userId: string;
  channelId: string;
  threadTs?: string;
  messageTs: string;
  isDM: boolean;
  files?: SlackFile[];
}): Promise<void> {
  const config = getSettings().slack;
  const { text, userId, channelId, threadTs, messageTs, isDM, files = [] } = params;

  // Authorization
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
    if (isDM) {
      await sendMessage(channelId, "Unauthorized.");
    } else {
      debugLog(`Skip message channel=${channelId} from=${userId} reason=unauthorized`);
    }
    return;
  }

  // Detect files
  const imageFiles = files.filter((f) => f.mimetype?.startsWith("image/"));
  const voiceFiles = files.filter((f) => f.mimetype?.startsWith("audio/") || f.subtype === "slack_audio");
  const hasImage = imageFiles.length > 0;
  const hasVoice = voiceFiles.length > 0;

  if (!text.trim() && !hasImage && !hasVoice) return;

  const userName = await getUserName(userId);

  const mediaParts = [hasImage ? "image" : "", hasVoice ? "voice" : ""].filter(Boolean);
  const mediaSuffix = mediaParts.length > 0 ? ` [${mediaParts.join("+")}]` : "";
  console.log(
    `[${new Date().toLocaleTimeString()}] Slack ${userName}${mediaSuffix}: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`,
  );

  // Threading: reply in existing thread, or create one from the top-level message
  const replyThreadTs = threadTs || messageTs;

  // Ack reaction: 👀 while processing
  await addReaction(channelId, messageTs, "eyes");

  try {
    let imagePath: string | null = null;
    let voicePath: string | null = null;
    let voiceTranscript: string | null = null;

    if (hasImage) {
      try {
        imagePath = await downloadSlackFile(imageFiles[0].url_private, config.token, "image", imageFiles[0].name);
      } catch (err) {
        console.error(`[Slack] Failed to download image for ${userName}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (hasVoice) {
      try {
        voicePath = await downloadSlackFile(voiceFiles[0].url_private, config.token, "voice", voiceFiles[0].name);
      } catch (err) {
        console.error(`[Slack] Failed to download voice for ${userName}: ${err instanceof Error ? err.message : err}`);
      }
      if (voicePath) {
        try {
          debugLog(`Voice file saved: path=${voicePath}`);
          voiceTranscript = await transcribeAudioToText(voicePath, {
            debug: slackDebug,
            log: (msg) => debugLog(msg),
          });
        } catch (err) {
          console.error(`[Slack] Failed to transcribe voice for ${userName}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Skill routing: detect slash commands and resolve to SKILL.md prompts
    const command = text.trim().startsWith("/") ? text.trim().split(/\s+/, 1)[0].toLowerCase() : null;
    let skillContext: string | null = null;
    if (command) {
      try {
        skillContext = await resolveSkillPrompt(command);
        if (skillContext) debugLog(`Skill resolved for ${command}: ${skillContext.length} chars`);
      } catch (err) {
        debugLog(`Skill resolution failed for ${command}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Build prompt (same pattern as Discord/Telegram)
    const promptParts = [`[Slack from ${userName}]`];
    if (threadTs) promptParts.push(`[thread:${threadTs}]`);
    if (skillContext) {
      const args = text.trim().slice(command!.length).trim();
      promptParts.push(`<command-name>${command}</command-name>`);
      promptParts.push(skillContext);
      if (args) promptParts.push(`User arguments: ${args}`);
    } else if (text.trim()) {
      promptParts.push(`Message: ${text}`);
    }
    if (imagePath) {
      promptParts.push(`Image path: ${imagePath}`);
      promptParts.push("The user attached an image. Inspect this image file directly before answering.");
    } else if (hasImage) {
      promptParts.push("The user attached an image, but downloading it failed. Respond and ask them to resend.");
    }
    if (voiceTranscript) {
      promptParts.push(`Voice transcript: ${voiceTranscript}`);
      promptParts.push("The user attached voice audio. Use the transcript as their spoken message.");
    } else if (hasVoice) {
      promptParts.push("The user attached voice audio, but it could not be transcribed. Respond and ask them to resend a clearer clip.");
    }

    const prefixedPrompt = promptParts.join("\n");
    const result = await runUserMessage("slack", prefixedPrompt);

    await removeReaction(channelId, messageTs, "eyes");

    if (result.exitCode !== 0) {
      await sendMessage(channelId, `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`, replyThreadTs);
    } else {
      const { cleanedText, reactionEmoji } = extractReactionDirective(result.stdout || "");
      if (reactionEmoji) {
        // Strip surrounding colons if present (e.g. ":tada:" → "tada")
        const emojiName = reactionEmoji.replace(/^:|:$/g, "");
        await addReaction(channelId, messageTs, emojiName).catch(() => {});
      } else {
        await addReaction(channelId, messageTs, "white_check_mark").catch(() => {});
      }
      await sendMessage(channelId, cleanedText || "(empty response)", replyThreadTs);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Slack] Error for ${userName}: ${errMsg}`);
    await removeReaction(channelId, messageTs, "eyes").catch(() => {});
    await sendMessage(channelId, `Error: ${errMsg}`, replyThreadTs);
  }
}

// --- Register Bolt event handlers ---

function registerHandlers(boltApp: BoltApp): void {
  // DMs + listen-channel messages
  boltApp.event("message", async ({ event }) => {
    const msg = event as any;
    const subtype: string | undefined = msg.subtype;

    // Skip bot messages and system subtypes
    if (msg.bot_id || subtype === "bot_message" || subtype === "message_changed" || subtype === "message_deleted") return;
    // Allow regular messages and file shares; skip anything else with a subtype
    if (subtype && subtype !== "file_share") return;

    const config = getSettings().slack;
    const userId = msg.user as string;
    if (!userId) return;

    const channelId = event.channel as string;
    const isDM = msg.channel_type === "im" || channelId.startsWith("D");

    // For non-DM channels: only respond in configured listenChannels (app_mention handles @mentions)
    if (!isDM && !config.listenChannels.includes(channelId)) return;

    const text = ((msg.text as string) || "").trim();
    const files: SlackFile[] = ((msg.files as any[]) || []).map((f: any) => ({
      url_private: f.url_private as string,
      name: (f.name as string) || "file",
      mimetype: (f.mimetype as string) || "",
      subtype: f.subtype as string | undefined,
    }));

    await handleIncomingMessage({
      text,
      userId,
      channelId,
      threadTs: msg.thread_ts as string | undefined,
      messageTs: msg.ts as string,
      isDM,
      files,
    }).catch((err) => console.error(`[Slack] message handler error: ${err}`));
  });

  // @mentions in channels
  boltApp.event("app_mention", async ({ event }) => {
    const msg = event as any;
    const userId = event.user;
    if (!userId) return;
    const channelId = event.channel;

    // Strip the bot mention from text
    let text: string = (event.text || "").trim();
    if (botUserId) {
      text = text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
    }

    const files: SlackFile[] = ((msg.files as any[]) || []).map((f: any) => ({
      url_private: f.url_private as string,
      name: (f.name as string) || "file",
      mimetype: (f.mimetype as string) || "",
      subtype: f.subtype as string | undefined,
    }));

    await handleIncomingMessage({
      text,
      userId,
      channelId,
      threadTs: msg.thread_ts as string | undefined,
      messageTs: event.ts,
      isDM: false,
      files,
    }).catch((err) => console.error(`[Slack] app_mention handler error: ${err}`));
  });

  // Slash commands
  boltApp.command("/start", async ({ ack, respond }) => {
    await ack();
    await respond("Hello! Send me a message and I'll respond using Claude.\nUse `/reset` to start a fresh session.");
  });

  boltApp.command("/reset", async ({ ack, respond }) => {
    await ack();
    await resetSession();
    await respond("Global session reset. Next message starts fresh.");
  });
}

// --- Exports ---

/** Stop the Slack bot and clear state (used for token rotation / hot reload). */
export function stopApp(): void {
  running = false;
  botUserId = null;
  userNameCache.clear();
  if (app) {
    app.stop().catch(() => {});
    app = null;
  }
}

process.on("SIGTERM", () => { stopApp(); });
process.on("SIGINT", () => { stopApp(); });

/** Start the Slack bot in-process (called by start.ts when tokens are configured). */
export function startApp(debug = false): void {
  slackDebug = debug;
  const config = getSettings().slack;
  if (app) stopApp();
  running = true;

  app = new BoltApp({
    token: config.token,
    socketMode: true,
    appToken: config.appToken,
    logLevel: debug ? LogLevel.DEBUG : LogLevel.ERROR,
  });

  registerHandlers(app);

  (async () => {
    await ensureProjectClaudeMd();
    await app!.start();
    try {
      const authResult = await app!.client.auth.test({ token: config.token });
      botUserId = String(authResult.user_id);
      console.log("Slack bot started (socket mode)");
      console.log(`  Bot: ${String(authResult.user)} (${botUserId})`);
      console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
      if (config.listenChannels.length > 0) {
        console.log(`  Listen channels: ${config.listenChannels.join(", ")}`);
      }
      if (slackDebug) console.log("  Debug: enabled");
    } catch (err) {
      console.error(`[Slack] auth.test failed: ${err instanceof Error ? err.message : err}`);
    }
  })().catch((err) => {
    console.error(`[Slack] Fatal: ${err instanceof Error ? err.message : err}`);
  });
}

/** Standalone entry point (bun run src/index.ts slack) */
export async function slack() {
  await loadSettings();
  await ensureProjectClaudeMd();
  const config = getSettings().slack;

  if (!config.token) {
    console.error("Slack bot token not configured. Set slack.token in .claude/claudeclaw/settings.json");
    process.exit(1);
  }
  if (!config.appToken) {
    console.error("Slack app token not configured. Set slack.appToken in .claude/claudeclaw/settings.json");
    process.exit(1);
  }

  app = new BoltApp({
    token: config.token,
    socketMode: true,
    appToken: config.appToken,
    logLevel: slackDebug ? LogLevel.DEBUG : LogLevel.ERROR,
  });

  registerHandlers(app);

  await app.start();
  try {
    const authResult = await app.client.auth.test({ token: config.token });
    botUserId = String(authResult.user_id);
    console.log("Slack bot started (socket mode, standalone)");
    console.log(`  Bot: ${String(authResult.user)} (${botUserId})`);
    console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
    if (config.listenChannels.length > 0) {
      console.log(`  Listen channels: ${config.listenChannels.join(", ")}`);
    }
  } catch {
    console.log("Slack bot started (socket mode, standalone)");
  }

  // Keep process alive
  await new Promise(() => {});
}
