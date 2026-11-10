/** Native Codex turn/start metadata is emitted on each Responses HTTP request / WS frame.
 * It is per turn, unlike a pane's fixed headers. Never infer attribution from a session's last request.
 */
export function codexTurnTrace(body: unknown): { requestId: string; nativeTurnId: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const metadata = (body as Record<string, unknown>).client_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)["x-codex-turn-metadata"];
  if (typeof raw !== "string" || raw.length > 8192) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { space_request_id: requestId, turn_id: nativeTurnId } = value as Record<string, unknown>;
    if (typeof requestId !== "string" || !/^[\x21-\x7e]{1,120}$/.test(requestId)
      || typeof nativeTurnId !== "string" || !/^[A-Za-z0-9:._-]{1,120}$/.test(nativeTurnId)) return null;
    return { requestId, nativeTurnId };
  } catch { return null; }
}
