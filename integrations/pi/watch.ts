import { resolve } from "node:path";

const FEEDBACK_EVENT = "feedback.added";

export type FeedbackAuthor = {
  type: "user" | "agent";
  name?: string;
};

export type FeedbackEvent = {
  eventId: string;
  workspacePaths: string[];
  threadId: string;
  source: "thread.created" | "comment.added";
  author: FeedbackAuthor;
};

export type FeedbackFilter = {
  workspaceRoot: string;
  includeAgents: boolean;
  agentName: string;
};

export type WatchConnectionState = "connecting" | "connected" | "reconnecting";

type WatchFeedbackOptions = {
  baseUrl: string;
  signal: AbortSignal;
  onFeedback: (event: FeedbackEvent) => void;
  onState?: (state: WatchConnectionState, error?: Error) => void;
  reconnect?: (signal: AbortSignal) => Promise<string>;
  fetchImpl?: typeof fetch;
  reconnectDelayMs?: number;
};

export function parseFeedbackEvent(value: unknown): FeedbackEvent | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.eventId !== "string" ||
    !/^[A-Za-z0-9._:#-]{1,256}$/.test(value.eventId) ||
    !Array.isArray(value.workspacePaths) ||
    value.workspacePaths.length === 0 ||
    !value.workspacePaths.every((path) => typeof path === "string" && path.length > 0) ||
    typeof value.threadId !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(value.threadId) ||
    (value.source !== "thread.created" && value.source !== "comment.added") ||
    !isRecord(value.author) ||
    (value.author.type !== "user" && value.author.type !== "agent") ||
    (value.author.name !== undefined && typeof value.author.name !== "string") ||
    (value.author.type === "agent" &&
      (typeof value.author.name !== "string" || !value.author.name.trim()))
  ) {
    return null;
  }

  return {
    eventId: value.eventId,
    workspacePaths: [...new Set(value.workspacePaths)],
    threadId: value.threadId,
    source: value.source,
    author: {
      type: value.author.type,
      ...(value.author.name ? { name: value.author.name } : {}),
    },
  };
}

export function filterFeedbackJson(stdout: string, ids: string[]): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("diffect list returned invalid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("diffect list returned an invalid feedback list");

  const wanted = new Set(ids);
  const filtered = parsed.filter(
    (thread) => isRecord(thread) && typeof thread.id === "string" && wanted.has(thread.id),
  );
  return JSON.stringify(filtered, null, 2);
}

export function acceptsFeedback(event: FeedbackEvent, filter: FeedbackFilter): boolean {
  const workspace = resolve(filter.workspaceRoot);
  if (!event.workspacePaths.some((path) => resolve(path) === workspace)) return false;
  if (event.author.type === "user") return true;
  if (!filter.includeAgents) return false;
  return event.author.name !== filter.agentName;
}

/** Remember one event id in insertion order. Returns false for a duplicate. */
export function rememberEventId(
  seen: Set<string>,
  eventId: string,
  limit = 512,
): boolean {
  if (seen.has(eventId)) return false;
  seen.add(eventId);
  while (seen.size > limit) {
    const oldest = seen.values().next().value as string | undefined;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  return true;
}

export async function watchFeedbackEvents(options: WatchFeedbackOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  let baseUrl = options.baseUrl;
  let lastEventId: string | undefined;
  let firstAttempt = true;

  while (!options.signal.aborted) {
    options.onState?.(firstAttempt ? "connecting" : "reconnecting");
    try {
      if (!firstAttempt && options.reconnect) baseUrl = await options.reconnect(options.signal);
      const headers: Record<string, string> = { accept: "text/event-stream" };
      if (lastEventId) headers["last-event-id"] = lastEventId;
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/events`, {
        headers,
        signal: options.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Diffect event stream returned ${response.status} ${response.statusText}`.trim());
      }
      options.onState?.("connected");
      await readFeedbackStream(
        response.body,
        options.signal,
        options.onFeedback,
        (id) => {
          lastEventId = id;
        },
      );
      if (!options.signal.aborted) throw new Error("Diffect event stream closed");
    } catch (error) {
      if (options.signal.aborted) return;
      options.onState?.("reconnecting", toError(error));
      firstAttempt = false;
      await wait(reconnectDelayMs, options.signal);
    }
  }
}

export async function readFeedbackStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onFeedback: (event: FeedbackEvent) => void,
  onEventId?: (eventId: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancel = () => void reader.cancel();
  signal.addEventListener("abort", cancel, { once: true });

  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) {
          if (parsed.eventId) onEventId?.(parsed.eventId);
          onFeedback(parsed.feedback);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
  }
}

function parseSseFrame(
  frame: string,
): { feedback: FeedbackEvent; eventId?: string } | null {
  const lines = frame.split("\n");
  const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
  if (eventName !== FEEDBACK_EVENT) return null;

  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;

  try {
    const feedback = parseFeedbackEvent(JSON.parse(data));
    if (!feedback) return null;
    const rawEventId = lines.find((line) => line.startsWith("id:"))?.slice(3).trim();
    const eventId = rawEventId === feedback.eventId ? rawEventId : undefined;
    return { feedback, ...(eventId ? { eventId } : {}) };
  } catch {
    return null;
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait) => {
    if (signal.aborted) return resolveWait();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });

    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolveWait();
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
