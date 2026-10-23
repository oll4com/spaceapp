/** Serialize a recorded history without machine-specific failure stack traces.
 * Event ordering, command attributes and encoded payloads remain unchanged.
 * The input is not mutated, so callers can still inspect the original history.
 */
export function serializeHistory(history: unknown): string {
  return JSON.stringify(history, (key, value) => key === 'stackTrace' ? '' : value, 2) + '\n';
}
