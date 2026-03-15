import { ensureProjectClaudeMd, runUserMessage } from "../runner";
import { getSettings, loadSettings } from "../config";
import { transcribeAudioToText } from "../whisper";
import { resolveSkillPrompt } from "../skills";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// --- State ---

let matrixClient: any = null;
let running = false;
let matrixDebug = false;
let botUserId: string | null = null;
let botDisplayName: string | null = null;
let initialSyncComplete = false;

// --- Debug ---

function debugLog(message: string): void {
  if (!matrixDebug) return;
  console.log(`[Matrix][debug] ${message}`);
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

/** Send a text message to a Matrix room ID. Used by heartbeat forwarding. */
export async function sendMessage(roomId: string, text: string): Promise<void> {
  if (!matrixClient) return;
  const normalized = text.replace(/\[react:[^\]\r\n]+\]/gi, "").trim();
  if (!normalized) return;
  const MAX_LEN = 16000;
  for (let i = 0; i < normalized.length; i += MAX_LEN) {
    await matrixClient.sendTextMessage(roomId, normalized.slice(i, i + MAX_LEN));
  }
}

/** Open or create a DM room with userId and send a message. Used by heartbeat forwarding. */
export async function sendMessageToUser(userId: string, text: string): Promise<void> {
  if (!matrixClient) return;
  try {
    // Try to find an existing direct room first
    const directRooms = matrixClient.getAccountData("m.direct")?.getContent() ?? {};
    const existingRoomIds: string[] = directRooms[userId] ?? [];
    for (const roomId of existingRoomIds) {
      const room = matrixClient.getRoom(roomId);
      if (room && room.getMyMembership() === "join") {
        await sendMessage(roomId, text);
        return;
      }
    }
    // Create a new DM room
    const result = await matrixClient.createRoom({
      is_direct: true,
      invite: [userId],
      preset: "trusted_private_chat",
    });
    await sendMessage(result.room_id, text);
  } catch (err) {
    console.error(`[Matrix] Failed to send to user ${userId}: ${err instanceof Error ? err.message : err}`);
  }
}

// --- Room helpers ---

function isDmRoom(room: any): boolean {
  const members = room.getJoinedMembers?.() ?? [];
  return members.length <= 2;
}

function isMentioned(body: string): boolean {
  if (!botUserId) return false;
  const lower = body.toLowerCase();
  if (lower.includes(botUserId.toLowerCase())) return true;
  if (botDisplayName && lower.includes(botDisplayName.toLowerCase())) return true;
  return false;
}

// --- Core message handler ---

