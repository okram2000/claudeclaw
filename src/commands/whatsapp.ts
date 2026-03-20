import { ensureProjectClaudeMd, runInteractive } from "../runner";
import { getSettings, loadSettings } from "../config";
import { transcribeAudioToText } from "../whisper";
import { resolveSkillPrompt } from "../skills";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// --- State ---

let client: any = null;
let running = false;
let whatsappDebug = false;
let botNumber: string | null = null;

// --- Debug ---

function debugLog(message: string): void {
  if (!whatsappDebug) return;
  console.log(`[WhatsApp][debug] ${message}`);
}

// --- Reaction directive (same pattern as other bridges) ---

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

/** Send a message to a WhatsApp chat ID (e.g. "1234567890@c.us" or "groupid@g.us"). */
export async function sendMessage(chatId: string, text: string): Promise<void> {
  if (!client) return;
  const normalized = text.replace(/\[react:[^\]\r\n]+\]/gi, "").trim();
  if (!normalized) return;
  const MAX_LEN = 4096;
  for (let i = 0; i < normalized.length; i += MAX_LEN) {
    await client.sendMessage(chatId, normalized.slice(i, i + MAX_LEN));
  }
}

/** DM a user by phone number (international format without +, e.g. "14155551234"). */
export async function sendMessageToUser(phoneNumber: string, text: string): Promise<void> {
  const chatId = `${phoneNumber}@c.us`;
  await sendMessage(chatId, text);
}

// --- Core message handler ---

