const REFRESH_TIMEOUT_MS = 20_000;

/** Polling waits for each refresh, so one hung request froze the pane (a stale "Take control" card stayed up). */
export function withRefreshTimeout<T>(work: Promise<T>, copilotName: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${copilotName} data took too long to load; retrying.`)), REFRESH_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => window.clearTimeout(timer));
}
