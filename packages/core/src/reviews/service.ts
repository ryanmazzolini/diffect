import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  REVIEW_EVENT_VERSION,
  REVIEW_ORIGIN,
  type ExactReviewThread,
  type FirstReviewComment,
  type Review,
  type ReviewComment,
  type ReviewCreatedEvent,
  type ReviewDetail,
  type ReviewId,
  type ReviewThread,
  type ReviewThreadId,
} from "@diffect/shared";
import {
  appendReviewEvent,
  readAllReviewEvents,
  readRepositoryReviewEvents,
  ReviewStoreCorruptError,
  validAuthor,
  validReviewId,
  validReviewLocation,
  validReviewThreadId,
  validSeverity,
} from "./store.js";

export interface ReviewContext {
  repositoryRoot: string;
  worktreeRoot: string;
}

export class UnknownReviewError extends Error {}
export class UnknownReviewThreadError extends Error {}
export class ExistingWritableReviewError extends Error {
  constructor(public readonly review: ReviewDetail) {
    super(`working context already has Review ${review.id}`);
  }
}
export class DuplicateReviewIdError extends ReviewStoreCorruptError {}
export class DuplicateReviewThreadIdError extends ReviewStoreCorruptError {}
export class DuplicateWritableReviewError extends ReviewStoreCorruptError {}
export class InvalidFirstReviewCommentError extends Error {}

interface ReviewServiceOptions {
  now?: () => string;
  idBytes?: () => string;
  origin?: string;
  beforeAppend?: (event: ReviewCreatedEvent) => void | Promise<void>;
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

function exactThreadFromEvent(event: ReviewCreatedEvent): ExactReviewThread {
  return {
    review: event.review,
    thread: {
      ...event.initialThread,
      comments: [event.initialComment],
    },
  };
}

function sameContext(event: ReviewCreatedEvent, context: ReviewContext): boolean {
  return (
    event.review.repository.root === context.repositoryRoot &&
    event.review.worktree.root === context.worktreeRoot
  );
}

async function canonicalContext(context: ReviewContext): Promise<ReviewContext> {
  const [repositoryRoot, worktreeRoot] = await Promise.all([
    realpath(resolve(context.repositoryRoot)),
    realpath(resolve(context.worktreeRoot)),
  ]);
  return { repositoryRoot, worktreeRoot };
}

function ensureFirstComment(input: FirstReviewComment): void {
  if (!validReviewLocation(input.location)) {
    throw new InvalidFirstReviewCommentError("invalid Review thread location");
  }
  if (!validSeverity(input.severity)) {
    throw new InvalidFirstReviewCommentError("invalid Review severity");
  }
  if (!validAuthor(input.author)) {
    throw new InvalidFirstReviewCommentError("invalid Review author");
  }
  if (typeof input.body !== "string" || input.body.trim().length === 0) {
    throw new InvalidFirstReviewCommentError("Review comment body must not be blank");
  }
}

export class ReviewService {
  private readonly now: () => string;
  private readonly idBytes: () => string;
  private readonly origin: string;
  private readonly beforeAppend?: ReviewServiceOptions["beforeAppend"];
  private readonly repositoryWrites = new Map<string, Promise<void>>();

  constructor(options: ReviewServiceOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idBytes = options.idBytes ?? (() => randomBytes(16).toString("hex"));
    this.origin = (options.origin ?? REVIEW_ORIGIN).replace(/\/$/, "");
    this.beforeAppend = options.beforeAppend;
  }

  async findWritable(context: ReviewContext): Promise<ReviewDetail | null> {
    return this.findWritableCanonical(await canonicalContext(context));
  }

  private async findWritableCanonical(
    context: ReviewContext,
  ): Promise<ReviewDetail | null> {
    const matches = (await readRepositoryReviewEvents(context.repositoryRoot)).filter(
      (event) => sameContext(event, context),
    );
    if (matches.length > 1) {
      throw new DuplicateWritableReviewError(
        `working context has ${matches.length} Reviews`,
      );
    }
    return matches[0] ? detailFromEvent(matches[0]) : null;
  }

  async promoteFirstComment(
    context: ReviewContext,
    input: FirstReviewComment,
  ): Promise<ReviewDetail> {
    ensureFirstComment(input);
    const canonical = await canonicalContext(context);
    return this.withRepositoryWrite(canonical.repositoryRoot, async () => {
      const existing = await this.findWritableCanonical(canonical);
      if (existing) throw new ExistingWritableReviewError(existing);

      const createdAt = this.now();
      const review: Review = {
        id: `rvw_${this.idBytes()}`,
        repository: { root: canonical.repositoryRoot },
        worktree: { root: canonical.worktreeRoot },
        createdAt,
      };
      const thread: ReviewThread = {
        id: `rth_${this.idBytes()}`,
        reviewId: review.id,
        location: input.location,
        severity: input.severity,
        createdAt,
      };
      const comment: ReviewComment = {
        id: `rcm_${this.idBytes()}`,
        threadId: thread.id,
        author: input.author,
        body: input.body.trim(),
        createdAt,
      };
      const event: ReviewCreatedEvent = {
        version: REVIEW_EVENT_VERSION,
        type: "review.created",
        review,
        initialThread: thread,
        initialComment: comment,
      };
      await this.beforeAppend?.(event);
      await appendReviewEvent(event);
      return detailFromEvent(event);
    });
  }

  /** Serialize daemon-local promotion; Change C adds cross-process locking. */
  private async withRepositoryWrite<T>(
    repositoryRoot: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.repositoryWrites.get(repositoryRoot) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    const tail = previous.catch(() => {}).then(() => current);
    this.repositoryWrites.set(repositoryRoot, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.repositoryWrites.get(repositoryRoot) === tail) {
        this.repositoryWrites.delete(repositoryRoot);
      }
    }
  }

  async getReview(id: ReviewId): Promise<ReviewDetail> {
    if (!validReviewId(id)) throw new UnknownReviewError(`unknown Review: ${id}`);
    const matches = (await readAllReviewEvents()).filter(
      (event) => event.review.id === id,
    );
    if (matches.length === 0) throw new UnknownReviewError(`unknown Review: ${id}`);
    if (matches.length > 1) {
      throw new DuplicateReviewIdError(`duplicate Review ID: ${id}`);
    }
    return detailFromEvent(matches[0]!);
  }

  async getThread(id: ReviewThreadId): Promise<ExactReviewThread> {
    if (!validReviewThreadId(id)) {
      throw new UnknownReviewThreadError(`unknown Review thread: ${id}`);
    }
    const matches = (await readAllReviewEvents()).filter(
      (event) => event.initialThread.id === id,
    );
    if (matches.length === 0) {
      throw new UnknownReviewThreadError(`unknown Review thread: ${id}`);
    }
    if (matches.length > 1) {
      throw new DuplicateReviewThreadIdError(`duplicate Review thread ID: ${id}`);
    }
    return exactThreadFromEvent(matches[0]!);
  }

  linkFor(id: ReviewId): string {
    if (!validReviewId(id)) throw new UnknownReviewError(`unknown Review: ${id}`);
    return `${this.origin}/reviews/${id}`;
  }
}
