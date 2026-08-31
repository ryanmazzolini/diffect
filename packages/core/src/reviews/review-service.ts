import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  REVIEW_EVENT_VERSION,
  type PromoteFirstReviewComment,
  type Review,
  type ReviewComment,
  type ReviewCreatedEvent,
  type ReviewDetail,
  type ReviewEvent,
  type ReviewId,
  type ReviewThread,
} from "@diffect/shared";
import { CANONICAL_LOCAL_ORIGIN } from "../daemon-manager.js";
import {
  readExactReviewEvents,
  readRepositoryReviewEvents,
  ReviewStoreBusyError,
  ReviewStoreCorruptError,
  ReviewStoreIncompleteError,
  validReviewAuthor,
  validReviewId,
  validReviewLocation,
  validReviewOperationId,
  validReviewSeverity,
  withReviewWriteStore,
} from "./review-store.js";

export {
  ReviewStoreBusyError,
  ReviewStoreCorruptError,
  ReviewStoreIncompleteError,
};

export interface ReviewContext {
  /** Canonicalized before use and expected to identify the primary checkout. */
  repositoryRoot: string;
  /** Canonicalized checkout whose Current changes the Review follows. */
  worktreeRoot: string;
}

export class UnknownReviewError extends Error {
  constructor(id: string) {
    super(`unknown Review: ${id}`);
    this.name = "UnknownReviewError";
  }
}

export class ExistingWritableReviewError extends Error {
  constructor(public readonly review: ReviewDetail) {
    super(`working context already has Review ${review.id}`);
    this.name = "ExistingWritableReviewError";
  }
}

export class DuplicateReviewIdError extends ReviewStoreCorruptError {
  constructor(id: string) {
    super(`duplicate Review ID: ${id}`);
    this.name = "DuplicateReviewIdError";
  }
}

export class DuplicateWritableReviewError extends ReviewStoreCorruptError {
  constructor(count: number) {
    super(`working context has ${count} writable Reviews`);
    this.name = "DuplicateWritableReviewError";
  }
}

export class ReviewOperationConflictError extends Error {
  constructor(operationId: string) {
    super(`Review operation ${operationId} was already used for different input`);
    this.name = "ReviewOperationConflictError";
  }
}

export class InvalidFirstReviewCommentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFirstReviewCommentError";
  }
}

interface ReviewServiceOptions {
  now?: () => string;
  idBytes?: () => string;
  origin?: string;
  beforeAppend?: (event: ReviewCreatedEvent) => void | Promise<void>;
}

export class ReviewService {
  private readonly now: () => string;
  private readonly idBytes: () => string;
  private readonly origin: string;
  private readonly beforeAppend?: ReviewServiceOptions["beforeAppend"];

  constructor(options: ReviewServiceOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idBytes = options.idBytes ?? (() => randomBytes(16).toString("hex"));
    this.origin = (options.origin ?? CANONICAL_LOCAL_ORIGIN).replace(/\/$/, "");
    this.beforeAppend = options.beforeAppend;
  }

  async findWritable(context: ReviewContext): Promise<ReviewDetail | null> {
    const canonical = await canonicalContext(context);
    const matches = (await readRepositoryReviewEvents(canonical.repositoryRoot))
      .filter((event) => sameContext(event, canonical));
    if (matches.length > 1) throw new DuplicateWritableReviewError(matches.length);
    return matches[0] ? detailFromEvent(matches[0]) : null;
  }

  async promoteFirstComment(
    context: ReviewContext,
    input: PromoteFirstReviewComment,
  ): Promise<ReviewDetail> {
    ensureFirstComment(input);
    const canonical = await canonicalContext(context);
    return withReviewWriteStore(canonical.repositoryRoot, async (store) => {
      const operationMatches = store.events.filter(
        (event) => event.operationId === input.operationId,
      );
      if (operationMatches.length > 1) {
        throw new ReviewStoreCorruptError(
          `duplicate Review operation ID: ${input.operationId}`,
        );
      }
      const retried = operationMatches[0];
      if (retried) {
        if (!sameRequest(retried, canonical, input)) {
          throw new ReviewOperationConflictError(input.operationId);
        }
        return detailFromEvent(retried);
      }

      const writable = store.events.filter((event) => sameContext(event, canonical));
      if (writable.length > 1) throw new DuplicateWritableReviewError(writable.length);
      if (writable[0]) throw new ExistingWritableReviewError(detailFromEvent(writable[0]));

      const event = this.createEvent(canonical, input, store.events);
      await this.beforeAppend?.(event);
      await store.append(event);
      return detailFromEvent(event);
    });
  }

