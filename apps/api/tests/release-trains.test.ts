import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryControlRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { changeReleaseTrain, listReleaseTrains, releaseTrainInputSchema, releaseTrainLines, type ReleaseTrainActor } from "../src/release-trains.js";

const sessionSecret = "release-train-test-secret";
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
function authHeaders(role: "OPERATOR" | "ADMIN") {
  const session = signSession({ id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role }, sessionSecret);
  return { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! };
}

const jack = { paneId: "pane:jack", name: "Jack" };
const finn = { paneId: "pane:finn", name: "Finn" };
const agent = (pane: typeof jack | null): ReleaseTrainActor => ({ roomId: "room:release1", pane, paneSelf: false });
const self = (pane: typeof jack): ReleaseTrainActor => ({ roomId: "room:release1", pane, paneSelf: true });
const op = (input: Record<string, unknown>) => releaseTrainInputSchema.parse(input);

describe("release trains", () => {
  it("keeps one live release per product that panes join instead of cutting their own version", async () => {
    const repo = new InMemoryControlRepository();
    await changeReleaseTrain(repo, op({ op: "open", version: "1.1.5" }), agent(jack));
    await expect(changeReleaseTrain(repo, op({ op: "open", version: "1.1.6" }), self(finn))).rejects.toThrow("run-spaceapp 1.1.5 is open (captain Jack): join it");
    await expect(changeReleaseTrain(repo, op({ op: "join", version: "1.1.6", commit: "3707cca9af" }), self(finn))).rejects.toThrow("join 1.1.5 instead");

    await changeReleaseTrain(repo, op({ op: "join", commit: "3707cca9af", note: "backups from a newer version" }), self(finn));
    await changeReleaseTrain(repo, op({ op: "join", commit: "aaaaaaa111" }), self(finn));
    await changeReleaseTrain(repo, op({ op: "leave", commit: "aaaaaaa111" }), self(finn));
    const [train] = await listReleaseTrains(repo);
    expect(train).toMatchObject({ version: "1.1.5", status: "OPEN", captain: jack, contributors: [{ ...finn, commit: "3707cca9af", note: "backups from a newer version" }] });

    const lines = await releaseTrainLines([train!], async (commit, ref) => ref === "dev");
    expect(lines.join("\n")).toContain("Finn: 3707cca9af (backups from a newer version); in dev yes, in main no, in candidate n/a (needs the operator's dev→stable promote).");
    // A cherry-pick that is already in the candidate needs no promote.
    expect((await releaseTrainLines([{ ...train!, sourceSha: "a41d4b238a" }], async (commit, ref) => ref === "a41d4b238a")).join("\n"))
      .toContain("in dev no, in main no, in candidate yes.");
  });

  it("lets only the captain move a pane's release on, and closes joins once publishing starts", async () => {
    const repo = new InMemoryControlRepository();
    await changeReleaseTrain(repo, op({ op: "open", version: "1.1.5" }), self(jack));
    await expect(changeReleaseTrain(repo, op({ op: "publishing" }), self(jack))).rejects.toThrow("Record the candidate");
    await expect(changeReleaseTrain(repo, op({ op: "candidate", sourceSha: "c1537956b8" }), self(finn))).rejects.toThrow("Only the captain (Jack)");
    await changeReleaseTrain(repo, op({ op: "candidate", sourceSha: "c1537956b8" }), self(jack));
    await changeReleaseTrain(repo, op({ op: "publishing" }), self(jack));
    await expect(changeReleaseTrain(repo, op({ op: "join", commit: "3707cca9af" }), self(finn))).rejects.toThrow("goes to the next release");

    await changeReleaseTrain(repo, op({ op: "published" }), self(jack));
    await changeReleaseTrain(repo, op({ op: "open", version: "1.1.6" }), agent(finn));
    expect(await listReleaseTrains(repo)).toEqual([expect.objectContaining({ version: "1.1.6", status: "OPEN", captain: finn, sourceSha: null, contributors: [] })]);
  });

  it("serves panes of their own room through the ADMIN route, as the pane itself", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Release", initialPaneCount: 0 });
    const other = store.createRoom({ name: "Other", initialPaneCount: 0 });
    const [jackPane, finnPane] = ["Jack", "Finn"].map((title) => store.createPane({ roomId: room.id, title, mode: "TERMINAL", terminalRuntimeId: "cli:claude" }));
    store.updatePane(jackPane!.id, { paneName: "Jack" });
    const app = await createApp({ store, config: getApiConfig({}), auth: { sessionSecret, devLogin: false, secureCookies: false } });
    apps.push(app);
    const post = (role: "OPERATOR" | "ADMIN", body: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/release-trains", headers: authHeaders(role), payload: body });

    expect((await post("OPERATOR", { op: "status", roomId: room.id, paneId: jackPane!.id })).statusCode).toBe(403);
    expect((await post("ADMIN", { op: "open", version: "1.1.5", roomId: other.id, paneId: jackPane!.id })).statusCode).toBe(403);
    const opened = await post("ADMIN", { op: "open", version: "1.1.5", roomId: room.id, paneId: jackPane!.id });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json().text).toContain("run-spaceapp 1.1.5: OPEN, captain Jack");
    const second = await post("ADMIN", { op: "open", version: "1.1.6", roomId: room.id, paneId: finnPane!.id });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.message).toContain("join it instead of cutting your own version");
    expect((await post("ADMIN", { op: "publishing", roomId: room.id, paneId: finnPane!.id })).json().error.message).toContain("Only the captain (Jack)");
  });
});