async function handleIncomingMessage(event: any, room: any): Promise<void> {
  if (!running || !initialSyncComplete) return;
  if (event.getType() !== "m.room.message") return;

  const senderId: string = event.getSender();
  if (senderId === botUserId) return;

  const config = getSettings().matrix;
  const content = event.getContent() ?? {};
  const msgtype: string = content.msgtype ?? "";
  const body: string = content.body ?? "";
  const roomId: string = room.roomId;

  const isDM = isDmRoom(room);
  const isListenRoom = config.listenRooms.includes(roomId);

  // Trigger check: DMs, listen rooms, or mentions
  if (!isDM && !isListenRoom && !isMentioned(body)) {
    debugLog(`Skip message room=${roomId} from=${senderId} reason=no_trigger`);
    return;
  }

  // Authorization check
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(senderId)) {
    if (isDM) {
      await sendMessage(roomId, "Unauthorized.");
    } else {
      debugLog(`Skip message room=${roomId} from=${senderId} reason=unauthorized`);
    }
    return;
  }

  const isText = msgtype === "m.text";
  const isImage = msgtype === "m.image";
  const isAudio = msgtype === "m.audio";
  const isVoice = msgtype === "m.voice";
  const isFile = msgtype === "m.file";

  if (!isText && !isImage && !isAudio && !isVoice && !isFile) return;
  if (!body.trim() && !isImage && !isAudio && !isVoice) return;

  const label = senderId;
  const mediaSuffix = isImage ? " [image]" : (isAudio || isVoice) ? " [audio]" : isFile ? " [file]" : "";
  console.log(
    `[${new Date().toLocaleTimeString()}] Matrix ${label}${mediaSuffix}: "${body.slice(0, 60)}${body.length > 60 ? "..." : ""}"`
  );

  // Send typing indicator
  matrixClient.sendTyping(roomId, true, 30000).catch(() => {});

  try {
    let imagePath: string | null = null;
    let voicePath: string | null = null;
    let voiceTranscript: string | null = null;

    if (isImage || isAudio || isVoice) {
      try {
        const mxcUrl: string | undefined = content.url;
        if (mxcUrl) {
          const httpUrl: string | null = matrixClient.mxcUrlToHttp(mxcUrl);
          if (httpUrl) {
            const response = await fetch(httpUrl);
            if (response.ok) {
              const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "matrix");
              await mkdir(dir, { recursive: true });

              const mimetype: string = content.info?.mimetype ?? "";
              const ext = mimetype.split("/")[1]?.split(";")[0] || (isImage ? "jpg" : "ogg");
              const safeId = senderId.replace(/[@:]/g, "_");
              const filename = `${Date.now()}-${safeId}.${ext}`;
              const localPath = join(dir, filename);

              const bytes = new Uint8Array(await response.arrayBuffer());
              await Bun.write(localPath, bytes);

              if (isImage) {
                imagePath = localPath;
                debugLog(`Image downloaded: ${localPath}`);
              } else {
                voicePath = localPath;
                debugLog(`Audio downloaded: ${localPath}`);
              }
            }
          }
        }
      } catch (err) {
        console.error(`[Matrix] Failed to download media for ${label}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (voicePath) {
      try {
        voiceTranscript = await transcribeAudioToText(voicePath, {
          debug: matrixDebug,
          log: (m) => debugLog(m),
        });
      } catch (err) {
        console.error(`[Matrix] Failed to transcribe audio for ${label}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Skill routing
    const command = body.startsWith("/") ? body.trim().split(/\s+/, 1)[0].toLowerCase() : null;
    let skillContext: string | null = null;
    if (command) {
      try {
        skillContext = await resolveSkillPrompt(command);
        if (skillContext) debugLog(`Skill resolved for ${command}: ${skillContext.length} chars`);
      } catch (err) {
        debugLog(`Skill resolution failed for ${command}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Strip bot mention from message body
    let cleanBody = body;
    if (botUserId) {
      cleanBody = cleanBody.replace(new RegExp(botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").trim();
    }

    // Build prompt (same pattern as other bridges)
    const promptParts = [`[Matrix from ${label}]`];
    if (!isDM) promptParts.push(`[room:${roomId}]`);
    if (skillContext) {
      const args = cleanBody.trim().slice(command!.length).trim();
      promptParts.push(`<command-name>${command}</command-name>`);
      promptParts.push(skillContext);
      if (args) promptParts.push(`User arguments: ${args}`);
    } else if (cleanBody.trim()) {
      promptParts.push(`Message: ${cleanBody}`);
    }
    if (imagePath) {
      promptParts.push(`Image path: ${imagePath}`);
      promptParts.push("The user attached an image. Inspect this image file directly before answering.");
    } else if (isImage) {
      promptParts.push("The user attached an image, but downloading it failed. Ask them to resend.");
    }
    if (voiceTranscript) {
      promptParts.push(`Voice transcript: ${voiceTranscript}`);
      promptParts.push("The user attached voice audio. Use the transcript as their spoken message.");
    } else if ((isAudio || isVoice) && !voiceTranscript) {
      promptParts.push("The user attached voice audio, but it could not be transcribed. Ask them to resend a clearer clip.");
    }

    const prefixedPrompt = promptParts.join("\n");
    const result = await runUserMessage("matrix", prefixedPrompt);

    matrixClient.sendTyping(roomId, false, 0).catch(() => {});

    if (result.exitCode !== 0) {
      await sendMessage(roomId, `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`);
    } else {
      const { cleanedText } = extractReactionDirective(result.stdout || "");
      await sendMessage(roomId, cleanedText || "(empty response)");
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Matrix] Error for ${label}: ${errMsg}`);
    matrixClient.sendTyping(roomId, false, 0).catch(() => {});
    await sendMessage(roomId, `Error: ${errMsg}`);
  }
}

// --- Client factory ---

async function createMatrixClient(config: ReturnType<typeof getSettings>["matrix"]): Promise<any> {
  const sdk = await import("matrix-js-sdk") as any;
  // Suppress noisy internal logging unless debug mode
  if (!matrixDebug) {
    try {
      sdk.logger?.setLevel?.("silent");
    } catch {
      // Ignore if logger API not available
    }
  }
  return sdk.createClient({
    baseUrl: config.homeserverUrl,
    accessToken: config.accessToken,
    userId: config.userId,
  });
}

// --- Exports ---

export function stopApp(): void {
  running = false;
  botUserId = null;
  botDisplayName = null;
  initialSyncComplete = false;
  if (matrixClient) {
    matrixClient.stopClient();
    matrixClient = null;
  }
}

process.on("SIGTERM", () => { stopApp(); });
process.on("SIGINT", () => { stopApp(); });

/** Start Matrix client in-process (called by start.ts when configured). */
export function startApp(debug = false): void {
  matrixDebug = debug;
  const config = getSettings().matrix;
  if (matrixClient) stopApp();
  running = true;

  (async () => {
    await ensureProjectClaudeMd();
    matrixClient = await createMatrixClient(config);
    botUserId = config.userId;

    matrixClient.on("sync", async (state: string) => {
      if (state === "PREPARED" && !initialSyncComplete) {
        initialSyncComplete = true;
        try {
          const profileInfo = await matrixClient.getProfileInfo(botUserId!);
          botDisplayName = profileInfo?.displayname ?? null;
        } catch {
          // Profile fetch failed, continue without display name
        }
        console.log("Matrix bot started (matrix-js-sdk)");
        console.log(`  User: ${botUserId}`);
        if (botDisplayName) console.log(`  Display name: ${botDisplayName}`);
        console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
        if (config.listenRooms.length > 0) {
          console.log(`  Listen rooms: ${config.listenRooms.join(", ")}`);
        }
        if (matrixDebug) console.log("  Debug: enabled");
      }
    });

    matrixClient.on("Room.timeline", (event: any, room: any, toStartOfTimeline: boolean) => {
      if (toStartOfTimeline) return;
      handleIncomingMessage(event, room).catch((err) => {
        console.error(`[Matrix] Room.timeline unhandled: ${err}`);
      });
    });

    await matrixClient.startClient({ initialSyncLimit: 0 });
  })().catch((err) => {
    console.error(`[Matrix] Fatal: ${err instanceof Error ? err.message : err}`);
  });
}

/** Standalone entry point (bun run src/index.ts matrix) */
export async function matrix() {
  await loadSettings();
  await ensureProjectClaudeMd();
  const config = getSettings().matrix;

  if (!config.homeserverUrl || !config.accessToken || !config.userId) {
    console.error("Matrix not configured. Set matrix.homeserverUrl, matrix.accessToken, matrix.userId in .claude/claudeclaw/settings.json");
    process.exit(1);
  }

  matrixDebug = false;
  running = true;
  botUserId = config.userId;

  matrixClient = await createMatrixClient(config);

  matrixClient.on("sync", async (state: string) => {
    if (state === "PREPARED" && !initialSyncComplete) {
      initialSyncComplete = true;
      try {
        const profileInfo = await matrixClient.getProfileInfo(botUserId!);
        botDisplayName = profileInfo?.displayname ?? null;
      } catch {
        // Profile fetch failed
      }
      console.log("Matrix bot started (standalone)");
      console.log(`  User: ${botUserId}`);
      if (botDisplayName) console.log(`  Display name: ${botDisplayName}`);
      console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
    }
  });

  matrixClient.on("Room.timeline", (event: any, room: any, toStartOfTimeline: boolean) => {
    if (toStartOfTimeline) return;
    handleIncomingMessage(event, room).catch((err) => {
      console.error(`[Matrix] Room.timeline unhandled: ${err}`);
    });
  });

  await matrixClient.startClient({ initialSyncLimit: 0 });
  // Keep process alive
  await new Promise(() => {});
}