  async getReview(id: ReviewId): Promise<ReviewDetail> {
    if (!validReviewId(id)) throw new UnknownReviewError(id);
    const matches = (await readExactReviewEvents(id)).filter(
      (event) => event.review.id === id,
    );
    if (matches.length === 0) throw new UnknownReviewError(id);
    if (matches.length > 1) throw new DuplicateReviewIdError(id);
    return detailFromEvent(matches[0]!);
  }

  linkFor(id: ReviewId): string {
    if (!validReviewId(id)) throw new UnknownReviewError(id);
    return `${this.origin}/reviews/${id}`;
  }

  private createEvent(
    context: ReviewContext,
    input: PromoteFirstReviewComment,
    existing: readonly ReviewEvent[],
  ): ReviewCreatedEvent {
    const createdAt = this.now();
    const review: Review = {
      id: this.nextId("rvw", new Set(existing.map((event) => event.review.id))),
      repository: { root: context.repositoryRoot },
      worktree: { root: context.worktreeRoot },
      createdAt,
    };
    const thread: ReviewThread = {
      id: this.nextId(
        "rth",
        new Set(existing.map((event) => event.initialThread.id)),
      ),
      reviewId: review.id,
      location: input.location,
      severity: input.severity,
      createdAt,
    };
    const comment: ReviewComment = {
      id: this.nextId(
        "rcm",
        new Set(existing.map((event) => event.initialComment.id)),
      ),
      threadId: thread.id,
      author: input.author,
      body: input.body.trim(),
      createdAt,
    };
    return {
      version: REVIEW_EVENT_VERSION,
      type: "review.created",
      operationId: input.operationId,
      review,
      initialThread: thread,
      initialComment: comment,
    };
  }

  private nextId(prefix: "rvw" | "rth" | "rcm", existing: Set<string>): string {
    const bytes = this.idBytes();
    if (!/^[a-f0-9]{32}$/.test(bytes)) {
      throw new TypeError("Review ID generator must return 16 lowercase hex bytes");
    }
    const id = `${prefix}_${bytes}`;
    if (existing.has(id)) throw new ReviewStoreCorruptError(`duplicate generated ID: ${id}`);
    return id;
  }
}

function detailFromEvent(event: ReviewCreatedEvent): ReviewDetail {
  return {
    ...event.review,
    threads: [
      {
        ...event.initialThread,
        comments: [event.initialComment],
      },
    ],
  };
}

async function canonicalContext(context: ReviewContext): Promise<ReviewContext> {
  const [repositoryRoot, worktreeRoot] = await Promise.all([
    realpath(resolve(context.repositoryRoot)),
    realpath(resolve(context.worktreeRoot)),
  ]);
  return { repositoryRoot, worktreeRoot };
}

function sameContext(event: ReviewCreatedEvent, context: ReviewContext): boolean {
  return (
    event.review.repository.root === context.repositoryRoot &&
    event.review.worktree.root === context.worktreeRoot
  );
}

function sameRequest(
  event: ReviewCreatedEvent,
  context: ReviewContext,
  input: PromoteFirstReviewComment,
): boolean {
  return (
    sameContext(event, context) &&
    event.initialThread.location.path === input.location.path &&
    event.initialThread.location.side === input.location.side &&
    event.initialThread.location.startLine === input.location.startLine &&
    event.initialThread.location.endLine === input.location.endLine &&
    event.initialThread.severity === input.severity &&
    event.initialComment.author.type === input.author.type &&
    event.initialComment.author.name === input.author.name &&
    event.initialComment.body === input.body.trim()
  );
}

function ensureFirstComment(input: PromoteFirstReviewComment): void {
  if (!validReviewOperationId(input.operationId)) {
    throw new InvalidFirstReviewCommentError(
      "Review operationId must be an opaque op_ ID",
    );
  }
  if (!validReviewLocation(input.location)) {
    throw new InvalidFirstReviewCommentError("invalid Review thread location");
  }
  if (!validReviewSeverity(input.severity)) {
    throw new InvalidFirstReviewCommentError("invalid Review severity");
  }
  if (!validReviewAuthor(input.author)) {
    throw new InvalidFirstReviewCommentError("invalid Review author");
  }
  if (typeof input.body !== "string" || input.body.trim().length === 0) {
    throw new InvalidFirstReviewCommentError("Review comment body must not be blank");
  }
}
