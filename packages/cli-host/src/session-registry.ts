import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type {
  CliHostAttachInput,
  CliHostAttachResult,
  CliHostIdentity,
  CliHostInputResult,
  CliHostEvent,
  CliHostEventListener,
  CliHostOutputEvent,
  CliHostPty,
  CliHostReapResult,
  CliHostSessionSummary,
  CliHostSpawn,
  CliHostSpawnSpec
} from "./types.js";

const immutableIdentityFields = [
  "cliSessionId",
  "paneId",
  "roomId",
  "runtimeId"
] as const satisfies ReadonlyArray<keyof CliHostIdentity>;

export const CLI_HOST_MANUAL_REAP_GRACE_MS = 5 * 60_000;
export const CLI_HOST_TERMINAL_SESSION_RETENTION_MS = 60 * 60_000;

export function resolveCliHostInactiveSessionMs(value: string | undefined): number | null {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

interface ManagedSession {
  identity: CliHostIdentity;
  generationId: string;
  pty: CliHostPty;
  status: "RUNNING" | "EXITED" | "ERROR";
  statusReason: string | null;
  exitCode: number | null;
  signal: number | null;
  nextOutputSequence: number;
  outputBuffer: CliHostOutputEvent[];
  outputBufferBytes: number;
  attachments: Map<string, CliHostEventListener | null>;
  detachedAtMs: number | null;
  terminationRequested: boolean;
  pendingHiddenEchoes: Array<{ value: string; remaining: string; expiresAtMs: number }>;
  acceptedInputs: Map<string, { acceptedAtMs: number; payloadHash: string }>;
  startedAt: string;
  endedAt: string | null;
}

export class CliHostError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CliHostError";
  }
}

export class CliHostSessionRegistry {
  private readonly sessions = new Map<string, Promise<ManagedSession>>();
  private readonly resolvedSessions = new Map<string, ManagedSession>();
  private readonly outputBufferBytes: number;

  constructor(
    private readonly options: {
      spawn: CliHostSpawn;
      normalizeSpawn?: (identity: CliHostIdentity, spawn: CliHostSpawnSpec) => CliHostSpawnSpec;
      outputBufferBytes?: number;
      now?: () => number;
      killProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
    }
  ) {
    this.outputBufferBytes = Math.max(1024, options.outputBufferBytes ?? 8 * 1024 * 1024);
  }

  private killProcess(pid: number, signal: NodeJS.Signals | 0): void {
    (this.options.killProcess ?? process.kill)(pid, signal);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      this.killProcess(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === "EPERM";
    }
  }

  private processAlive(managed: ManagedSession): boolean {
    const pid = managed.pty.pid;
    return Number.isInteger(pid) && pid > 0 && this.isProcessAlive(pid);
  }

  private markProcessGone(managed: ManagedSession): void {
    managed.status = "EXITED";
    managed.exitCode = null;
    managed.signal = null;
    managed.statusReason = "CLI process is no longer alive; the PTY exit event was missed.";
    managed.endedAt ??= new Date().toISOString();
  }

