import { createVerify } from "crypto";
import * as Alexa from "ask-sdk-core";
import type { HandlerInput, RequestHandler } from "ask-sdk-core";
import type { RequestEnvelope } from "ask-sdk-model";
import { ensureProjectClaudeMd, runInteractive } from "../runner";
import { getSettings, loadSettings } from "../config";
import { resolveSkillPrompt } from "../skills";

// --- State ---

let alexaDebug = false;
let server: ReturnType<typeof Bun.serve> | null = null;

// Certificate cache for signature verification
const certCache = new Map<string, string>();

// --- Debug ---

function debugLog(message: string): void {
  if (!alexaDebug) return;
  console.log(`[Alexa][debug] ${message}`);
}

// --- Signature Verification ---

function isValidCertUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.toLowerCase() === "s3.amazonaws.com" &&
      parsed.pathname.toLowerCase().startsWith("/echo.api/")
    );
  } catch {
    return false;
  }
}

async function getCertificate(certUrl: string): Promise<string> {
  if (certCache.has(certUrl)) return certCache.get(certUrl)!;
  const response = await fetch(certUrl);
  if (!response.ok) throw new Error(`Failed to fetch Alexa certificate: ${response.status}`);
  const cert = await response.text();
  certCache.set(certUrl, cert);
  return cert;
}

async function verifyAlexaRequest(req: Request, body: string): Promise<boolean> {
  const certUrl = req.headers.get("signaturecertchainurl");
  const signature = req.headers.get("signature");

  if (!certUrl || !signature) {
    debugLog("Missing signature headers");
    return false;
  }
  if (!isValidCertUrl(certUrl)) {
    debugLog(`Invalid cert URL: ${certUrl}`);
    return false;
  }

  try {
    // Check timestamp first (fast, no network)
    const parsed = JSON.parse(body);
    const requestTimestamp = new Date(parsed.request?.timestamp).getTime();
    if (isNaN(requestTimestamp) || Math.abs(Date.now() - requestTimestamp) > 150_000) {
      debugLog("Request timestamp out of tolerance (>150s)");
      return false;
    }

    const cert = await getCertificate(certUrl);
    const verifier = createVerify("RSA-SHA1");
    verifier.update(body);
    const valid = verifier.verify(cert, signature, "base64");
    debugLog(`Signature verification: ${valid ? "pass" : "fail"}`);
    return valid;
  } catch (err) {
    debugLog(`Verification error: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// --- Progressive Response ---

async function sendProgressiveResponse(
  apiEndpoint: string,
  apiToken: string,
  requestId: string,
  speechText: string
): Promise<void> {
  try {
    await fetch(`${apiEndpoint}/v1/directives`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        header: { requestId },
        directive: {
          type: "VoicePlayer.Speak",
          speech: `<speak>${escapeXml(speechText)}</speak>`,
        },
      }),
    });
    debugLog(`Progressive response sent: "${speechText}"`);
  } catch (err) {
    debugLog(`Progressive response failed: ${err instanceof Error ? err.message : err}`);
  }
}

// --- SSML / text helpers ---

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatForSpeech(text: string, maxChars = 750): string {
  // Strip reaction directives and markdown for spoken delivery
  let cleaned = text
    .replace(/\[react:[^\]\r\n]+\]/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!cleaned) return "<speak>Done.</speak>";

  let truncated = false;
  if (cleaned.length > maxChars) {
    const slice = cleaned.slice(0, maxChars);
    const lastPeriod = slice.lastIndexOf(".");
    cleaned = lastPeriod > maxChars * 0.5 ? slice.slice(0, lastPeriod + 1) : slice;
    truncated = true;
  }

  const ssml = escapeXml(cleaned);
  if (truncated) {
    return `<speak>${ssml} <break time="400ms"/> I've sent the full response to your Alexa app.</speak>`;
  }
  return `<speak>${ssml}</speak>`;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\[react:[^\]\r\n]+\]/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim()
    .slice(0, 8000); // Alexa card limit
}

// --- Request Handlers (ask-sdk-core pattern) ---

const LaunchRequestHandler: RequestHandler = {
  canHandle(input: HandlerInput) {
    return Alexa.getRequestType(input.requestEnvelope) === "LaunchRequest";
  },
  handle(input: HandlerInput) {
    return input.responseBuilder
      .speak("<speak>Claw is ready. What can I do for you?</speak>")
      .reprompt("<speak>Ask me anything, or say help for examples.</speak>")
      .getResponse();
  },
};

