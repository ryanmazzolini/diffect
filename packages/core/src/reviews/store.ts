import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  REVIEW_EVENT_VERSION,
  type Author,
  type ReviewCreatedEvent,
  type ReviewThreadLocation,
  type Severity,
} from "@diffect/shared";
import {
  repositoryStoresDir,
  reviewEventsPath,
} from "../store/paths.js";

export class ReviewStoreCorruptError extends Error {}

export function validReviewId(value: string): boolean {
  return /^rvw_[a-f0-9]{32}$/.test(value);
}

export function validReviewThreadId(value: string): boolean {
  return /^rth_[a-f0-9]{32}$/.test(value);
}

export function validReviewCommentId(value: string): boolean {
  return /^rcm_[a-f0-9]{32}$/.test(value);
}

export function validReviewLocation(value: unknown): value is ReviewThreadLocation {
  if (!value || typeof value !== "object") return false;
  const location = value as Partial<ReviewThreadLocation>;
  return (
    typeof location.path === "string" &&
    location.path.length > 0 &&
    !isAbsolute(location.path) &&
    !location.path.includes("\\") &&
    !location.path.split("/").some((part) => part === "" || part === "." || part === "..") &&
    (location.side === "old" || location.side === "new") &&
    Number.isInteger(location.startLine) &&
    location.startLine! > 0 &&
    Number.isInteger(location.endLine) &&
    location.endLine! >= location.startLine!
  );
}

export function validSeverity(value: unknown): value is Severity | null {
  return (
    value === null ||
    value === "must-fix" ||
    value === "suggestion" ||
    value === "nit" ||
    value === "question"
  );
}

export function validAuthor(value: unknown): value is Author {
  if (!value || typeof value !== "object") return false;
  const author = value as Partial<Author>;
  return (
    (author.type === "user" || author.type === "agent") &&
    (author.name === undefined ||
      (typeof author.name === "string" && author.name.trim().length > 0))
  );
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function isReviewCreatedEvent(value: unknown): value is ReviewCreatedEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<ReviewCreatedEvent>;
  const review = event.review;
  const thread = event.initialThread;
  const comment = event.initialComment;
  return (
    event.version === REVIEW_EVENT_VERSION &&
    event.type === "review.created" &&
    !!review &&
    validReviewId(review.id) &&
    !!review.repository &&
    typeof review.repository.root === "string" &&
    isAbsolute(review.repository.root) &&
    !!review.worktree &&
    typeof review.worktree.root === "string" &&
    isAbsolute(review.worktree.root) &&
    validTimestamp(review.createdAt) &&
    !!thread &&
    validReviewThreadId(thread.id) &&
    thread.reviewId === review.id &&
    validReviewLocation(thread.location) &&
    validSeverity(thread.severity) &&
    validTimestamp(thread.createdAt) &&
    !!comment &&
    validReviewCommentId(comment.id) &&
    comment.threadId === thread.id &&
    validAuthor(comment.author) &&
    typeof comment.body === "string" &&
    comment.body.trim().length > 0 &&
    validTimestamp(comment.createdAt)
  );
}

async function readEventFile(path: string): Promise<ReviewCreatedEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
  if (lines.length === 1 && lines[0] === "") return [];
  const events: ReviewCreatedEvent[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line) {
      throw new ReviewStoreCorruptError(`blank Review event at ${path}:${index + 1}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ReviewStoreCorruptError(`invalid Review event at ${path}:${index + 1}`);
    }
    if (!isReviewCreatedEvent(parsed)) {
      throw new ReviewStoreCorruptError(`unsupported Review event at ${path}:${index + 1}`);
    }
    events.push(parsed);
  }
  return events;
}

export async function readRepositoryReviewEvents(
  repositoryRoot: string,
): Promise<ReviewCreatedEvent[]> {
  return readEventFile(reviewEventsPath(repositoryRoot));
}

export async function appendReviewEvent(event: ReviewCreatedEvent): Promise<void> {
  if (!isReviewCreatedEvent(event)) {
    throw new TypeError("invalid Review event");
  }
  const path = reviewEventsPath(event.review.repository.root);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

/** Enumerate only clean Review logs. Legacy thread and space stores are invisible. */
export async function readAllReviewEvents(): Promise<ReviewCreatedEvent[]> {
  let entries;
  try {
    entries = await readdir(repositoryStoresDir(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const paths = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(repositoryStoresDir(), entry.name, "reviews", "v1", "events.jsonl"));
  return (await Promise.all(paths.map(readEventFile))).flat();
}
