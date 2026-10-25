/**
 * Structured worker logging: one JSON object per line on stdout/stderr, which
 * journald keeps for `journalctl -u space-worker`. The worker deliberately has
 * no general-purpose logger: every record is built from allowlisted fields so
 * prompts, transcripts, error messages and credentials cannot be spread into a
 * log line by accident. Callers pass identifiers, codes and numbers only.
 */
export type WorkerLogLevel = "info" | "warn" | "error";
export type WorkerLogValue = string | number | boolean | null;
export type WorkerLogSink = (line: string, level: WorkerLogLevel) => void;

const defaultSink: WorkerLogSink = (line, level) => {
  if (level === "info") console.info(line);
  else console.error(line);
};

let sink: WorkerLogSink = defaultSink;

/** Test hook: capture worker log lines. Returns a restore function. */
export function captureWorkerLogs(capture: WorkerLogSink): () => void {
  const previous = sink;
  sink = capture;
  return () => { sink = previous; };
}

const identifierPattern = /^[A-Za-z0-9:._-]{1,200}$/;

/** An identifier (id, code, enum, type name) or null. Free text is rejected. */
export function logIdentifier(value: unknown): string | null {
  return typeof value === "string" && identifierPattern.test(value) ? value : null;
}

export function workerLog(level: WorkerLogLevel, event: string, fields: Readonly<Record<string, WorkerLogValue | undefined>>): void {
  const record: Record<string, WorkerLogValue> = {
    ts: new Date().toISOString(),
    level,
    service: "space-worker",
    event
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      // Strings must be identifiers; anything else is dropped, not truncated.
      const safe = logIdentifier(value);
      if (safe !== null) record[key] = safe;
      continue;
    }
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    record[key] = value;
  }
  // Logging must never change an activity's outcome.
  try { sink(JSON.stringify(record), level); } catch {}
}