const AskClawIntentHandler: RequestHandler = {
  canHandle(input: HandlerInput) {
    return (
      Alexa.getRequestType(input.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(input.requestEnvelope) === "AskClawIntent"
    );
  },
  async handle(input: HandlerInput) {
    const config = getSettings().alexa;
    const userId = input.requestEnvelope.context.System.user.userId;

    // Authorization
    if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
      return input.responseBuilder
        .speak("<speak>Unauthorized.</speak>")
        .getResponse();
    }

    const query =
      Alexa.getSlotValue(input.requestEnvelope, "Query") ||
      Alexa.getSlotValue(input.requestEnvelope, "Topic") ||
      "";

    if (!query.trim()) {
      return input.responseBuilder
        .speak("<speak>I didn't catch that. Try saying: ask claw, followed by your question.</speak>")
        .reprompt("<speak>What would you like to ask?</speak>")
        .getResponse();
    }

    console.log(
      `[${new Date().toLocaleTimeString()}] Alexa: "${query.slice(0, 60)}${query.length > 60 ? "..." : ""}"`
    );

    const { apiEndpoint, apiAccessToken } = input.requestEnvelope.context.System as any;
    const requestId = input.requestEnvelope.request.requestId;

    // Send progressive response so Alexa speaks while Claude processes
    const progressPromise = sendProgressiveResponse(
      apiEndpoint,
      apiAccessToken,
      requestId,
      "Let me think about that for a moment."
    );

    // Send additional progressive responses every 6s for longer queries
    const progressInterval = setInterval(() => {
      sendProgressiveResponse(apiEndpoint, apiAccessToken, requestId, "Still working on it.");
    }, 6_000);

    try {
      await progressPromise;

      // Skill routing: detect slash commands
      const command = query.trim().startsWith("/")
        ? query.trim().split(/\s+/, 1)[0].toLowerCase()
        : null;
      let skillContext: string | null = null;
      if (command) {
        try {
          skillContext = await resolveSkillPrompt(command);
          if (skillContext) debugLog(`Skill resolved for ${command}`);
        } catch {
          // best-effort
        }
      }

      // Build prompt with voice instruction
      const promptParts = [
        "[Alexa voice query]",
        "IMPORTANT: Keep your response brief and conversational, suitable for spoken delivery via voice assistant. Aim for 2-3 sentences maximum.",
      ];

      if (skillContext) {
        const args = query.trim().slice(command!.length).trim();
        promptParts.push(`<command-name>${command}</command-name>`);
        promptParts.push(skillContext);
        if (args) promptParts.push(`User arguments: ${args}`);
      } else {
        promptParts.push(`Message: ${query}`);
      }

      const result = await runInteractive("alexa", promptParts.join("\n"));
      clearInterval(progressInterval);

      if (result.exitCode !== 0) {
        return input.responseBuilder
          .speak("<speak>Sorry, something went wrong. Please try again.</speak>")
          .withSimpleCard("Error", result.stderr || "Unknown error")
          .getResponse();
      }

      const rawText = result.stdout || "";
      const ssml = formatForSpeech(rawText);
      const isLong = rawText.length > 750;
      const builder = input.responseBuilder.speak(ssml);
      if (isLong) builder.withSimpleCard("Claw's Response", stripMarkdown(rawText));
      return builder.getResponse();
    } catch (err) {
      clearInterval(progressInterval);
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Alexa] Error in AskClawIntent: ${errMsg}`);
      return input.responseBuilder
        .speak("<speak>I ran into an error. Please try again.</speak>")
        .getResponse();
    }
  },
};

const StatusIntentHandler: RequestHandler = {
  canHandle(input: HandlerInput) {
    return (
      Alexa.getRequestType(input.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(input.requestEnvelope) === "StatusIntent"
    );
  },
  handle(input: HandlerInput) {
    const settings = getSettings();
    const parts: string[] = ["I'm online and running."];

    if (settings.heartbeat.enabled) {
      parts.push(`Heartbeat is active every ${settings.heartbeat.interval} minutes.`);
    }

    const integrations: string[] = [];
    if (settings.telegram.token) integrations.push("Telegram");
    if (settings.discord.token) integrations.push("Discord");
    if (settings.slack.token) integrations.push("Slack");
    if (integrations.length > 0) {
      parts.push(`Connected to ${integrations.join(", ")}.`);
    }

    return input.responseBuilder
      .speak(`<speak>${escapeXml(parts.join(" "))}</speak>`)
      .getResponse();
  },
};

const HelpIntentHandler: RequestHandler = {
  canHandle(input: HandlerInput) {
    return (
      Alexa.getRequestType(input.requestEnvelope) === "IntentRequest" &&
      Alexa.getIntentName(input.requestEnvelope) === "AMAZON.HelpIntent"
    );
  },
  handle(input: HandlerInput) {
    return input.responseBuilder
      .speak(
        "<speak>You can say things like: ask claw what's the weather, ask claw to help with code, or ask claw what's my status. What would you like to know?</speak>"
      )
      .reprompt("<speak>What would you like to ask?</speak>")
      .getResponse();
  },
};

const StopCancelIntentHandler: RequestHandler = {
  canHandle(input: HandlerInput) {
    if (Alexa.getRequestType(input.requestEnvelope) !== "IntentRequest") return false;
    const intent = Alexa.getIntentName(input.requestEnvelope);
    return intent === "AMAZON.StopIntent" || intent === "AMAZON.CancelIntent";
  },
  handle(input: HandlerInput) {
    return input.responseBuilder.speak("<speak>Goodbye!</speak>").getResponse();
  },
};

const SessionEndedRequestHandler: RequestHandler = {
  canHandle(input: HandlerInput) {
    return Alexa.getRequestType(input.requestEnvelope) === "SessionEndedRequest";
  },
  handle(input: HandlerInput) {
    debugLog("Session ended");
    return input.responseBuilder.getResponse();
  },
};

const FallbackHandler: RequestHandler = {
  canHandle() {
    return true;
  },
  handle(input: HandlerInput) {
    return input.responseBuilder
      .speak(
        "<speak>I'm not sure how to help with that. Try saying: ask claw, followed by your question.</speak>"
      )
      .reprompt("<speak>What would you like to ask?</speak>")
      .getResponse();
  },
};

// --- Skill instance ---

const skill = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    AskClawIntentHandler,
    StatusIntentHandler,
    HelpIntentHandler,
    StopCancelIntentHandler,
    SessionEndedRequestHandler,
    FallbackHandler
  )
  .create();

// --- HTTP Server ---

export function startAlexaServer(debug = false): ReturnType<typeof Bun.serve> {
  alexaDebug = debug;
  const config = getSettings().alexa;
  const { port, skillId, skipVerification } = config;

  if (server) {
    server.stop();
    server = null;
  }

  server = Bun.serve({
    port,
    async fetch(req: Request) {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      const body = await req.text();

      // Request signature verification
      if (!skipVerification) {
        const valid = await verifyAlexaRequest(req, body);
        if (!valid) {
          console.warn(`[Alexa] Rejected request: signature verification failed`);
          return new Response("Forbidden", { status: 403 });
        }
      } else {
        debugLog("Signature verification skipped (dev/skipVerification mode)");
      }

      let requestEnvelope: RequestEnvelope;
      try {
        requestEnvelope = JSON.parse(body) as RequestEnvelope;
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      // Skill ID verification
      if (skillId) {
        const requestAppId = requestEnvelope.context.System.application.applicationId;
        if (requestAppId !== skillId) {
          console.warn(`[Alexa] Rejected request: skill ID mismatch (${requestAppId})`);
          return new Response("Forbidden", { status: 403 });
        }
      }

      try {
        const responseEnvelope = await skill.invoke(requestEnvelope);
        return new Response(JSON.stringify(responseEnvelope), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error(`[Alexa] Unhandled error: ${err instanceof Error ? err.message : err}`);
        const errorResponse = {
          version: "1.0",
          response: {
            outputSpeech: {
              type: "SSML",
              ssml: "<speak>An internal error occurred. Please try again.</speak>",
            },
            shouldEndSession: true,
          },
        };
        return new Response(JSON.stringify(errorResponse), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    },
  });

  console.log(`Alexa skill endpoint listening on http://0.0.0.0:${port}`);
  if (skipVerification) {
    console.log("  [WARNING] Signature verification disabled — do NOT use in production");
  }
  console.log(`  Skill ID: ${skillId || "(not configured — set alexa.skillId in settings.json)"}`);
  console.log("  Expose via HTTPS tunnel and set endpoint in Alexa Developer Console");
  console.log("  See deploy/alexa-setup-guide.md for full setup instructions");

  return server;
}

export function stopAlexaServer(): void {
  if (server) {
    server.stop();
    server = null;
  }
}

/** Standalone entry point: bun run src/index.ts alexa */
export async function alexa(): Promise<void> {
  await loadSettings();
  await ensureProjectClaudeMd();
  const config = getSettings().alexa;

  if (!config.enabled) {
    console.error("Alexa integration is not enabled.");
    console.error("Set alexa.enabled = true in .claude/claudeclaw/settings.json");
    console.error("See deploy/alexa-setup-guide.md for full setup instructions.");
    process.exit(1);
  }

  startAlexaServer();
  console.log("Alexa skill server running. Press Ctrl+C to stop.");
  console.log("Next: expose this port via HTTPS tunnel and configure your Alexa skill endpoint.");
  console.log("See deploy/alexa-setup-guide.md for instructions.");

  // Keep process alive
  await new Promise(() => {});
}
