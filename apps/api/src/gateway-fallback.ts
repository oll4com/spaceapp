/** One route on Space Gateway's chat completions: `/v1` is the Codex pool, `/pools/<provider>/v1` a key pool. */
export type GatewayRoute = { path: string; model: string };
/** What the first route with room answered (Groq's search adds `executed_tools`). */
export type GatewayMessage = { content?: unknown; executed_tools?: unknown };

/**
 * After Codex, the free pools Nous Live uses (plan clipboard:VypZ4sl7NR04 M6, 20/11). Claude's subscription answers 429 to every request that is not
 * Claude Code (20/11: 107 of 107 internal-key calls since 19/11; Haiku and Sonnet probed), so it is not asked; the paid Claude API key never is.
 */
export const FREE_POOLS: readonly GatewayRoute[] = [{ path: "/pools/gemini/v1", model: "gemini-3-flash-preview" },
  { path: "/pools/gemini/v1", model: "gemini-3.5-flash-lite" }, { path: "/pools/groq/v1", model: "openai/gpt-oss-120b" }];
// shortcut: a Codex 429 rests Codex 30 minutes because the pool's refusal names no reset; read the reset once Space Gateway sends it.
const CODEX_REST_MS = 30 * 60_000;
/** One rest for every caller: they share the API's key, so a 429 to one is a 429 to all (21/11: the card and step translators each re-asked a spent pool). */
let codexRestsUntil = 0;

/**
 * The API's own background asks (the card translator, the Room Agent's autopilot, Nous's search while Codex is out): Codex first unless it refused
 * with 429 in the last 30 minutes, then each pool in order; the first answer with content wins. A Codex route (`/v1`) may also sit among `pools`
 * (the card translator asks it last); the Codex rest is shared by every caller.
 */
export function createGatewayFallback(fetchImpl?: typeof fetch) {
  return async (input: { root: string; headers: Record<string, string>; codexModel?: string | null; pools?: readonly GatewayRoute[];
    body: Record<string, unknown>; timeoutMs: number; signal?: AbortSignal }): Promise<GatewayMessage> => {
    const routes = [...(input.codexModel ? [{ path: "/v1", model: input.codexModel }] : []), ...(input.pools ?? FREE_POOLS)]
      .filter((route) => route.path !== "/v1" || Date.now() >= codexRestsUntil);
    const refused: string[] = [];
    for (const route of routes) {
      const isCodex = route.path === "/v1";
      const signal = AbortSignal.timeout(input.timeoutMs);
      const response = await (fetchImpl ?? fetch)(`${input.root}${route.path}/chat/completions`, {
        method: "POST", headers: input.headers, signal: input.signal ? AbortSignal.any([input.signal, signal]) : signal,
        body: JSON.stringify({ model: route.model, ...(isCodex ? { store: false } : {}), ...input.body })
      }).catch((error: unknown) => { if (input.signal?.aborted) throw error; return null; });
      const message = response?.ok ? ((await response.json().catch(() => null)) as { choices?: Array<{ message?: GatewayMessage }> } | null)?.choices?.[0]?.message : undefined;
      if (message?.content) return message;
      if (isCodex && response?.status === 429) codexRestsUntil = Date.now() + CODEX_REST_MS;
      refused.push(`${route.model} ${response ? (response.ok ? "empty" : response.status) : "unreachable"}`);
    }
    throw new Error(`Space Gateway found no route with room: ${refused.join(", ")}.`);
  };
}