async function handleIncomingMessage(msg: any): Promise<void> {
  if (!running) return;

  // Skip messages sent by the bot itself
  if (msg.fromMe) return;

  // Skip status broadcasts
  if (msg.isStatus || msg.from === "status@broadcast") return;

  const config = getSettings().whatsapp;
  const isGroup = String(msg.from).endsWith("@g.us");
  const isDM = !isGroup;

  // Skip group messages if groups not enabled
  if (isGroup && !config.groupsEnabled) return;

  // For groups: only respond to mentions or replies to the bot
  if (isGroup) {
    const mentionedIds: string[] = msg.mentionedIds ?? [];
    const botJid = botNumber ? `${botNumber}@c.us` : null;
    const isMentioned = botJid && mentionedIds.includes(botJid);
    const bodyMentionsBotNumber = botNumber && String(msg.body).includes(botNumber);
    const isReplyToBot = msg.hasQuotedMsg && (await msg.getQuotedMessage().then((q: any) => q?.fromMe).catch(() => false));
    if (!isMentioned && !bodyMentionsBotNumber && !isReplyToBot) {
      debugLog(`Skip group message from=${msg.from} reason=no_mention`);
      return;
    }
  }

  // Determine sender (author is populated in groups, from is used in DMs)
  const senderJid: string = msg.author || msg.from;
  const senderNumber = senderJid.split("@")[0];

  // Authorization check
  if (config.allowedNumbers.length > 0 && !config.allowedNumbers.includes(senderNumber)) {
    if (isDM) {
      await sendMessage(msg.from, "Unauthorized.");
    } else {
      debugLog(`Skip message from unauthorized number ${senderNumber}`);
    }
    return;
  }

  const content = String(msg.body || "");
  const hasMedia = Boolean(msg.hasMedia);

  if (!content.trim() && !hasMedia) return;

  const label = senderNumber;
  const mediaSuffix = hasMedia ? " [media]" : "";
  console.log(
    `[${new Date().toLocaleTimeString()}] WhatsApp ${label}${mediaSuffix}: "${content.slice(0, 60)}${content.length > 60 ? "..." : ""}"`
  );

  // Typing indicator
  const chat = await msg.getChat().catch(() => null);
  if (chat) chat.sendStateTyping().catch(() => {});

  try {
    let imagePath: string | null = null;
    let voicePath: string | null = null;
    let voiceTranscript: string | null = null;

    if (hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media?.data) {
          const mimetype: string = media.mimetype || "";
          const isImage = mimetype.startsWith("image/");
          const isAudio = mimetype.startsWith("audio/") || msg.type === "ptt";

          const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "whatsapp");
          await mkdir(dir, { recursive: true });

          if (isImage) {
            const ext = mimetype.split("/")[1]?.split(";")[0] || "jpg";
            const filename = `${Date.now()}-${senderNumber}.${ext}`;
            const localPath = join(dir, filename);
            await Bun.write(localPath, Buffer.from(media.data, "base64"));
            imagePath = localPath;
            debugLog(`Image downloaded: ${localPath}`);
          } else if (isAudio) {
            const ext = mimetype.includes("ogg") ? "ogg" : mimetype.split("/")[1]?.split(";")[0] || "ogg";
            const filename = `${Date.now()}-${senderNumber}.${ext}`;
            const localPath = join(dir, filename);
            await Bun.write(localPath, Buffer.from(media.data, "base64"));
            voicePath = localPath;
            debugLog(`Audio downloaded: ${localPath}`);
          }
        }
      } catch (err) {
        console.error(`[WhatsApp] Failed to download media for ${label}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (voicePath) {
      try {
        voiceTranscript = await transcribeAudioToText(voicePath, {
          debug: whatsappDebug,
          log: (m) => debugLog(m),
        });
      } catch (err) {
        console.error(`[WhatsApp] Failed to transcribe audio for ${label}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Skill routing
    const command = content.startsWith("/") ? content.trim().split(/\s+/, 1)[0].toLowerCase() : null;
    let skillContext: string | null = null;
    if (command) {
      try {
        skillContext = await resolveSkillPrompt(command);
        if (skillContext) debugLog(`Skill resolved for ${command}: ${skillContext.length} chars`);
      } catch (err) {
        debugLog(`Skill resolution failed for ${command}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Build prompt (same pattern as other bridges)
    const promptParts = [`[WhatsApp from ${label}]`];
    if (isGroup) promptParts.push(`[group:${msg.from}]`);
    if (skillContext) {
      const args = content.trim().slice(command!.length).trim();
      promptParts.push(`<command-name>${command}</command-name>`);
      promptParts.push(skillContext);
      if (args) promptParts.push(`User arguments: ${args}`);
    } else if (content.trim()) {
      promptParts.push(`Message: ${content}`);
    }
    if (imagePath) {
      promptParts.push(`Image path: ${imagePath}`);
      promptParts.push("The user attached an image. Inspect this image file directly before answering.");
    } else if (hasMedia && !voicePath && !imagePath) {
      promptParts.push("The user attached a file, but downloading it failed. Ask them to resend.");
    }
    if (voiceTranscript) {
      promptParts.push(`Voice transcript: ${voiceTranscript}`);
      promptParts.push("The user attached voice audio. Use the transcript as their spoken message.");
    } else if (voicePath && !voiceTranscript) {
      promptParts.push("The user attached voice audio, but it could not be transcribed. Ask them to resend a clearer clip.");
    }

    const prefixedPrompt = promptParts.join("\n");
    const result = await runInteractive("whatsapp", prefixedPrompt);

    if (chat) chat.clearState().catch(() => {});

    if (result.exitCode !== 0) {
      await sendMessage(msg.from, `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`);
    } else {
      const { cleanedText } = extractReactionDirective(result.stdout || "");
      await sendMessage(msg.from, cleanedText || "(empty response)");
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[WhatsApp] Error for ${label}: ${errMsg}`);
    if (chat) chat.clearState().catch(() => {});
    await sendMessage(msg.from, `Error: ${errMsg}`);
  }
}

// --- Client factory ---

async function createWhatsAppClient(): Promise<any> {
  const { Client, LocalAuth } = await import("whatsapp-web.js") as any;
  const sessionPath = join(process.cwd(), ".claude", "claudeclaw", "whatsapp-session");
  return new Client({
    authStrategy: new LocalAuth({ dataPath: sessionPath }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    },
  });
}

function attachClientHandlers(c: any, config: ReturnType<typeof getSettings>["whatsapp"]): void {
  c.on("qr", async (qr: string) => {
    console.log("[WhatsApp] Scan the QR code below to authenticate:");
    try {
      const qrcode = await import("qrcode-terminal") as any;
      (qrcode.default ?? qrcode).generate(qr, { small: true });
    } catch {
      console.log("[WhatsApp] QR data (paste into a QR generator):", qr);
    }
  });

  c.on("authenticated", () => {
    debugLog("WhatsApp authenticated");
  });

  c.on("ready", () => {
    botNumber = c.info?.wid?.user ?? null;
    console.log("WhatsApp bot started (whatsapp-web.js)");
    console.log(`  Number: ${botNumber ?? "unknown"}`);
    console.log(`  Allowed numbers: ${config.allowedNumbers.length === 0 ? "all" : config.allowedNumbers.join(", ")}`);
    console.log(`  Groups: ${config.groupsEnabled ? "enabled" : "disabled"}`);
    if (whatsappDebug) console.log("  Debug: enabled");
  });

  c.on("message", (msg: any) => {
    handleIncomingMessage(msg).catch((err) => {
      console.error(`[WhatsApp] Unhandled message error: ${err}`);
    });
  });

  c.on("disconnected", (reason: string) => {
    console.log(`[WhatsApp] Disconnected: ${reason}`);
    if (running && client) {
      setTimeout(() => {
        if (running && client) {
          client.initialize().catch((err: Error) => {
            console.error(`[WhatsApp] Reconnect failed: ${err.message}`);
          });
        }
      }, 5000);
    }
  });
}

// --- Exports ---

export { sendMessage as sendMessageToChat };

export function stopApp(): void {
  running = false;
  botNumber = null;
  if (client) {
    client.destroy().catch(() => {});
    client = null;
  }
}

process.on("SIGTERM", () => { stopApp(); });
process.on("SIGINT", () => { stopApp(); });

/** Start WhatsApp client in-process (called by start.ts when configured). */
export function startApp(debug = false): void {
  whatsappDebug = debug;
  const config = getSettings().whatsapp;
  if (client) stopApp();
  running = true;

  (async () => {
    await ensureProjectClaudeMd();
    client = await createWhatsAppClient();
    attachClientHandlers(client, config);
    await client.initialize();
  })().catch((err) => {
    console.error(`[WhatsApp] Fatal: ${err instanceof Error ? err.message : err}`);
  });
}

/** Standalone entry point (bun run src/index.ts whatsapp) */
export async function whatsapp() {
  await loadSettings();
  await ensureProjectClaudeMd();
  const config = getSettings().whatsapp;
  running = true;

  client = await createWhatsAppClient();
  attachClientHandlers(client, config);

  console.log("WhatsApp bot starting (standalone)...");
  await client.initialize();
  // Keep process alive
  await new Promise(() => {});
}
