// SSE (Server-Sent Events) activity feed broadcaster.
// Maintains connected clients and broadcasts activity events
// for the web dashboard and optional Discord forwarding.

export type ActivityEventType =
  | "heartbeat_start"
  | "heartbeat_result"
  | "job_start"
  | "job_result"
  | "message_received"
  | "message_response"
  | "daemon_start"
  | "daemon_stop";

export interface ActivityEvent {
  timestamp: number;
  type: ActivityEventType;
  summary: string;
  details?: Record<string, unknown>;
}

const MAX_RECENT = 50;
const recentEvents: ActivityEvent[] = [];
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();

/** Broadcast an activity event to all connected SSE clients and store it. */
export function emit(type: ActivityEventType, summary: string, details?: Record<string, unknown>): void {
  const event: ActivityEvent = {
    timestamp: Date.now(),
    type,
    summary,
    details,
  };

  recentEvents.push(event);
  if (recentEvents.length > MAX_RECENT) recentEvents.shift();

  const data = `data: ${JSON.stringify(event)}\n\n`;
  const encoded = encoder.encode(data);

  for (const controller of clients) {
    try {
      controller.enqueue(encoded);
    } catch {
      clients.delete(controller);
    }
  }
}

/** Create a new SSE response for a connecting client. */
export function createSSEStream(): Response {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      clients.add(controller);

      // Send recent events as replay
      for (const event of recentEvents) {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(data));
      }
    },
    cancel() {
      if (controllerRef) clients.delete(controllerRef);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** Return the last N activity events (default: all recent). */
export function getRecentActivity(limit = MAX_RECENT): ActivityEvent[] {
  return recentEvents.slice(-limit);
}

/** Number of currently connected SSE clients. */
export function clientCount(): number {
  return clients.size;
}

// --- Optional Discord activity feed forwarding ---

type DiscordSendFn = (channelId: string, text: string) => Promise<void>;

let discordSend: DiscordSendFn | null = null;
let discordChannelId: string | null = null;
let discordBatchTimer: ReturnType<typeof setTimeout> | null = null;
let discordBatch: string[] = [];
const DISCORD_THROTTLE_MS = 60_000; // max 1 message per minute

/** Configure Discord forwarding for the activity feed. */
export function setDiscordForwarding(
  channelId: string | null,
  sendFn: DiscordSendFn | null,
): void {
  discordChannelId = channelId;
  discordSend = sendFn;

  if (!channelId || !sendFn) {
    if (discordBatchTimer) clearTimeout(discordBatchTimer);
    discordBatchTimer = null;
    discordBatch = [];
  }
}

/** Queue an activity summary for Discord (batched/throttled). */
export function forwardToDiscordFeed(summary: string): void {
  if (!discordSend || !discordChannelId) return;

  discordBatch.push(summary);

  if (!discordBatchTimer) {
    discordBatchTimer = setTimeout(flushDiscordBatch, DISCORD_THROTTLE_MS);
  }
}

function flushDiscordBatch(): void {
  discordBatchTimer = null;
  if (!discordSend || !discordChannelId || discordBatch.length === 0) return;

  const lines = discordBatch.splice(0);
  const message = lines.join("\n");
  const sendFn = discordSend;
  const channelId = discordChannelId;

  sendFn(channelId, message.slice(0, 2000)).catch((err) => {
    console.error(`[SSE] Discord feed error: ${err}`);
  });
}
