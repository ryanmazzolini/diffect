/** Clean Review contracts shared by the daemon, CLI, Pi, browser, and store. */

export const REVIEW_EVENT_VERSION = 1 as const;

export type ReviewId = string;
export type ReviewThreadId = string;
export type ReviewCommentId = string;
export type ReviewOperationId = string;

export type ReviewSide = "old" | "new";
export type ReviewSeverity = "must-fix" | "suggestion" | "nit" | "question";

export interface ReviewAuthor {
  type: "user" | "agent";
  name?: string;
}

export interface RepositoryLocator {
  /** Canonical absolute path of the repository's primary checkout. */
  root: string;
}

export interface WorktreeLocator {
  /** Canonical absolute path of the checkout reviewed by this Review. */
  root: string;
}

export interface Review {
  id: ReviewId;
  repository: RepositoryLocator;
  worktree: WorktreeLocator;
  createdAt: string;
}

export interface ReviewThreadLocation {
  /** Normalized repository-relative path. */
  path: string;
  side: ReviewSide;
  /** Inclusive, 1-based line range. */
  startLine: number;
  endLine: number;
}

export interface ReviewThread {
  id: ReviewThreadId;
  reviewId: ReviewId;
  location: ReviewThreadLocation;
  severity: ReviewSeverity | null;
  createdAt: string;
}

export interface ReviewComment {
  id: ReviewCommentId;
  threadId: ReviewThreadId;
  author: ReviewAuthor;
  body: string;
  createdAt: string;
}

export interface ReviewThreadDetail extends ReviewThread {
  comments: ReviewComment[];
}

export interface ReviewDetail extends Review {
  threads: ReviewThreadDetail[];
}

interface ReviewEventBase {
  version: typeof REVIEW_EVENT_VERSION;
  /** Caller-generated key that makes a mutation safe to retry. */
  operationId: ReviewOperationId;
}

/** One record atomically creates the Review and its first conversation. */
export interface ReviewCreatedEvent extends ReviewEventBase {
  type: "review.created";
  review: Review;
  initialThread: ReviewThread;
  initialComment: ReviewComment;
}

export type ReviewEvent = ReviewCreatedEvent;

export interface PromoteFirstReviewComment {
  operationId: ReviewOperationId;
  location: ReviewThreadLocation;
  severity: ReviewSeverity | null;
  author: ReviewAuthor;
  body: string;
}
