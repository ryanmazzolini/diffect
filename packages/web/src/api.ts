import type {
  CreateReviewRequest,
  CurrentChangesResponse,
  ReviewDiff,
  ReviewResponse,
  WorkspaceSummary,
} from "@diffect/shared";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly payload: unknown,
  ) {
    super(message);
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload = (await response.json().catch(() => null)) as
    | { error?: unknown }
    | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof payload?.error === "string" ? payload.error : `request failed (${response.status})`,
      payload,
    );
  }
  return payload as T;
}

export const api = {
  workspace(): Promise<WorkspaceSummary> {
    return requestJson("/api/workspace");
  },

  currentChanges(repo: string, worktree: string | null): Promise<CurrentChangesResponse> {
    const query = new URLSearchParams({ repo });
    if (worktree) query.set("worktree", worktree);
    return requestJson(`/api/current-changes?${query}`);
  },

  review(id: string): Promise<ReviewResponse> {
    return requestJson(`/api/reviews/${encodeURIComponent(id)}`);
  },

  reviewDiff(id: string): Promise<ReviewDiff> {
    return requestJson(`/api/reviews/${encodeURIComponent(id)}/diff`);
  },

  createReview(input: CreateReviewRequest): Promise<ReviewResponse> {
    return requestJson("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  },
};
