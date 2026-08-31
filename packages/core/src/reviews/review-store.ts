import { open, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { lock, type LockOptions } from "proper-lockfile";
import {
  REVIEW_EVENT_VERSION,
  type ReviewAuthor,
  type ReviewCreatedEvent,
  type ReviewEvent,
  type ReviewThreadLocation,
  type ReviewSeverity,
} from "@diffect/shared";
import {
  repositoryStoresDir,
  reviewEventsPath,
  reviewStoreDir,
} from "../store/paths.js";

const REVIEW_ID = /^rvw_[a-f0-9]{32}$/;
const REVIEW_THREAD_ID = /^rth_[a-f0-9]{32}$/;
const REVIEW_COMMENT_ID = /^rcm_[a-f0-9]{32}$/;
const REVIEW_OPERATION_ID = /^op_[a-f0-9]{32}$/;

const LOCK_OPTIONS: LockOptions = {
  realpath: false,
  retries: {
    retries: 50,
    factor: 1,
    minTimeout: 100,
    maxTimeout: 100,
    randomize: true,
  },
};

export class ReviewStoreCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewStoreCorruptError";
  }
}

export class ReviewStoreIncompleteError extends ReviewStoreCorruptError {
  constructor(message: string) {
    super(message);
    this.name = "ReviewStoreIncompleteError";
  }
}

export class ReviewStoreBusyError extends Error {
  constructor(message = "Review store is busy; retry shortly") {
    super(message);
    this.name = "ReviewStoreBusyError";
  }
}

export function validReviewId(value: string): boolean {
  return REVIEW_ID.test(value);
}

export function validReviewOperationId(value: string): boolean {
  return REVIEW_OPERATION_ID.test(value);
}

export function validReviewLocation(value: unknown): value is ReviewThreadLocation {
  if (!value || typeof value !== "object") return false;
  const location = value as Partial<ReviewThreadLocation>;
  return (
    typeof location.path === "string" &&
    location.path.length > 0 &&
    !isAbsolute(location.path) &&
    !location.path.includes("\\") &&
    !location.path.includes("\0") &&
    !location.path.split("/").some((part) => part === "" || part === "." || part === "..") &&
    (location.side === "old" || location.side === "new") &&
    Number.isInteger(location.startLine) &&
    location.startLine! > 0 &&
    Number.isInteger(location.endLine) &&
    location.endLine! >= location.startLine!
  );
}

export function validReviewSeverity(value: unknown): value is ReviewSeverity | null {
  return (
    value === null ||
    value === "must-fix" ||
    value === "suggestion" ||
    value === "nit" ||
    value === "question"
  );
}

export function validReviewAuthor(value: unknown): value is ReviewAuthor {
  if (!value || typeof value !== "object") return false;
  const author = value as Partial<ReviewAuthor>;
  return (
    (author.type === "user" || author.type === "agent") &&
    (author.name === undefined ||
      (typeof author.name === "string" && author.name.trim().length > 0))
  );
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
    typeof event.operationId === "string" &&
    validReviewOperationId(event.operationId) &&
    !!review &&
    REVIEW_ID.test(review.id) &&
    !!review.repository &&
    typeof review.repository.root === "string" &&
    isAbsolute(review.repository.root) &&
    !!review.worktree &&
    typeof review.worktree.root === "string" &&
    isAbsolute(review.worktree.root) &&
    validTimestamp(review.createdAt) &&
    !!thread &&
    REVIEW_THREAD_ID.test(thread.id) &&
    thread.reviewId === review.id &&
    validReviewLocation(thread.location) &&
    validReviewSeverity(thread.severity) &&
    validTimestamp(thread.createdAt) &&
    !!comment &&
    REVIEW_COMMENT_ID.test(comment.id) &&
    comment.threadId === thread.id &&
    validReviewAuthor(comment.author) &&
    typeof comment.body === "string" &&
    comment.body.trim().length > 0 &&
    validTimestamp(comment.createdAt)
  );
}

export interface ReviewWriteStore {
  readonly events: readonly ReviewEvent[];
  append(event: ReviewEvent): Promise<void>;
}

/**
 * Serialize every read-check-write mutation for one repository. The transaction
 * repairs a crash-truncated final record before exposing the current events.
 */
export async function withReviewWriteStore<T>(
  repositoryRoot: string,
  operation: (store: ReviewWriteStore) => Promise<T>,
): Promise<T> {
  const directory = reviewStoreDir(repositoryRoot);
  await mkdir(directory, { recursive: true });
  return withLock(directory, async (assertLock) => {
    assertLock();
    const events = await repairAndReadRepositoryEvents(repositoryRoot, assertLock);
    const store: ReviewWriteStore = {
      events,
      async append(event) {
        assertLock();
        if (!isReviewCreatedEvent(event)) throw new TypeError("invalid Review event");
        if (event.review.repository.root !== repositoryRoot) {
          throw new TypeError("Review repository does not match its store");
        }
        const path = reviewEventsPath(repositoryRoot, event.review.id);
        const created = await appendDurably(path, event, assertLock);
        if (created) await syncDirectory(dirname(path));
        assertLock();
        events.push(event);
      },
    };
    const result = await operation(store);
    assertLock();
    return result;
  });
}

