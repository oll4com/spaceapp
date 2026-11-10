import type { GatewayProvider } from "@space/contracts";
import type { GatewayModelCheck, GatewayRepository } from "@space/db";
import type { AccountPool } from "../../accounts/account-pool.js";
import { catalogIds, poolUpstream, type KeyPoolProvider } from "./key-pools.js";

/**
 * Dead models of the free key pools (operator 5/11 17:22 BKK: "every NVIDIA model that does not answer removed automatically").
 * A 410 (end of life) or 404 (listed but not served to the key) kills a model; a 200 brings it back; anything else (429, a timeout, 5xx,
 * a 400 for a model that is no chat model) changes nothing. Dead models leave /models and auto at once.
 */
export const verdictOf = (status: number): boolean | null => (status === 410 || status === 404 ? true : status === 200 ? false : null);

const keyOf = (provider: GatewayProvider, model: string) => `${provider}\u0000${model}`;

export class ModelChecks {
  private readonly checks = new Map<string, GatewayModelCheck>();
  constructor(private readonly repository: Pick<GatewayRepository, "listModelChecks" | "saveModelCheck">, private readonly now: () => number = Date.now) {}

  async load() {
    for (const check of await this.repository.listModelChecks()) this.checks.set(keyOf(check.provider, check.model), check);
  }

  isDead(provider: GatewayProvider, model: string) { return this.checks.get(keyOf(provider, model))?.dead === true; }
  dead(provider: GatewayProvider) { return [...this.checks.values()].filter((check) => check.dead && check.provider === provider); }
  checkedAt(provider: GatewayProvider, model: string) { const at = this.checks.get(keyOf(provider, model))?.checkedAt; return at ? Date.parse(at) : null; }

  /** Records one answer. A request's answer is stored only when it changes `dead`; the probe (`always`) stores every check. */
  async record(provider: GatewayProvider, model: string, status: number, reason: string | null, always = false) {
    const previous = this.checks.get(keyOf(provider, model));
    const verdict = verdictOf(status);
    const dead = verdict ?? previous?.dead ?? false;
    if (!always && dead === (previous?.dead ?? false)) return;
    const at = new Date(this.now()).toISOString();
    const check: GatewayModelCheck = { provider, model, dead, status, reason: dead ? (verdict ? reason : previous?.reason ?? null) : null,
      deadSince: dead ? (previous?.dead ? previous.deadSince : at) : null, checkedAt: at };
    this.checks.set(keyOf(provider, model), check);
    await this.repository.saveModelCheck(check);
  }
}

/**
 * The daily probe: every hour, each catalog model (and each dead one) not checked for 24 h gets one tiny chat request, one at a time
 * `spacingMs` apart (2 s: at most 30 a minute, under NVIDIA's 40). Checks live in the store, so a gateway restart does not probe again.
 */
export function startModelProbe(options: { targets: Array<{ entry: KeyPoolProvider; pool: AccountPool }>; checks: ModelChecks; fetchImpl?: typeof fetch;
  now?: () => number; intervalMs?: number; staleMs?: number; spacingMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; onError?: (error: unknown) => void }) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? 24 * 3_600_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms).unref()));
  let running = false;

  async function probeTarget({ entry, pool }: { entry: KeyPoolProvider; pool: AccountPool }) {
    const account = (await pool.accounts()).find((candidate) => candidate.status === "ACTIVE");
    if (!account) return;
    const apiKey = (await pool.credentials(account)).accessToken;
    const listed = await catalogIds(entry, apiKey, fetchImpl);
    if (!("ids" in listed)) return;
    for (const model of new Set([...listed.ids,...options.checks.dead(entry.provider).map((check) => check.model)])) {
      const checked = options.checks.checkedAt(entry.provider, model);
      if (checked !== null && now() - checked < staleMs) continue;
      const chat = poolUpstream(`${entry.baseUrl}/chat/completions`, apiKey);
      let status = 0;
      let reason: string | null = null;
      try {
        const answer = await fetchImpl(chat.url, { method: "POST", signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
          headers: { authorization: `Bearer ${chat.token}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }], max_tokens: 1 }) });
        status = answer.status;
        reason = answer.ok ? null : (await answer.text().catch(() => "")).slice(0, 300) || `HTTP ${status}`;
      } catch { /* no answer: status 0, never dead */ }
      await options.checks.record(entry.provider, model, status, reason, true);
      await sleep(options.spacingMs ?? 2_000);
    }
  }

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      for (const target of options.targets) await probeTarget(target).catch((error: unknown) => options.onError?.(error));
    } finally { running = false; }
  }
  const timer = setInterval(() => void runOnce(), options.intervalMs ?? 3_600_000);
  timer.unref();
  return { runOnce, stop: () => clearInterval(timer) };
}
