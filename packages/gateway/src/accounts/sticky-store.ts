import type { GatewayProvider } from "@space/contracts";
import type { GatewayRepository, GatewayStickyBinding, GatewayStickyKind } from "@space/db";
import { BoundedMap } from "../proxy-util.js";

/**
 * Conversation-to-account bindings (sticky threads, prompt-cache sessions, response continuations), kept in
 * memory and written behind to storage, so affinity survives a gateway restart. Keys are SHA-256 hex hashes;
 * raw session ids and response ids are never stored. A binding lives for `ttlMs` after its last use.
 */
const MEMORY_LIMIT = 8192;
const NEGATIVE_MS = 60_000;

export class StickyStore {
  private memory = new BoundedMap<{ accountId: string; expiresAt: number }>(MEMORY_LIMIT);
  private misses = new BoundedMap<number>(MEMORY_LIMIT);
  private pending = new Map<string, GatewayStickyBinding>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: {
    /** Without storage the bindings live in memory only. */
    repository?: GatewayRepository;
    provider: GatewayProvider;
    kind: GatewayStickyKind;
    /** How long a binding lives after its last use; a function follows a setting that can change. */
    ttlMs?: number | (() => number);
    flushMs?: number;
    now?: () => number;
    onError?: (error: unknown) => void;
  }) {}

  private nowMs() { return (this.options.now ?? Date.now)(); }
  private ttl() {
    const ttl = this.options.ttlMs;
    return typeof ttl === "function" ? ttl() : ttl ?? 24 * 60 * 60_000;
  }

  /** The bound account, from memory or storage; storage failures count as no binding. */
  async get(keyHash: string): Promise<string | undefined> {
    const now = this.nowMs();
    const cached = this.memory.get(keyHash);
    if (cached && cached.expiresAt > now) return cached.accountId;
    const missedAt = this.misses.get(keyHash);
    if (missedAt !== undefined && now - missedAt < NEGATIVE_MS) return undefined;
    if (!this.options.repository) return undefined;
    try {
      const stored = await this.options.repository.findStickyBinding(keyHash, new Date(now).toISOString());
      if (stored) {
        this.memory.set(keyHash, { accountId: stored.accountId, expiresAt: stored.expiresAt ? Date.parse(stored.expiresAt) : now + this.ttl() });
        return stored.accountId;
      }
    } catch (error) {
      this.options.onError?.(error);
    }
    this.misses.set(keyHash, now);
    return undefined;
  }

  set(keyHash: string, accountId: string) {
    const expiresAt = this.nowMs() + this.ttl();
    this.memory.set(keyHash, { accountId, expiresAt });
    this.misses.set(keyHash, Number.NEGATIVE_INFINITY);
    if (!this.options.repository) return;
    this.pending.set(keyHash, { keyHash, kind: this.options.kind, provider: this.options.provider, accountId, expiresAt: new Date(expiresAt).toISOString() });
    if (!this.timer) {
      this.timer = setTimeout(() => { void this.flush(); }, this.options.flushMs ?? 1_000);
      this.timer.unref();
    }
  }

  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.pending.size === 0) return;
    const rows = [...this.pending.values()];
    this.pending.clear();
    try {
      await this.options.repository?.saveStickyBindings(rows);
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
