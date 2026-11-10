import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryControlRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { cachedContains, changeReleaseTrain, listReleaseTrains, releaseTrainInputSchema, releaseTrainLines, type ReleaseTrainActor } from "../src/release-trains.js";

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
  // Stable 2026-10-28: the train's record carried its captain's room, and deleting that room deleted it (migration 0260).
  it("stores a train with no room on its record, so no room delete takes it; the captain's room stays in the value", async () => {
    const repo = new InMemoryControlRepository();
    await changeReleaseTrain(repo, op({ op: "open", version: "1.1.5" }), agent(jack));
    await changeReleaseTrain(repo, op({ op: "candidate", sourceSha: "4be1c81f55" }), agent(jack));
    const record = (await repo.get("release_train", "space", "run-spaceapp"))!;
    expect(record.roomId).toBe("");
    expect(record.value).toMatchObject({ roomId: "room:release1", captain: jack, sourceSha: "4be1c81f55" });
  });

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

  it("keeps every joined change of a live train, however many join (Record Retention Invariant)", async () => {
    const repo = new InMemoryControlRepository();
    await changeReleaseTrain(repo, op({ op: "open", version: "1.1.5" }), agent(jack));
    for (let index = 0; index < 60; index++) await changeReleaseTrain(repo, op({ op: "join", commit: `c0ffee${String(index).padStart(4, "0")}` }), self(finn));
    const [train] = await listReleaseTrains(repo);
    expect(train!.contributors).toHaveLength(60);
    expect(train!.contributors[0]!.commit).toBe("c0ffee0000");
  });

  it("lets only the captain move a pane's release on, and closes joins once publishing starts", async () => {
    const repo = new InMemoryControlRepository();
    await changeReleaseTrain(repo, op({ op: "open", version: "1.1.5" }), self(jack));
    await expect(changeReleaseTrain(repo, op({ op: "publishing" }), self(jack))).rejects.toThrow("Record the candidate");
    await expect(changeReleaseTrain(repo, op({ op: "candidate", sourceSha: "c1537956b8" }), self(finn))).rejects.toThrow("Only the captain (Jack)");
    await changeReleaseTrain(repo, op({ op: "candidate", sourceSha: "c1537956b8" }), self(jack));
    await changeReleaseTrain(repo, op({ op: "approve" }), { ...agent(null), operatorApproved: true });
    await changeReleaseTrain(repo, op({ op: "publishing" }), self(jack));
    await expect(changeReleaseTrain(repo, op({ op: "join", commit: "3707cca9af" }), self(finn))).rejects.toThrow("goes to the next release");

    await changeReleaseTrain(repo, op({ op: "published" }), self(jack));
    await changeReleaseTrain(repo, op({ op: "open", version: "1.1.6" }), agent(finn));
    expect(await listReleaseTrains(repo)).toEqual([expect.objectContaining({ version: "1.1.6", status: "OPEN", captain: finn, sourceSha: null, contributors: [] })]);
  });

  it("publishes only a candidate the operator approved through a Nous decision", async () => {
    const repo = new InMemoryControlRepository();
    await changeReleaseTrain(repo, op({ op: "open", version: "1.1.5" }), self(jack));
    await expect(changeReleaseTrain(repo, op({ op: "approve" }), { ...agent(null), operatorApproved: true })).rejects.toThrow("Record the candidate");
    await changeReleaseTrain(repo, op({ op: "candidate", sourceSha: "c1537956b8" }), self(jack));
    // Neither the captain, nor the Room Agent, nor a pane approves: only the operator's yes in the Nous dock.
    for (const by of [self(jack), agent(finn)]) await expect(changeReleaseTrain(repo, op({ op: "approve" }), by)).rejects.toThrow("Only the operator approves a release");
    await expect(changeReleaseTrain(repo, op({ op: "publishing" }), self(jack))).rejects.toThrow("The operator has not approved run-spaceapp 1.1.5 at c1537956b8");
    await changeReleaseTrain(repo, op({ op: "approve" }), { ...agent(null), operatorApproved: true });
    expect((await releaseTrainLines(await listReleaseTrains(repo), async () => true)).join("\n")).toContain("candidate c1537956b8 (approved by the operator)");
    // A new candidate voids the approval.
    await changeReleaseTrain(repo, op({ op: "candidate", sourceSha: "d2648a67c9" }), self(jack));
    await expect(changeReleaseTrain(repo, op({ op: "publishing" }), self(jack))).rejects.toThrow("has not approved");
    // R13-15b: the earlier candidate's approval stays on the train (approvedSha), so Nous knows this version is approved, and the approve
    // on that release OK binds to the new candidate it checked.
    expect((await listReleaseTrains(repo))[0]).toMatchObject({ sourceSha: "d2648a67c9", approvedSha: "c1537956b8" });
    await expect(changeReleaseTrain(repo, op({ op: "approve", sourceSha: "e3759a78b0" }), { ...agent(null), operatorApproved: true })).rejects.toThrow("candidate changed");
    await changeReleaseTrain(repo, op({ op: "approve", sourceSha: "d2648a67c9" }), { ...agent(null), operatorApproved: true });
    expect(await changeReleaseTrain(repo, op({ op: "publishing" }), self(jack))).toMatchObject({ status: "PUBLISHING", approvedSha: "d2648a67c9" });
    await expect(changeReleaseTrain(repo, op({ op: "candidate", sourceSha: "e3759a78b0" }), self(jack))).rejects.toThrow("already publishing");

    // A train marked publishing before approvals existed (stable 1.1.6) reopens with a new candidate, so the operator can approve it.
    const record = (await repo.get("release_train", "space", "run-spaceapp"))!;
    const { approvedSha: _approved, ...legacy } = record.value as Record<string, unknown>;
    await repo.write({ kind: "release_train", actorId: "space", key: "run-spaceapp", roomId: "room:release1", version: record.version, value: legacy }, record.version);
    expect(await changeReleaseTrain(repo, op({ op: "candidate", sourceSha: "e3759a78b0" }), self(jack))).toMatchObject({ status: "OPEN", sourceSha: "e3759a78b0" });
  });

  it("takes the lab proof only from the captain's own pane, only for the current candidate, and approves only the checked candidate", async () => {
    const repo = new InMemoryControlRepository();
    await changeReleaseTrain(repo, op({ op: "open", version: "1.1.10" }), agent(jack));
    await changeReleaseTrain(repo, op({ op: "candidate", sourceSha: "b5e2d1c0aa" }), self(jack));
    const lab = { acceptanceSha256: "A".repeat(64), allCasesPass: true, freshInstall: true, ciGreen: true, versionVerified: true, warm: "NONE", previousVersion: "1.1.9" };
    await expect(changeReleaseTrain(repo, op({ op: "lab", sourceSha: "b5e2d1c0aa", lab }), agent(jack))).rejects.toThrow("Only the captain pane (Jack) records the lab proof");
    await expect(changeReleaseTrain(repo, op({ op: "lab", sourceSha: "b5e2d1c0aa", lab }), self(finn))).rejects.toThrow("Only the captain pane (Jack)");
    await expect(changeReleaseTrain(repo, op({ op: "lab", sourceSha: "0000000aaa", lab }), self(jack))).rejects.toThrow("name the current candidate's sourceSha exactly");
    const train = await changeReleaseTrain(repo, op({ op: "lab", sourceSha: "b5e2d1c0aa", lab }), self(jack));
    expect(train.lab).toMatchObject({ sourceSha: "b5e2d1c0aa", acceptanceSha256: "a".repeat(64), by: "Jack", previousVersion: "1.1.9" });
    expect((await releaseTrainLines([train], async () => true)).join("\n")).toContain("Lab proof for b5e2d1c0aa: all cases PASS yes, fresh install yes, CI green yes, space-version verify yes, Warm NONE, rollback to 1.1.9; recorded by Jack");
    // The approval names the commit it checked: a candidate changed meanwhile is not approved.
    await changeReleaseTrain(repo, op({ op: "candidate", sourceSha: "c6f3e2d1bb" }), self(jack));
    await expect(changeReleaseTrain(repo, op({ op: "approve", sourceSha: "b5e2d1c0aa" }), { ...agent(null), operatorApproved: true })).rejects.toThrow("The candidate changed to c6f3e2d1bb");
    expect((await releaseTrainLines(await listReleaseTrains(repo), async () => true)).join("\n")).toContain("(an older candidate: does not count)");
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

  // API audit 4/11: every room's minute read spawned git twice per joined change; an answer now holds until its ref moves.
  it("asks git once per commit, ref and ref position, and an unknown answer again after five minutes", async () => {
    const asked: string[] = [];
    let devKey = "dev@1";
    let clock = 0;
    const contains = cachedContains(async (commit, ref) => { asked.push(`${commit} ${ref}`); return commit === "gone" ? null : ref === "dev"; },
      async (ref) => (ref === "dev" ? devKey : ""), () => clock);
    expect(await Promise.all([contains("a1", "dev"), contains("a1", "dev"), contains("a1", "main")])).toEqual([true, true, false]);
    expect(await contains("a1", "dev")).toBe(true);
    expect(asked).toEqual(["a1 dev", "a1 main"]);
    devKey = "dev@2";
    await contains("a1", "dev"); await contains("a1", "main");
    expect(await contains("gone", "dev")).toBeNull(); await contains("gone", "dev");
    expect(asked).toEqual(["a1 dev", "a1 main", "a1 dev", "gone dev"]);
    clock = 5 * 60_000;
    await contains("gone", "dev"); await contains("a1", "dev");
    expect(asked).toEqual(["a1 dev", "a1 main", "a1 dev", "gone dev", "gone dev"]);
  });
});
