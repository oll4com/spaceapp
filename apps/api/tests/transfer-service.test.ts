// Settings → Transfer (plan clipboard:HO2VBvn_aaPI step 4): the service runs scripts/space-transfer.mjs, pairs only on the target's code
// and refuses what the host has not set up.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { registerTransferRoutes } from "../src/transfer-routes.js";
import { createTransferService, runNousTransfer, TransferError } from "../src/transfer-service.js";

const script = fileURLToPath(new URL("../../../scripts/space-transfer.mjs", import.meta.url));
const db = "postgres://space:unused@127.0.0.1:1/space";

it("keys, pairing code parity with the script, pair and its refusals", async () => {
  const root = await mkdtemp(join(tmpdir(), "space-transfer-api-"));
  const service = createTransferService({ installRoot: root, databaseUrl: db, script });
  const keys = await (await service.start({ action: "keys" })).done;
  expect(keys.error).toBeNull();
  expect((await service.status()).pairingCode).toBe((keys.result as { pairingCode: string }).pairingCode);

  await expect(service.start({ action: "sync" })).rejects.toThrow(/Pair a target first/);
  const target = JSON.parse(execFileSync(process.execPath, [script, "keys", "--dir", join(root, "target")], { encoding: "utf8" })) as { pairingCode: string };
  const card = await readFile(join(root, "target", "card.json"), "utf8");
  await expect(service.pair({ card: "not json", code: target.pairingCode })).rejects.toBeInstanceOf(TransferError);
  await expect(service.pair({ card: "{}", code: target.pairingCode })).rejects.toThrow(/not a space-transfer card/);
  await expect(service.pair({ card, code: "0000-0000-0000" })).rejects.toThrow(/does not match/);
  expect(await service.pair({ card, code: target.pairingCode.toLowerCase().replace(/-/g, " ") })).toEqual({ pairingCode: target.pairingCode });
  expect((await stat(join(service.dir, "target-card.json"))).mode & 0o777).toBe(0o600);
  expect((await service.status()).target?.pairingCode).toBe(target.pairingCode);

  await expect(service.start({ action: "cutover" })).rejects.toThrow(/apply and switch commands/);
  await expect(service.start({ action: "rollback", dryRun: true })).rejects.toThrow(/switch command/);
});

it("a failed job carries the script's last line, one job at a time, and Nous reads it", async () => {
  const root = await mkdtemp(join(tmpdir(), "space-transfer-api-"));
  const fake = join(root, "fake.mjs");
  await writeFile(fake, "setTimeout(() => { console.error('psql noise\\nspace-transfer: boom'); process.exit(1); }, 200);\n");
  const service = createTransferService({ installRoot: root, databaseUrl: db, script: fake });
  const started = await service.start({ action: "manifest" });
  await expect(service.start({ action: "manifest" })).rejects.toThrow(/job runs/);
  expect((await started.done).error).toBe("boom");
  expect((await runNousTransfer(service, { action: "manifest" })).result).toBe("boom");
  await expect(createTransferService({ installRoot: root, databaseUrl: null, script: fake }).start({ action: "manifest" })).rejects.toThrow(/no database URL/);
});

it("a real rollback is audited after it ends (the source is read-only until then); other actions at once", async () => {
  const root = await mkdtemp(join(tmpdir(), "space-transfer-route-"));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "var", "transfer"), { recursive: true });
  await writeFile(join(root, "scripts", "space-transfer.mjs"), "setTimeout(() => console.log('{}'), 300);\n");
  await writeFile(join(root, "var", "transfer", "commands.json"), JSON.stringify({ switchCommand: "true" }));
  const audits: { action: string; at: number }[] = [];
  const store = { upsertUser: async (user: object) => user, recordAuditEvent: async (event: { action: string }) => { audits.push({ action: event.action, at: Date.now() }); } };
  const app = Fastify();
  app.addHook("onRequest", async (request) => { request.user = { id: "user:admin", role: "ADMIN" } as typeof request.user; });
  registerTransferRoutes(app, { store: store as never, config: { installRoot: root, databaseUrl: db }, routeOptions: {} });
  const run = async (body: object) => {
    const answer = await app.inject({ method: "POST", url: "/api/transfer/run", payload: body });
    expect(answer.statusCode).toBe(200);
    while (!(await app.inject({ url: "/api/transfer" })).json().job.endedAt) await new Promise((resolve) => setTimeout(resolve, 50));
    return Date.parse((await app.inject({ url: "/api/transfer" })).json().job.endedAt as string);
  };
  const dryEnded = await run({ action: "rollback", dryRun: true });
  const realEnded = await run({ action: "rollback" });
  await app.close();
  expect(audits.map((entry) => entry.action)).toEqual(["transfer.rollback", "transfer.rollback"]);
  expect(audits[0]!.at).toBeLessThan(dryEnded);
  expect(audits[1]!.at).toBeGreaterThanOrEqual(realEnded);
});
