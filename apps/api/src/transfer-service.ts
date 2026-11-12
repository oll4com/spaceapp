import { spawn } from "./safe-child-process.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { childProcessEnv } from "./child-process-env.js";

/**
 * Settings → Transfer and space_transfer (plan clipboard:HO2VBvn_aaPI step 4): this host as a transfer source, run through
 * scripts/space-transfer.mjs with this API's own database URL in the child's environment (the API's user has no docker).
 * Everything lives in <install root>/var/transfer: key.json and card.json (keys), target-card.json (a paired target),
 * source-state.json (sync), bundles/, and commands.json, the cutover's apply and switch commands, which only the operator
 * writes on the host: no command ever comes from a request. Answers carry codes, counts and times, never a key or a command.
 */
export const transferActions = ["keys", "manifest", "sync", "cutover", "rollback"] as const;
export type TransferAction = (typeof transferActions)[number];
export const transferRunSchema = z.object({ action: z.enum(transferActions), dryRun: z.boolean().optional() }).strict();
export const transferPairSchema = z.object({ card: z.string().min(2).max(64_000), code: z.string().min(4).max(40) }).strict();

type Card = { format: string; encryptPublicKey: string; signPublicKey: string; vaultTransportKey?: string };
export type TransferJob = { action: TransferAction; dryRun: boolean; startedAt: string; endedAt: string | null; result: unknown; error: string | null };

/** The same formula as pairingCode in scripts/space-transfer.mjs, which the target's keys and code commands print. */
export const transferPairingCode = (card: Card) => createHash("sha256")
  .update(JSON.stringify([card.encryptPublicKey, card.signPublicKey, card.vaultTransportKey ?? null])).digest("hex")
  .slice(0, 12).toUpperCase().match(/.{4}/g)!.join("-");

const normalCode = (code: string) => code.toUpperCase().replace(/[^0-9A-F]/g, "");

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

// One job per transfer folder, shared by the routes and Nous: two syncs at once would race on the source state.
const running = new Map<string, TransferJob>();
const last = new Map<string, TransferJob>();

