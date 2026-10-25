export function statusTone(status: string) {
  if (
    status === "VERIFIED" ||
    status === "EXECUTED" ||
    status === "TOOL_EXECUTION_OK" ||
    status === "LIVE" ||
    status === "READY" ||
    status === "RUNNING" ||
    status === "COMPLETE" ||
    status === "COMPLETED"
  ) {
    return "ok";
  }
  if (status === "WARN" || status === "GATED") return "warn";
  if (status === "ERROR" || status === "FAILED" || status === "BLOCKED") return "bad";
  return "muted";
}
