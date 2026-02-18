export interface BaseProgress {
  active: boolean;
  phase: string;
  errorMessage?: string;
}

export function markProgressDone<T extends BaseProgress>(progress: T, resetDelayMs = 15000): void {
  progress.phase = "done";
  progress.active = false;
  setTimeout(() => {
    if (progress.phase === "done") progress.phase = "idle";
  }, resetDelayMs);
}

export function markProgressError<T extends BaseProgress>(progress: T, err: unknown, resetDelayMs = 60000): void {
  progress.phase = "error";
  progress.active = false;
  progress.errorMessage = err instanceof Error ? err.message : String(err);
  setTimeout(() => {
    if (progress.phase === "error") progress.phase = "idle";
  }, resetDelayMs);
}