export type TransferService = ReturnType<typeof createTransferService>;
export function createTransferService(options: { installRoot: string; databaseUrl: string | null; script?: string; dir?: string }) {
  const dir = options.dir ?? join(options.installRoot, "var", "transfer");
  const path = (name: string) => join(dir, name);
  const script = options.script ?? join(options.installRoot, "scripts", "space-transfer.mjs");

  async function status() {
    const card = await readJson<Card>(path("card.json"));
    const target = await readJson<Card & { pairedAt?: string }>(path("target-card.json"));
    const commands = await readJson<{ applyCommand?: string; switchCommand?: string }>(path("commands.json"));
    const state = await readJson<{ head?: string; tables?: object; files?: object; cutoverAt?: string; rollbackDryRun?: string }>(path("source-state.json"));
    return {
      pairingCode: card ? transferPairingCode(card) : null,
      target: target ? { pairingCode: transferPairingCode(target), pairedAt: target.pairedAt ?? null } : null,
      commands: { apply: Boolean(commands?.applyCommand), switch: Boolean(commands?.switchCommand) },
      state: state ? { head: state.head ?? null, tables: Object.keys(state.tables ?? {}).length, files: Object.keys(state.files ?? {}).length,
        cutoverAt: state.cutoverAt ?? null, rollbackDryRun: state.rollbackDryRun ?? null } : null,
      job: running.get(dir) ?? last.get(dir) ?? null
    };
  }

  /** Pairs the target whose card the operator pasted, only when it shows the code the target printed. */
  async function pair(input: z.infer<typeof transferPairSchema>) {
    let card: Card;
    try { card = JSON.parse(input.card) as Card; } catch { throw new TransferError("The target card is not JSON: paste the whole card.json the target's keys wrote."); }
    if (card?.format !== "space-transfer-card" || typeof card.encryptPublicKey !== "string" || typeof card.signPublicKey !== "string") {
      throw new TransferError("This is not a space-transfer card.");
    }
    const code = transferPairingCode(card);
    if (normalCode(code) !== normalCode(input.code)) throw new TransferError("The code does not match this card: check both on the target.");
    if (running.has(dir)) throw new TransferError("A transfer job runs: pair after it ends.");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const { format, encryptPublicKey, signPublicKey, vaultTransportKey } = card;
    await writeFile(path("target-card.json"), `${JSON.stringify({ format, version: 1, encryptPublicKey, signPublicKey,
      ...(vaultTransportKey ? { vaultTransportKey } : {}), pairedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    return { pairingCode: code };
  }

  async function argsFor(action: TransferAction, dryRun: boolean) {
    const base = ["--var-root", join(options.installRoot, "var"), "--repo", options.installRoot];
    const commands = await readJson<{ applyCommand?: string; switchCommand?: string }>(path("commands.json"));
    const paired = ["--to", path("target-card.json"), "--key", path("key.json"), "--output", path("bundles"), "--state", path("source-state.json")];
    const dry = dryRun ? ["--dry-run"] : [];
    const needTarget = async () => { if (!(await readJson(path("target-card.json")))) throw new TransferError("Pair a target first."); };
    switch (action) {
      case "keys": return ["keys", "--dir", dir];
      case "manifest": return ["manifest", ...base];
      case "sync":
        await needTarget();
        return ["sync", ...base, ...paired, ...(await readJson(path("source-state.json")) ? [] : ["--full"])];
      case "cutover":
        await needTarget();
        if (!commands?.applyCommand || !commands.switchCommand) throw new TransferError(`Cutover needs the apply and switch commands in ${path("commands.json")} on this host.`);
        return ["cutover", ...base, ...paired, "--apply-command", commands.applyCommand, "--switch-command", commands.switchCommand, ...dry];
      case "rollback":
        if (!commands?.switchCommand) throw new TransferError(`Rollback needs the switch command in ${path("commands.json")} on this host.`);
        return ["rollback", "--state", path("source-state.json"), "--switch-command", commands.switchCommand, ...dry];
    }
  }

  /** Starts one job; resolves with it when it ends (callers that answer at once do not wait). */
  async function start(input: z.infer<typeof transferRunSchema>): Promise<{ job: TransferJob; done: Promise<TransferJob> }> {
    if (!options.databaseUrl) throw new TransferError("This server has no database URL for the transfer.");
    if (running.has(dir)) throw new TransferError(`A ${running.get(dir)!.action} job runs since ${running.get(dir)!.startedAt}.`);
    const dryRun = input.dryRun ?? false;
    const args = await argsFor(input.action, dryRun);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const job: TransferJob = { action: input.action, dryRun, startedAt: new Date().toISOString(), endedAt: null, result: null, error: null };
    running.set(dir, job);
    const done = new Promise<TransferJob>((resolve) => {
      const child = spawn(process.execPath, [script, ...args], { cwd: options.installRoot, stdio: ["ignore", "pipe", "pipe"],
        env: { ...childProcessEnv(), SPACE_TRANSFER_DATABASE_URL: options.databaseUrl! } });
      let out = "";
      let errors = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
      const end = (error: string | null) => {
        job.endedAt = new Date().toISOString();
        if (!error) { try { job.result = JSON.parse(out); } catch { job.error = "The transfer answered no JSON."; } }
        // The script prints only "space-transfer: <message>" (psql's quoted values masked); its last line is the reason.
        else job.error = error;
        running.delete(dir);
        last.set(dir, job);
        resolve(job);
      };
      child.on("error", (error) => end(error.message));
      child.on("close", (code) => end(code === 0 ? null : errors.trim().split("\n").at(-1)?.replace(/^space-transfer: /, "") || `The transfer exited with ${code}.`));
    });
    return { job, done };
  }

  return { dir, status, pair, start };
}

export class TransferError extends Error {}

/** space_transfer: Nous reads the transfer and starts its manifest or a sync; cutover and rollback stay the operator's buttons. */
export const nousTransferArgsSchema = z.object({
  action: z.enum(["status", "manifest", "sync"]).describe("status: pairing, state and the last job; manifest: what would move; sync: send what changed to the paired target.")
}).strict();

export async function runNousTransfer(service: TransferService, args: z.infer<typeof nousTransferArgsSchema>, waitMs = 40_000) {
  const text = (value: unknown) => JSON.stringify(value, null, 2);
  if (args.action === "status") return { ok: true, display: "Read the transfer", result: text(await service.status()) };
  let started;
  try { started = await service.start({ action: args.action }); }
  catch (error) { if (error instanceof TransferError) return { ok: false, display: `Could not start the ${args.action}`, result: error.message }; throw error; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const job = await Promise.race([started.done, new Promise<null>((resolve) => { timer = setTimeout(resolve, waitMs, null); })]);
  clearTimeout(timer);
  if (!job) return { ok: true, display: `The ${args.action} runs`, result: `The ${args.action} runs on since ${started.job.startedAt}; read it with space_transfer status.` };
  return { ok: !job.error, display: job.error ? `The ${args.action} failed` : `The ${args.action} ended`, result: job.error ?? text(job.result) };
}
