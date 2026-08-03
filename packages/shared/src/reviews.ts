/** Clean Review contracts shared by the daemon, CLI, store, Pi, and browser. */

export const REVIEW_EVENT_VERSION = 1 as const;
export const REVIEW_ORIGIN = "http://127.0.0.1:7421" as const;

export type ReviewId = string;
export type ReviewThreadId = string;
export type ReviewCommentId = string;

export type Side = "old" | "new";
export type Severity = "must-fix" | "suggestion" | "nit" | "question";

export interface Author {
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
  side: Side;
  /** Inclusive, 1-based line range. */
  startLine: number;
  endLine: number;
}

export interface ReviewThread {
  id: ReviewThreadId;
  reviewId: ReviewId;
  location: ReviewThreadLocation;
  severity: Severity | null;
  createdAt: string;
}

export interface ReviewComment {
  id: ReviewCommentId;
  threadId: ReviewThreadId;
  author: Author;
  body: string;
  createdAt: string;
}

export interface ReviewThreadDetail extends ReviewThread {
  comments: ReviewComment[];
}

export interface ReviewDetail extends Review {
  threads: ReviewThreadDetail[];
}

export interface ExactReviewThread {
  review: Review;
  thread: ReviewThreadDetail;
}

/**
 * The first durable write for a working context. One JSONL record creates the
 * Review, its first Thread, and that Thread's first Comment together.
 */
export interface ReviewCreatedEvent {
  version: typeof REVIEW_EVENT_VERSION;
  type: "review.created";
  review: Review;
  initialThread: ReviewThread;
  initialComment: ReviewComment;
}

export interface FirstReviewComment {
  location: ReviewThreadLocation;
  severity: Severity | null;
  author: Author;
  body: string;
}

export interface CreateReviewRequest extends FirstReviewComment {
  /** Runtime workspace identifiers. They are resolved before persistence. */
  repo: string;
  worktree: string | null;
}

export interface ReviewResponse {
  review: ReviewDetail;
  link: string;
}

export interface ExactThreadResponse extends ExactReviewThread {
  reviewLink: string;
}
