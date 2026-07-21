export interface ReviewSelectionIntentController {
  schedule(action: () => void): void;
  runNow<Result>(action: () => Result): Result;
  cancel(): void;
}

/** Coordinates deferred picker changes with immediate review selections. */
export function createReviewSelectionIntentController(
  delayMs: number,
): ReviewSelectionIntentController {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return {
    schedule(action) {
      cancel();
      const scheduledGeneration = generation;
      timer = setTimeout(() => {
        if (scheduledGeneration !== generation) return;
        timer = null;
        action();
      }, delayMs);
    },
    runNow(action) {
      cancel();
      return action();
    },
    cancel,
  };
}