  private forceKill(managed: ManagedSession): void {
    // node-pty kill() only delivers SIGHUP and swallows signal errors, so a
    // stuck CLI tree (sudo wrapper, broker, agent subprocess) can survive it.
    // Escalate deterministically; the PTY child is a session leader, so the
    // negative-pid group kill covers the whole tree.
    try {
      managed.pty.kill();
    } catch {
      // Best effort only; escalation below still applies.
    }
    const pid = managed.pty.pid;
    if (!Number.isInteger(pid) || pid <= 0 || !this.isProcessAlive(pid)) return;
    try {
      this.killProcess(pid, "SIGTERM");
    } catch {
      // Best effort only; SIGKILL below still applies.
    }
    if (!this.isProcessAlive(pid)) return;
    try {
      this.killProcess(-pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the single pid when the process group is unavailable.
    }
    try {
      this.killProcess(pid, "SIGKILL");
    } catch {
      // Best effort only; the next sweep reconciles liveness again.
    }
  }

  async attach(input: CliHostAttachInput, listener?: CliHostEventListener): Promise<CliHostAttachResult> {
    const managed = await this.getOrCreate(input);
    this.assertIdentity(managed.identity, input.identity);
    if (managed.status !== "RUNNING") {
      throw new CliHostError("CLI_HOST_SESSION_CLOSED", `CLI host session ${input.identity.cliSessionId} is ${managed.status}.`);
    }
    const afterSequence = input.afterSequence ?? -1;
    const earliestSequence = managed.outputBuffer[0]?.sequence;
    if (earliestSequence !== undefined && afterSequence < earliestSequence - 1) {
      throw new CliHostError(
        "CLI_HOST_REPLAY_GAP",
        `CLI host output before sequence ${earliestSequence} is no longer buffered for ${input.identity.cliSessionId}.`
      );
    }
    const attachmentId = randomUUID();
    managed.attachments.set(attachmentId, listener ?? null);
    managed.detachedAtMs = null;
    return {
      attachmentId,
      session: this.summarize(managed),
      replay: managed.outputBuffer.filter((event) => event.sequence > afterSequence).map((event) => ({ ...event }))
    };
  }

  inspect(identity: CliHostIdentity): CliHostSessionSummary | null {
    const managed = this.resolvedSessions.get(identity.cliSessionId);
    if (!managed) return null;
    this.assertIdentity(managed.identity, identity);
    return this.summarize(managed);
  }

  async inspectAsync(identity: CliHostIdentity): Promise<CliHostSessionSummary | null> {
    const pending = this.sessions.get(identity.cliSessionId);
    if (!pending) return null;
    const managed = await pending;
    this.assertIdentity(managed.identity, identity);
    return this.summarize(managed);
  }

  inspectAll(): CliHostSessionSummary[] {
    return Array.from(this.resolvedSessions.values(), (managed) => this.summarize(managed));
  }

  sessionCount(): number {
    return this.resolvedSessions.size;
  }

  async input(
    identity: CliHostIdentity,
    attachmentId: string,
    data: string,
    display: "visible" | "hidden" = "visible",
    idempotencyKey?: string
  ): Promise<CliHostInputResult> {
    const managed = await this.requireSession(identity);
    this.requireAttachment(managed, attachmentId);
    const payloadHash = idempotencyKey
      ? createHash("sha256").update(display).update("\0").update(data).digest("hex")
      : null;
    if (idempotencyKey) {
      const existing = managed.acceptedInputs.get(idempotencyKey);
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new CliHostError(
            "CLI_HOST_IDEMPOTENCY_CONFLICT",
            `CLI host input key ${idempotencyKey} was already used with a different payload.`
          );
        }
        return { accepted: false, acceptedAtMs: existing.acceptedAtMs };
      }
    }
    if (display === "hidden") {
      const expiresAtMs = Date.now() + 5_000;
      for (const value of hiddenEchoCandidates(data)) {
        managed.pendingHiddenEchoes.push({ value, remaining: value, expiresAtMs });
      }
    }
    managed.pty.write(data);
    const acceptedAtMs = Date.now();
    if (idempotencyKey) {
      managed.acceptedInputs.set(idempotencyKey, { acceptedAtMs, payloadHash: payloadHash! });
      while (managed.acceptedInputs.size > 2_048) {
        const oldest = managed.acceptedInputs.keys().next().value;
        if (typeof oldest !== "string") break;
        managed.acceptedInputs.delete(oldest);
      }
    }
    return { accepted: true, acceptedAtMs };
  }

  async resize(identity: CliHostIdentity, attachmentId: string, cols: number, rows: number): Promise<void> {
    const managed = await this.requireSession(identity);
    this.requireAttachment(managed, attachmentId);
    managed.pty.resize(cols, rows);
  }

  detach(identity: CliHostIdentity, attachmentId: string, nowMs = this.now()): boolean {
    const managed = this.resolvedSessions.get(identity.cliSessionId);
    if (!managed) return false;
    this.assertIdentity(managed.identity, identity);
    const detached = managed.attachments.delete(attachmentId);
    if (detached && managed.attachments.size === 0 && managed.status === "RUNNING") managed.detachedAtMs = nowMs;
    return detached;
  }

  reapInactiveSessions(nowMs: number, inactiveMs: number): string[] {
    if (resolveCliHostInactiveSessionMs(process.env.SPACE_CLI_HOST_INACTIVE_SESSION_MS) === null) return [];
    const reaped: string[] = [];
    const leaseMs = Math.max(1, inactiveMs);
    for (const managed of this.resolvedSessions.values()) {
      if (managed.status !== "RUNNING" || managed.terminationRequested) continue;
      if (!this.processAlive(managed)) {
        this.markProcessGone(managed);
        reaped.push(managed.identity.cliSessionId);
        continue;
      }
      if (
        managed.attachments.size !== 0 ||
        managed.detachedAtMs === null ||
        nowMs - managed.detachedAtMs < leaseMs
      ) {
        continue;
      }
      this.forceKill(managed);
      if (this.processAlive(managed)) managed.terminationRequested = false;
      else reaped.push(managed.identity.cliSessionId);
    }
    return reaped;
  }

  reapDetachedSessions(nowMs = this.now()): CliHostReapResult {
    const killedSessions: CliHostSessionSummary[] = [];
    let skippedCount = 0;
    for (const managed of this.resolvedSessions.values()) {
      if (managed.status !== "RUNNING" || managed.terminationRequested) continue;
      if (!this.processAlive(managed)) {
        // The PTY child is already gone (missed exit event): reconcile the
        // status so the running-session counter drops, and count the session
        // as cleaned even though no kill was necessary.
        this.markProcessGone(managed);
        killedSessions.push(this.summarize(managed));
        continue;
      }
      if (managed.attachments.size !== 0) {
        skippedCount += 1;
        continue;
      }
      if (managed.detachedAtMs === null || nowMs - managed.detachedAtMs < CLI_HOST_MANUAL_REAP_GRACE_MS) {
        skippedCount += 1;
        continue;
      }
      this.forceKill(managed);
      if (this.processAlive(managed)) {
        // The process survived the full escalation; do NOT leave the session
        // marked termination-requested forever, so the next Clean retries.
        managed.terminationRequested = false;
        skippedCount += 1;
      } else {
        killedSessions.push(this.summarize(managed));
      }
    }
    return { killedSessions, skippedCount };
  }

  sweepStaleSessions(nowMs = this.now()): { reconciled: number; pruned: number } {
    let reconciled = 0;
    let pruned = 0;
    for (const managed of this.resolvedSessions.values()) {
      if (managed.status === "RUNNING" && !this.processAlive(managed)) {
        this.markProcessGone(managed);
        reconciled += 1;
      }
    }
    for (const managed of this.resolvedSessions.values()) {
      if (managed.status !== "EXITED" && managed.status !== "ERROR") continue;
      const endedAtMs = managed.endedAt ? Date.parse(managed.endedAt) : Number.NaN;
      if (Number.isFinite(endedAtMs) && nowMs - endedAtMs >= CLI_HOST_TERMINAL_SESSION_RETENTION_MS) {
        this.resolvedSessions.delete(managed.identity.cliSessionId);
        this.sessions.delete(managed.identity.cliSessionId);
        pruned += 1;
      }
    }
    return { reconciled, pruned };
  }

  terminate(identity: CliHostIdentity): boolean {
    const managed = this.resolvedSessions.get(identity.cliSessionId);
    if (!managed) return false;
    this.assertIdentity(managed.identity, identity);
    if (managed.status !== "RUNNING" || managed.terminationRequested) return false;
    if (!this.processAlive(managed)) {
      this.markProcessGone(managed);
      return true;
    }
    managed.terminationRequested = true;
    this.forceKill(managed);
    if (this.processAlive(managed)) managed.terminationRequested = false;
    return true;
  }

  terminateAll(): void {
    for (const managed of this.resolvedSessions.values()) {
      if (managed.status === "RUNNING" && !managed.terminationRequested) {
        managed.terminationRequested = true;
        this.forceKill(managed);
        if (this.processAlive(managed)) managed.terminationRequested = false;
      }
    }
  }

  private async getOrCreate(input: CliHostAttachInput): Promise<ManagedSession> {
    const existing = this.sessions.get(input.identity.cliSessionId);
    if (existing) return existing;
    if (!input.spawn) {
      throw new CliHostError("CLI_HOST_SESSION_NOT_FOUND", `CLI host session ${input.identity.cliSessionId} was not found.`);
    }
    const pending = this.spawnSession(input.identity, input.spawn).then((managed) => {
      this.resolvedSessions.set(input.identity.cliSessionId, managed);
      return managed;
    });
    this.sessions.set(input.identity.cliSessionId, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.sessions.get(input.identity.cliSessionId) === pending) this.sessions.delete(input.identity.cliSessionId);
      this.resolvedSessions.delete(input.identity.cliSessionId);
      throw error;
    }
  }

  private async spawnSession(identity: CliHostIdentity, spawnSpec: NonNullable<CliHostAttachInput["spawn"]>): Promise<ManagedSession> {
    const normalizedSpawn = this.options.normalizeSpawn?.(identity, spawnSpec) ?? spawnSpec;
    const pty = await this.options.spawn(normalizedSpawn);
    const managed: ManagedSession = {
      identity: { ...identity },
      generationId: randomUUID(),
      pty,
      status: "RUNNING",
      statusReason: "CLI process is running in the independent pane host.",
      exitCode: null,
      signal: null,
      nextOutputSequence: 0,
      outputBuffer: [],
      outputBufferBytes: 0,
      attachments: new Map(),
      detachedAtMs: null,
      terminationRequested: false,
      pendingHiddenEchoes: [],
      acceptedInputs: new Map(),
      startedAt: new Date().toISOString(),
      endedAt: null
    };
    pty.onData((data) => this.recordOutput(managed, data));
    pty.onExit((event) => {
      managed.exitCode = event.exitCode;
      managed.signal = event.signal ?? null;
      managed.status = event.exitCode === 0 || event.signal ? "EXITED" : "ERROR";
      managed.statusReason = event.signal
        ? `CLI process exited by signal ${event.signal}.`
        : event.exitCode === 0
          ? "CLI process exited."
          : `CLI process exited with code ${event.exitCode}.`;
      managed.endedAt = new Date().toISOString();
      const statusEvent: CliHostEvent = {
        type: "status",
        status: managed.status,
        statusReason: managed.statusReason,
        exitCode: event.exitCode,
        signal: managed.signal
      };
      for (const listener of managed.attachments.values()) listener?.(statusEvent);
    });
    return managed;
  }

  private recordOutput(managed: ManagedSession, data: string): void {
    const visibleData = consumeHiddenEcho(managed.pendingHiddenEchoes, data);
    if (!visibleData) return;
    for (let offset = 0; offset < visibleData.length; offset += 8_000) {
      this.recordOutputChunk(managed, visibleData.slice(offset, offset + 8_000));
    }
  }

  private recordOutputChunk(managed: ManagedSession, visibleData: string): void {
    const event: CliHostOutputEvent = {
      type: "output",
      generationId: managed.generationId,
      sequence: managed.nextOutputSequence,
      stream: "stdout",
      data: visibleData
    };
    managed.nextOutputSequence += 1;
    managed.outputBuffer.push(event);
    managed.outputBufferBytes += Buffer.byteLength(visibleData, "utf8");
    while (managed.outputBuffer.length > 1 && managed.outputBufferBytes > this.outputBufferBytes) {
      const removed = managed.outputBuffer.shift();
      if (removed) managed.outputBufferBytes -= Buffer.byteLength(removed.data, "utf8");
    }
    for (const listener of managed.attachments.values()) listener?.({ ...event });
  }

  private async requireSession(identity: CliHostIdentity): Promise<ManagedSession> {
    const pending = this.sessions.get(identity.cliSessionId);
    if (!pending) {
      throw new CliHostError("CLI_HOST_SESSION_NOT_FOUND", `CLI host session ${identity.cliSessionId} was not found.`);
    }
    const managed = await pending;
    this.assertIdentity(managed.identity, identity);
    if (managed.status !== "RUNNING") {
      throw new CliHostError("CLI_HOST_SESSION_CLOSED", `CLI host session ${identity.cliSessionId} is ${managed.status}.`);
    }
    return managed;
  }

  private requireAttachment(managed: ManagedSession, attachmentId: string): void {
    if (!managed.attachments.has(attachmentId)) {
      throw new CliHostError("CLI_HOST_ATTACHMENT_NOT_FOUND", `CLI host attachment ${attachmentId} was not found.`);
    }
  }

  private assertIdentity(expected: CliHostIdentity, actual: CliHostIdentity): void {
    const mismatch = immutableIdentityFields.find((field) => expected[field] !== actual[field]);
    if (mismatch) {
      throw new CliHostError(
        "CLI_HOST_IDENTITY_MISMATCH",
        `CLI host identity mismatch for ${actual.cliSessionId}: ${mismatch} does not match the immutable session metadata.`
      );
    }
  }

  private summarize(managed: ManagedSession): CliHostSessionSummary {
    return {
      ...managed.identity,
      generationId: managed.generationId,
      pid: managed.pty.pid,
      status: managed.status,
      statusReason: managed.statusReason,
      exitCode: managed.exitCode,
      signal: managed.signal,
      nextOutputSequence: managed.nextOutputSequence,
      attachmentCount: managed.attachments.size,
      startedAt: managed.startedAt,
      detachedAt: managed.detachedAtMs === null ? null : new Date(managed.detachedAtMs).toISOString(),
      endedAt: managed.endedAt
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function hiddenEchoCandidates(data: string): string[] {
  const candidates = new Set<string>();
  if (data) candidates.add(data);
  for (const token of data.split(/\s+/)) {
    if (token.length >= 8) candidates.add(token);
  }
  return [...candidates];
}

function consumeHiddenEcho(
  pendingHiddenEchoes: Array<{ value: string; remaining: string; expiresAtMs: number }>,
  data: string
): string {
  const active = pendingHiddenEchoes.filter((item) => item.remaining && item.expiresAtMs > Date.now());
  pendingHiddenEchoes.splice(0, pendingHiddenEchoes.length, ...active);
  let output = data;
  for (const pending of active) {
    if (!output) break;
    const exactIndex = output.indexOf(pending.remaining);
    if (exactIndex >= 0) {
      output = `${output.slice(0, exactIndex)}${output.slice(exactIndex + pending.remaining.length)}`;
      pending.remaining = pending.value;
      continue;
    }
    if (pending.remaining.startsWith(output)) {
      pending.remaining = pending.remaining.slice(output.length) || pending.value;
      return "";
    }
    const maximum = Math.min(output.length, pending.remaining.length - 1);
    for (let length = maximum; length > 0; length -= 1) {
      if (!output.endsWith(pending.remaining.slice(0, length))) continue;
      pending.remaining = pending.remaining.slice(length) || pending.value;
      output = output.slice(0, -length);
      break;
    }
  }
  return output;
}