/** Read one repository's clean Review events without repairing or reading old stores. */
export async function readRepositoryReviewEvents(
  repositoryRoot: string,
): Promise<ReviewEvent[]> {
  const ids = await listReviewIds(reviewStoreDir(repositoryRoot));
  return (await Promise.all(
    ids.map((id) => readEventFile(reviewEventsPath(repositoryRoot, id), id, true)),
  )).flat();
}

/**
 * Find only files named for the requested Review ID. Corruption in every other
 * Review and repository remains outside this exact read.
 */
export async function readExactReviewEvents(reviewId: string): Promise<ReviewEvent[]> {
  if (!validReviewId(reviewId)) return [];
  let repositories;
  try {
    repositories = await readdir(repositoryStoresDir(), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const paths = repositories
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      join(repositoryStoresDir(), entry.name, "reviews", "v1", `${reviewId}.jsonl`),
    );
  const matches = await Promise.all(paths.map((path) => readEventFile(path, reviewId)));
  return matches.flat();
}

async function repairAndReadRepositoryEvents(
  repositoryRoot: string,
  assertLock: () => void,
): Promise<ReviewEvent[]> {
  const directory = reviewStoreDir(repositoryRoot);
  const ids = await listReviewIds(directory);
  const repaired = await Promise.all(
    ids.map(async (id) => {
      const path = reviewEventsPath(repositoryRoot, id);
      const exists = await repairPartialTail(path, id, assertLock);
      return exists ? readEventFile(path, id) : [];
    }),
  );
  return repaired.flat();
}

async function listReviewIds(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => /^((?:rvw_)[a-f0-9]{32})\.jsonl$/.exec(entry.name)?.[1])
    .filter((id): id is string => id !== undefined)
    .sort();
}

async function readEventFile(
  path: string,
  expectedReviewId: string,
  allowIncompleteTail = false,
): Promise<ReviewEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (raw.length === 0) return [];

  const complete = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (complete) lines.pop();
  const events: ReviewEvent[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line) {
      throw new ReviewStoreCorruptError(`blank Review event at ${path}:${index + 1}`);
    }
    const event = parseEvent(line);
    if (!event) {
      const finalPartial = !complete && index === lines.length - 1;
      if (finalPartial && allowIncompleteTail) break;
      const ErrorType = finalPartial
        ? ReviewStoreIncompleteError
        : ReviewStoreCorruptError;
      throw new ErrorType(`invalid Review event at ${path}:${index + 1}`);
    }
    if (event.review.id !== expectedReviewId) {
      throw new ReviewStoreCorruptError(
        `Review ID does not match its event file at ${path}:${index + 1}`,
      );
    }
    events.push(event);
  }
  return events;
}

/**
 * Keep a complete JSON record that reached disk without its newline. Otherwise
 * discard only the invalid final fragment, leaving earlier records untouched.
 */
async function repairPartialTail(
  path: string,
  expectedReviewId: string,
  assertLock: () => void,
): Promise<boolean> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (raw.length === 0) {
    assertLock();
    await unlink(path);
    return false;
  }
  if (raw[raw.length - 1] === 0x0a) return true;

  const finalNewline = raw.lastIndexOf(0x0a);
  const tailStart = finalNewline + 1;
  const tail = raw.subarray(tailStart).toString("utf8");
  const event = parseEvent(tail);
  assertLock();
  const handle = await open(path, "r+");
  try {
    if (event?.review.id === expectedReviewId) {
      await handle.write("\n", raw.length, "utf8");
    } else {
      await handle.truncate(tailStart);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (!event && tailStart === 0) {
    assertLock();
    await unlink(path);
    return false;
  }
  return true;
}

async function appendDurably(
  path: string,
  event: ReviewEvent,
  assertLock: () => void,
): Promise<boolean> {
  let created = false;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "ax");
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    handle = await open(path, "a");
  }
  try {
    assertLock();
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return created;
}

async function syncDirectory(path: string): Promise<void> {
  // Windows does not expose directory handles that Node can fsync.
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function withLock<T>(
  path: string,
  operation: (assertLock: () => void) => Promise<T>,
): Promise<T> {
  let compromised: Error | undefined;
  let release: () => Promise<void>;
  try {
    release = await lock(path, {
      ...LOCK_OPTIONS,
      onCompromised(error) {
        compromised ??= error;
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new ReviewStoreBusyError();
    }
    throw error;
  }

  const assertLock = () => {
    if (compromised) {
      throw new ReviewStoreBusyError("Review store lock was compromised; retry shortly");
    }
  };
  let completed = false;
  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation(assertLock);
    completed = true;
  } catch (error) {
    operationError = error;
  }

  let releaseError: unknown;
  try {
    await release();
  } catch (error) {
    releaseError = error;
  }

  if (!completed) throw operationError;
  if (compromised) {
    throw new ReviewStoreBusyError("Review store lock was compromised; retry shortly");
  }
  if (releaseError) {
    throw new ReviewStoreBusyError(
      "Review mutation was saved but its lock could not be released; retry safely",
    );
  }
  return result as T;
}

function parseEvent(line: string): ReviewEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return isReviewCreatedEvent(parsed) ? parsed : null;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
