/** A stable 64-bit OTLP span ID derived from the Temporal run ID.
 * Both the workflow sandbox and its Node activity process use this same pure
 * function so activities attach to the workflow they actually belong to.
 */
export function workflowSpanId(runId: string): string {
  const compact = runId.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(compact)) {
    const id = compact.slice(0, 16);
    return /^0{16}$/.test(id) ? "0000000000000001" : id;
  }
  let a = 2166136261, b = 0x85ebca6b;
  for (let i = 0; i < runId.length; i++) {
    const ch = runId.charCodeAt(i);
    a = Math.imul(a ^ ch, 16777619);
    b = Math.imul(b ^ ch, 2246822519);
  }
  const id = (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
  return /^0{16}$/.test(id) ? "0000000000000001" : id;
}
