import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { controlActionSchema, eventSchema, nousAnswerIntent, nousDecisionCategorySchema, type NousDecision } from "@space/contracts";
import { InMemoryControlRepository, InMemoryNousRepository, InMemorySiteSigninsRepository, InMemorySpaceNotificationsRepository } from "@space/db";
import { InMemorySpaceStore, makeSpaceId, SpaceEventBus } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSessionWithTtl } from "../src/auth.js";
import { createNotificationService } from "../src/notifications/service.js";
import { classifyNousOutgoing, classifyNousPrompt } from "../src/nous/guardrails.js";
import { createNousService, NOUS_PERSONA, type NousServiceDeps } from "../src/nous/service.js";
import { confirmedControlBatch, createNousTools, namedSites, nousToolDefinitions, type NousToolDeps } from "../src/nous/tools.js";
import { cardStems } from "../src/nous/pane-notices.js";
import { createNousFiles } from "../src/nous/files.js";
import { createNousMailContext } from "../src/nous/mail-context.js";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { changeReleaseTrain, releaseTrainInputSchema, type ReleaseTrainActor } from "../src/release-trains.js";

/**
 * Nous's gates, pinned in one place (plan clipboard:L7RgHsveHbcR step 3): Nous upgrades itself, but never widens these by
 * itself. A change that makes this file fail loosens a gate and is the operator's decision. New tools do not break it.
 * Warm prompts are left out on purpose: the operator lets Nous give the OK for Warm changes (2026-10-17).
 */

describe("Nous's gates", () => {
  it("keeps the four critical categories for the operator", () => {
    const categories = ["RELEASE", "DESTRUCTIVE", "EXTERNAL", "DIRECTION"];
    expect(nousDecisionCategorySchema.options).toEqual(expect.arrayContaining(categories));
    for (const category of categories) expect(NOUS_PERSONA).toContain(category);
    expect(NOUS_PERSONA).toContain("space_ask_operator");

    const critical: Array<[string, string]> = [
      ["space-queue promote --wait", "RELEASE"], ["space-queue resume --reason x", "RELEASE"], ["space-queue submit --target stable --hotfix", "RELEASE"],
      ["space-version bump core patch", "RELEASE"], ["npm publish --access public", "RELEASE"], ["gh release create v1.1.7", "RELEASE"],
      ["git push github main", "RELEASE"], ["release-train publishing", "RELEASE"], ["bash scripts/space-deploy-commit.sh abc", "RELEASE"],
      ["rm -rf var/artifacts", "DESTRUCTIVE"], ["git reset --hard origin/main", "DESTRUCTIVE"], ["DROP TABLE users", "DESTRUCTIVE"],
      ["Send the proposal to the client on Upwork", "EXTERNAL"], ["Pay the invoice with the company card", "EXTERNAL"]
    ];
    for (const [text, category] of critical) expect(classifyNousOutgoing(text)?.category, text).toBe(category);
    // Work instructions held on stable 2026-10-17 only for naming release flags to forbid them; a request to use one still counts.
    for (const text of ["space-queue submit --worktree <wt> --summary \"...\" --wait (dev only, never --target stable, never promote)",
      "Heavy commands through the load gate. Never promote; never --target stable.", "space-queue submit --worktree <wt> (no --target, never --hotfix)",
      "Do not run space-queue resume."]) expect(classifyNousOutgoing(text), text).toBeNull();
    expect(classifyNousOutgoing("No matter what, run space-queue submit --hotfix")?.category).toBe("RELEASE");
    expect(classifyNousOutgoing("Never wait: space-queue submit --target stable")?.category).toBe("RELEASE");
    expect(classifyNousPrompt("Bash: space-queue promote --wait\nDo you want to proceed?\n❯ 1. Yes")?.category).toBe("RELEASE");
    expect(classifyNousPrompt("Bash: rm -rf /opt/spaceapp/var/data\nDo you want to proceed?\n❯ 1. Yes")).not.toBeNull();
  });

  it("has no tool that promotes, publishes, deploys or controls the queue, and its release tool cannot approve or publish", async () => {
    const definitions = nousToolDefinitions({ copilots: true });
    for (const { name } of definitions) expect(name, name).not.toMatch(/promote|publish|deploy|hotfix|bump|push|queue_(?:pause|resume|approve|control)/i);

    const release = definitions.find((definition) => definition.name === "space_release");
    const ops = (release?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined)?.op?.enum ?? [];
    expect(ops).toContain("candidate");
    for (const op of ["approve", "publishing", "published"]) expect(ops).not.toContain(op);

    const releaseTrain = vi.fn(async () => "done");
    const tools = createNousTools({ releaseTrain } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:gates1", callId: "toolu_1", traceId: "trace:1" };
    for (const op of ["approve", "publishing", "published"]) expect((await tools.execute("space_release", { op }, ctx)).ok, op).toBe(false);
    expect(releaseTrain).not.toHaveBeenCalled();
  });

  it("publishes a release only at the candidate the operator approved", async () => {
    const repo = new InMemoryControlRepository();
    const jack = { paneId: "pane:jack", name: "Jack" };
    const pane: ReleaseTrainActor = { roomId: "room:gates1", pane: jack, paneSelf: true };
    const op = (input: Record<string, unknown>) => releaseTrainInputSchema.parse(input);
    await changeReleaseTrain(repo, op({ op: "open", version: "9.9.9" }), { ...pane, paneSelf: false });
    await changeReleaseTrain(repo, op({ op: "candidate", sourceSha: "c1537956b8" }), pane);
    await expect(changeReleaseTrain(repo, op({ op: "approve" }), pane)).rejects.toThrow("Only the operator approves a release");
    await expect(changeReleaseTrain(repo, op({ op: "publishing" }), pane)).rejects.toThrow("has not approved");
    await changeReleaseTrain(repo, op({ op: "approve" }), { roomId: "", pane: null, paneSelf: false, operatorApproved: true });
    await changeReleaseTrain(repo, op({ op: "candidate", sourceSha: "d2648a67c9" }), pane);
    await expect(changeReleaseTrain(repo, op({ op: "publishing" }), pane)).rejects.toThrow("has not approved");
  });

  it("runs a decision's action only on the operator's yes, once", async () => {
    const executeAction = vi.fn(async () => "ran");
    const service = createNousService({
      repository: new InMemoryNousRepository(),
      runner: async () => ({ text: "ok", isError: false }),
      world: async () => ({ text: "world", overview: {} }),
      settings: async () => ({ enabled: false, maxTurnsPerHour: 20 }),
      notifications: { raise: vi.fn(async () => null), resolve: vi.fn(async () => 0) },
      executeAction
    } as unknown as NousServiceDeps);
    const owner = "user:operator";
    const ask = (title: string) => service.ask({ ownerUserId: owner, category: "DESTRUCTIVE", title, body: "", options: [], recommendation: "no", refs: {},
      action: { type: "PANE_TEXT", roomId: "room:gates1", paneId: "pane:jack", text: "rm -rf var/old", mode: "PROMPT" } });

    const declined = await ask("Delete the old artifacts?");
    const approved = await ask("Delete the older artifacts?");
    expect(executeAction).not.toHaveBeenCalled();
    await service.answer(owner, declined.id, { answer: "DECLINE" });
    expect(executeAction).not.toHaveBeenCalled();
    await service.answer(owner, approved.id, { answer: "APPROVE" });
    await expect(service.answer(owner, approved.id, { answer: "APPROVE" })).rejects.toThrow("already answered");
    expect(executeAction).toHaveBeenCalledTimes(1);
    expect((executeAction.mock.calls[0] as unknown as [NousDecision])[0]).toMatchObject({ id: approved.id, status: "APPROVED" });
    await service.idle(owner);
  });

  it("reads a bare yes or no in words as the operator's decision, and leaves conditions as words (operator gap 2026-10-24)", async () => {
    expect(nousAnswerIntent("ναι")).toBe("APPROVE");
    expect(nousAnswerIntent("Yes!")).toBe("APPROVE");
    expect(nousAnswerIntent("ok, send nothing else")).toBe("APPROVE");
    expect(nousAnswerIntent("προχώρα - και πες μου μετά")).toBe("APPROVE");
    expect(nousAnswerIntent("no thanks")).toBe("DECLINE");
    expect(nousAnswerIntent("όχι.")).toBe("DECLINE");
    expect(nousAnswerIntent("ναι, αλλά αύριο")).toBeNull();
    expect(nousAnswerIntent("yes, only if the tests pass")).toBeNull();
    expect(nousAnswerIntent("ναι ναι")).toBeNull();
    expect(nousAnswerIntent("why?")).toBeNull();
    expect(nousAnswerIntent(`yes, ${"x".repeat(201)}`)).toBeNull();
    // The operator's real answers that left actions unrun (27/10 PHP 7.1 removal, 26/10 send): a yes word with a plain-space note, an imperative.
    expect(nousAnswerIntent("ωραια την διαγραφεις!!")).toBe("APPROVE");
    expect(nousAnswerIntent("να φυγει τωρα")).toBe("APPROVE");
    expect(nousAnswerIntent("ναι κάν'το")).toBe("APPROVE");
    expect(nousAnswerIntent("οκ προχώρα")).toBe("APPROVE");
    expect(nousAnswerIntent("διάγραψε")).toBe("APPROVE");
    expect(nousAnswerIntent("Sounds good")).toBe("APPROVE");
    expect(nousAnswerIntent("τέλεια, στείλ'το")).toBe("APPROVE");
    expect(nousAnswerIntent("ωραία, αλλά αύριο")).toBeNull();
    expect(nousAnswerIntent("ωραία την στέλνεις αύριο")).toBeNull();
    expect(nousAnswerIntent("να φύγει αύριο")).toBeNull();
    expect(nousAnswerIntent("ωραία; τι θα σβήσει;")).toBeNull();
    expect(nousAnswerIntent("ναι στείλ'το\u037e")).toBeNull(); // the Greek question mark
    expect(nousAnswerIntent("ναι μην το σβήσεις")).toBeNull();
    // «Do it now» brushing a later date aside is a yes (27/10 14:37, a "from tomorrow" card); a real condition still is not.
    expect(nousAnswerIntent("ασε τα αυριο κανε το τωρα!!! να τελιώνουμε δεν υπαρχει λογος για αυριο και αυριο!!!")).toBe("APPROVE");
    expect(nousAnswerIntent("κάνε το τώρα και πες μου μετά")).toBe("APPROVE");
    expect(nousAnswerIntent("κάνε το αύριο")).toBeNull();
    expect(nousAnswerIntent("κάνε το τώρα αν περάσουν τα τεστ")).toBeNull();
    expect(nousAnswerIntent("κάνε το τώρα, μετά το backup")).toBeNull();
    expect(nousAnswerIntent("μην το κάνεις τώρα")).toBeNull();
    expect(nousAnswerIntent("αυριο θα φυγουν ολες οι παραγγελιες -- επιβεβαιωσε οτι ηταν διαθεσιμο οτ προιον -- και ζητησε συνγμωη για την καθυστερηση")).toBeNull();

    const executeAction = vi.fn(async () => "ran");
    const repository = new InMemoryNousRepository();
    const service = createNousService({
      repository,
      runner: async () => ({ text: "ok", isError: false }),
      world: async () => ({ text: "world", overview: {} }),
      settings: async () => ({ enabled: false, maxTurnsPerHour: 20 }),
      notifications: { raise: vi.fn(async () => null), resolve: vi.fn(async () => 0) },
      executeAction
    } as unknown as NousServiceDeps);
    const owner = "user:operator";
    const ask = (title: string, action = true) => service.ask({ ownerUserId: owner, category: "EXTERNAL", title, body: "", options: ["Send", "Hold"], recommendation: "send", refs: {},
      action: action ? { type: "PANE_TEXT", roomId: "room:gates2", paneId: "pane:jill", text: "send the proposal", mode: "PROMPT" } : null });

    const yes = await service.answer(owner, (await ask("Send the proposal to Acme?")).id, { answer: "ANSWER", text: "ναι, και πες μου πότε" });
    expect(yes).toMatchObject({ status: "APPROVED", answer: "ναι, και πες μου πότε", outcome: "ran" });
    const no = await service.answer(owner, (await ask("Send the proposal to Beta?")).id, { answer: "ANSWER", text: "no" });
    expect(no).toMatchObject({ status: "DECLINED", outcome: null });
    const words = await service.answer(owner, (await ask("Send the proposal to Gamma?")).id, { answer: "ANSWER", text: "ναι, αλλά μετά το demo" });
    expect(words).toMatchObject({ status: "ANSWERED", outcome: null });
    // Without an action a yes is still words for Nous to read (nothing to run).
    const noAction = await service.answer(owner, (await ask("Which one first?", false)).id, { answer: "ANSWER", text: "ναι" });
    expect(noAction.status).toBe("ANSWERED");
    expect(executeAction).toHaveBeenCalledTimes(1);
    const notes = (await repository.listMessages(owner, 50)).filter((message) => message.kind === "DECISION").map((message) => message.content);
    expect(notes.find((text) => text.includes("Acme"))).toContain("approved (read from their words)");
    expect(notes.find((text) => text.includes("Gamma"))).toContain("The action was not run.");
    await service.idle(owner);
  });

  it("refuses a decision whose files Space cannot read, so the operator never approves a text the card cannot show (R10-15)", async () => {
    // 28/10 21:31 BKK: decision 65ad0767's "what it sends" read "is private to the agent that wrote it": Kate wrote the mail 0600.
    const root = await mkdtemp(join(tmpdir(), "nous-r10-15-"));
    try {
      await writeFile(join(root, "mail-ok.md"), "Dear Mr Filopoulos, ...");
      await writeFile(join(root, "mail-private.md"), "Dear Mr Filopoulos, ...");
      await chmod(join(root, "mail-private.md"), 0o000);
      const files = createNousFiles({ root, artifactRoot: root, rooms: async () => [], listArtifacts: async () => [], getArtifact: async () => { throw new Error("none"); } });
      const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:f", status: "OPEN", title: input.title }));
      const tools = createNousTools({ ask, files, rooms: async () => [{ id: "room:gates1", name: "Main" }], listPanes: async () => [] } as unknown as NousToolDeps);
      const ctx = { owner: "user:operator", turnId: "nous_turn:f1", callId: "toolu_f", traceId: "trace:f" };
      const send = (paths: string[]) => tools.execute("space_ask_operator", { category: "EXTERNAL", title: "Send the Filopoulos mail", body: "The mail below.", recommendation: "Yes. Πρόβλεψη: ναι (80%)",
        refs: { files: paths }, checked: ["The thread in Gmail: the client asked for the price list."] }, ctx);
      const refused = await send(["mail-ok.md", "mail-private.md"]);
      expect(refused).toMatchObject({ ok: false, display: "mail-private.md is not readable by Space",
        result: expect.stringContaining("mail-private.md: mail-private.md is private to the agent that wrote it") });
      expect(refused.result).toContain("Make each file readable (chmod 644 or 664");
      expect(ask).not.toHaveBeenCalled();
      await chmod(join(root, "mail-private.md"), 0o644);
      expect((await send(["mail-ok.md", "mail-private.md"])).ok).toBe(true);
      expect(ask).toHaveBeenCalledTimes(1);
    } finally {
      await chmod(join(root, "mail-private.md"), 0o644).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("asks with a binary Agent File named as what it is, and answers a binary path with the Agent Files call (R28-1)", async () => {
    // 31/10 20:03 UTC the signed GEMI PDF by path, 20:04 the same PDF as an Agent File, 1/11 11:12 a demo video as an Agent File: all
    // refused "is a binary file; only text is read".
    const root = await mkdtemp(join(tmpdir(), "nous-r28-1-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      await writeFile(join(root, "signed.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2]));
      await mkdir(join(root, "user-uploads", "room_gates1", "2026-11-01"), { recursive: true });
      await writeFile(join(root, "user-uploads", "room_gates1", "2026-11-01", "demo.mp4"), Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
      const video = { id: "artifact:demo0001", roomId: "room:gates1", kind: "EXPORT", mimeType: "video/mp4", byteSize: 8, deletedAt: null,
        storageUri: "space-artifact://user-uploads/room:gates1/2026-11-01/demo.mp4", metadata: { originalFilename: "demo.mp4" } };
      const files = createNousFiles({ root, artifactRoot: root, rooms: async () => [{ id: "room:gates1", name: "Main" }] as never, listArtifacts: async () => [],
        getArtifact: async (id: string) => { if (id !== video.id) throw new Error("none"); return video as never; } });
      const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:r28", status: "OPEN", title: input.title }));
      const tools = createNousTools({ ask, files, rooms: async () => [{ id: "room:gates1", name: "Main" }], listPanes: async () => [] } as unknown as NousToolDeps);
      const ctx = { owner: "user:operator", turnId: "nous_turn:r28", callId: "toolu_r28", traceId: "trace:r28" };
      const send = (paths: string[]) => tools.execute("space_ask_operator", { category: "EXTERNAL", title: "Post the demo video", body: "The video below.",
        recommendation: "Yes. Πρόβλεψη: ναι (80%)", refs: { files: paths }, checked: ["Agent Files: the 1-minute cut the operator asked for."] }, ctx);
      const byPath = await send(["signed.pdf"]);
      expect(byPath).toMatchObject({ ok: false, result: expect.stringContaining('space_agent_files_add {"path": "signed.pdf", "folder": "Documents"}') });
      expect(byPath.result).not.toContain("chmod");
      // 4/11 REVIEW: a folder's answer names its files.
      await mkdir(join(root, "drafts", "old"), { recursive: true });
      await writeFile(join(root, "drafts", "b.md"), "B"); await writeFile(join(root, "drafts", "a.md"), "A");
      await writeFile(join(root, "drafts", ".env"), "private");
      const folder = await send(["drafts"]);
      expect(folder).toMatchObject({ ok: false, result: "drafts: drafts is a folder; name its files one by one: drafts/a.md, drafts/b.md. Ask again with those files in refs.files. " });
      expect(ask).not.toHaveBeenCalled();
      expect((await send(["drafts/a.md", "drafts/b.md"])).ok).toBe(true);
      expect((await send(["artifact:demo0001"])).ok).toBe(true);
      expect(await files.decisionFiles("user:operator", ["artifact:demo0001"])).toEqual([{ ref: "artifact:demo0001", total: null, truncated: false, binary: true,
        text: "demo.mp4 (artifact:demo0001): a video/mp4 file of 8 bytes, not text: the operator opens it in the room's Media." }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("asks with PDF artifacts without text decoding or the text size limit, hashing their raw bytes (R65-2)", async () => {
    const root = await mkdtemp(join(tmpdir(), "nous-r65-2-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      const dir = join(root, "agent-files", "room_gates1", "pane_pdf", "session_pdf", "2026-11-04");
      await mkdir(dir, { recursive: true });
      const pdf = { id: "artifact:pdf00001", roomId: "room:gates1", kind: "EXPORT", mimeType: "application/pdf", byteSize: 0, deletedAt: null,
        storageUri: "space-artifact://agent-files/room:gates1/pane:pdf/session:pdf/2026-11-04/signed.pdf", metadata: { originalFilename: "signed.pdf" } };
      const files = createNousFiles({ root, artifactRoot: root, rooms: async () => [{ id: "room:gates1" }] as never, listArtifacts: async () => [],
        getArtifact: async () => pdf as never });
      const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:r65", status: "OPEN", title: input.title }));
      const tools = createNousTools({ ask, files } as unknown as NousToolDeps);
      for (const size of [9_000, 8 * 1024 * 1024 + 1]) {
        const bytes = Buffer.alloc(size, 0xff); // No NUL: decoding as UTF-8 would change the approved bytes.
        bytes.write("%PDF-1.7\n");
        pdf.byteSize = bytes.length;
        await writeFile(join(dir, "signed.pdf"), bytes);
        expect(await files.decisionFiles("user:operator", [pdf.id])).toEqual([expect.objectContaining({ binary: true, truncated: false, total: null,
          text: expect.stringContaining("opens it in Agent Files") })]);
        const result = await tools.execute("space_ask_operator", { category: "EXTERNAL", title: "Send the signed PDF", body: "The signed document.",
          recommendation: "Yes. Prediction: yes (80%)", refs: { files: [pdf.id] }, checked: ["Agent Files: the signed document is ready."] },
        { owner: "user:operator", turnId: "nous_turn:r65", callId: "toolu_r65", traceId: "trace:r65" });
        expect(result.ok, result.result).toBe(true);
        expect(ask.mock.calls.at(-1)?.[0]).toMatchObject({ refs: { fileHashes: [{ ref: pdf.id,
          sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }] } });
      }
      await chmod(join(dir, "signed.pdf"), 0o000);
      expect((await files.decisionFiles("user:operator", [pdf.id]))[0]?.error).toContain("private");
      await chmod(join(dir, "signed.pdf"), 0o644);
      pdf.roomId = "room:someoneelse";
      expect((await files.decisionFiles("user:operator", [pdf.id]))[0]?.error).toContain("No Agent Files or Media artifact");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("records each sent file's hash when asked and holds the operator's yes when a file changed since (R10-18)", async () => {
    // Operator rule d5ee2808 (lesson 20:04 BKK show-final-mail): an e-mail is approved as its exact rendered text.
    const root = await mkdtemp(join(tmpdir(), "nous-r10-18-"));
    try {
      await writeFile(join(root, "mail.md"), "Dear Maria, the feed is fixed.");
      const files = createNousFiles({ root, artifactRoot: root, rooms: async () => [], listArtifacts: async () => [], getArtifact: async () => { throw new Error("none"); } });
      const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:h18", status: "OPEN", title: input.title }));
      const tools = createNousTools({ ask, files, rooms: async () => [{ id: "room:gates1", name: "Main" }], listPanes: async () => [] } as unknown as NousToolDeps);
      await tools.execute("space_ask_operator", { category: "EXTERNAL", title: "Send the fix mail", body: "The mail.", recommendation: "Yes. Πρόβλεψη: ναι (80%)", checked: ["Gmail: Maria asked 27/10"],
        refs: { files: ["mail.md"], fileHashes: [{ ref: "mail.md", sha256: "0".repeat(64), size: 1 }] } }, { owner: "user:operator", turnId: "nous_turn:h", callId: "toolu_h", traceId: "trace:h" });
      const asked = (ask.mock.calls[0] as unknown as [{ refs: { fileHashes: Array<{ ref: string; sha256: string; size: number }> } }])[0].refs.fileHashes;
      expect(asked).toEqual([{ ref: "mail.md", sha256: createHash("sha256").update("Dear Maria, the feed is fixed.").digest("hex"), size: 30 }]);

      const executeAction = vi.fn(async () => "Sent to Kate in Cleo.");
      const repository = new InMemoryNousRepository();
      const service = createNousService({ repository, runner: async () => ({ text: "ok", isError: false }), world: async () => ({ text: "world", overview: {} }),
        settings: async () => ({ enabled: true, maxTurnsPerHour: 20 }), notifications: { raise: vi.fn(async () => null), resolve: vi.fn(async () => 0) }, executeAction,
        fileHashes: (owner: string, refs: string[]) => files.fileHashes(owner, refs) } as unknown as NousServiceDeps);
      const decision = await service.ask({ ownerUserId: "user:operator", category: "EXTERNAL", title: "Send the fix mail", body: "The mail.", options: [], recommendation: "Yes.",
        refs: { files: ["mail.md"], fileHashes: asked }, action: { type: "PANE_TEXT", mode: "PROMPT", roomId: "room:gates1", paneId: "pane:kate0001", text: "send mail.md" } });
      await writeFile(join(root, "mail.md"), "Dear Maria, the feed is fixed. PS: 20% off.");
      const now = createHash("sha256").update("Dear Maria, the feed is fixed. PS: 20% off.").digest("hex");
      await expect(service.answer("user:operator", decision.id, { answer: "APPROVE" }))
        .rejects.toThrow(`Held: mail.md changed since you were asked (was ${asked[0]!.sha256.slice(0, 8)}, now ${now.slice(0, 8)}). Nothing ran`);
      // Words decide like the buttons, and hold the same way.
      await expect(service.answer("user:operator", decision.id, { answer: "ANSWER", text: "ναι" })).rejects.toThrow("Held: mail.md changed");
      expect(executeAction).not.toHaveBeenCalled();
      expect((await repository.getDecision("user:operator", decision.id))!.status).toBe("OPEN");
      // The text the operator was shown again: the yes runs.
      await writeFile(join(root, "mail.md"), "Dear Maria, the feed is fixed.");
      expect(await service.answer("user:operator", decision.id, { answer: "APPROVE" })).toMatchObject({ status: "APPROVED", outcome: "Sent to Kate in Cleo." });
      await service.idle("user:operator");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses any ask while an open decision of the last hour asks the same thing: most of its title, or the same plan or mail thread (R12-1)", async () => {
    // 29/10 09:12-09:15 BKK: 2ddd8bb7 and d943e19e (example.invalid clearance start, and floor) asked 3 minutes apart by two slots; both reached Telegram.
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:new", status: "OPEN", title: input.title }));
    const minutes = (count: number) => new Date(Date.now() - count * 60_000).toISOString();
    const open = (id: string, title: string, createdAt: string, refs: Record<string, unknown> = {}) => ({ id, ownerUserId: "user:operator", category: "DIRECTION", title, body: "", options: [],
      recommendation: null, refs, action: null, status: "OPEN", answer: null, outcome: null, createdAt, answeredAt: null });
    const decisions = [open("nous_decision:2ddd8bb7", "Start the example.invalid clearance sale today", minutes(3)),
      open("nous_decision:plan0001", "Lab plan order", minutes(10), { planId: "clipboard:labplan00001" }),
      open("nous_decision:old00001", "Renew the Hetzner box", minutes(90)),
      open("nous_decision:880c1706", "Send the kits mail to the 133 shops", minutes(1), { files: ["/var/lib/spaceapp-user/agent-workspace/kits/mail.html"] })];
    const tools = createNousTools({ ask, decisions: async () => decisions, rooms: async () => [], listPanes: async () => [] } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:r1", callId: "toolu_r", traceId: "trace:r" };
    const question = (title: string, refs: Record<string, unknown> = {}) => tools.execute("space_ask_operator", { category: "DIRECTION", title, body: "Which?", recommendation: "A. Πρόβλεψη: ναι (80%)",
      options: ["A", "B"], refs, checked: ["The plan map: no answer there"] }, ctx);
    // R19-2: a gate (REFUSED, not FAILED) naming the exact next call; it named space_nous_withdraw, which does not exist.
    expect(await question("example.invalid clearance sale: start today and floor price")).toMatchObject({ ok: false, refused: true, display: "nous_decision:2ddd8bb7 already asks this",
      result: expect.stringContaining('is still open about the same thing: that card is the ask. Wait for its answer, or ask once with everything in one decision and "replaces": "nous_decision:2ddd8bb7"') });
    expect(await question("Which lab first?", { planId: "clipboard:labplan00001" })).toMatchObject({ ok: false, display: "nous_decision:plan0001 already asks this" });
    // R20-dup-2 (30/10: 880c1706 and 1c9db57f, the same files 2.5 s apart): the same file to approve is the same ask, whatever its title.
    expect(await question("Approve the shop mail text", { files: ["/var/lib/spaceapp-user/agent-workspace/kits/mail.html"] })).toMatchObject({ ok: false, display: "nous_decision:880c1706 already asks this" });
    expect(ask).not.toHaveBeenCalled();
    // Another subject, or the same subject asked over an hour ago: asked.
    expect((await question("Renew the Hetzner box")).ok).toBe(true);
    expect((await question("Pick the Upwork niche")).ok).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("refuses a copilot item an open or approved decision of the last day decides, and the same files approved within 10 minutes (R44-1)", async () => {
    // 2/11 07:00-08:15 and 14:58 UTC: 14 approved actions on Vibe Art posts 2-10 FAILED "This post is no longer waiting for a decision": each post was asked twice.
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:new", status: "OPEN", title: input.title }));
    const minutes = (count: number) => new Date(Date.now() - count * 60_000).toISOString();
    const earlier = (id: string, status: string, at: string, action: Record<string, unknown> | null, refs: Record<string, unknown> = {}) => ({ id, ownerUserId: "user:operator",
      category: "EXTERNAL", title: `Earlier ${id}`, body: "", options: [], recommendation: null, refs, action, status, answer: null,
      outcome: status === "APPROVED" ? "Approved and done." : null, createdAt: at, answeredAt: status === "OPEN" ? null : at });
    const post = (itemId: string) => ({ type: "COPILOT", copilot: "MARKETING", item: "REVIEW", itemId, paneId: "pane:kate0001", decision: "approve" });
    const kate = { id: "pane:kate0001", roomId: "room:cleo0001", paneName: "Kate", title: "Kate", mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false };
    const prompt = { type: "PANE_TEXT", mode: "PROMPT", roomId: "room:cleo0001", paneId: "pane:kate0001", text: "Publish the post in post3.md" };
    const decisions = [earlier("nous_decision:vibe0002", "APPROVED", minutes(5 * 60), post("mktpost:vibe00000002")),
      earlier("nous_decision:vibe0003", "OPEN", minutes(2 * 60), post("mktpost:vibe00000003")),
      earlier("nous_decision:vibe0004", "APPROVED", minutes(25 * 60), post("mktpost:vibe00000004")),
      earlier("nous_decision:vibe0005", "DECLINED", minutes(30), post("mktpost:vibe00000005")),
      earlier("nous_decision:file0001", "APPROVED", minutes(4), prompt, { files: ["/var/lib/spaceapp-user/agent-workspace/vibe/post3.md"] }),
      earlier("nous_decision:file0002", "APPROVED", minutes(20), prompt, { files: ["/var/lib/spaceapp-user/agent-workspace/vibe/post4.md"] })];
    const tools = createNousTools({ ask, decisions: async () => decisions, rooms: async () => [{ id: "room:cleo0001", name: "Cleo" }], listPanes: async () => [kate] } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:r44", callId: "toolu_r44", traceId: "trace:r44" };
    const question = (title: string, action: Record<string, unknown>, refs: Record<string, unknown> = {}) => tools.execute("space_ask_operator", { category: "EXTERNAL", title,
      body: "Publish it.", recommendation: "Yes. Πρόβλεψη: ναι (85%)", action, refs, checked: ["The Marketing rail: the post waits"] }, ctx);
    expect(await question("Vibe Art post 2 on X", post("mktpost:vibe00000002"))).toMatchObject({ ok: false, refused: true,
      display: "nous_decision:vibe0002 already decides mktpost:vibe00000002", result: expect.stringContaining("Approved and done.") });
    expect(await question("Vibe Art post 3 on X", post("mktpost:vibe00000003"))).toMatchObject({ ok: false, display: "nous_decision:vibe0003 already decides mktpost:vibe00000003" });
    expect(await question("Publish post three", prompt, { files: ["/var/lib/spaceapp-user/agent-workspace/vibe/post3.md"] }))
      .toMatchObject({ ok: false, refused: true, display: "nous_decision:file0001 already asks these files" });
    expect(ask).not.toHaveBeenCalled();
    // An approval over a day old, a declined one, or the same files approved over 10 minutes ago: asked.
    expect((await question("Vibe Art post 4 on X", post("mktpost:vibe00000004"))).ok).toBe(true);
    expect((await question("Vibe Art post 5 on X", post("mktpost:vibe00000005"))).ok).toBe(true);
    expect((await question("Publish post four", prompt, { files: ["/var/lib/spaceapp-user/agent-workspace/vibe/post4.md"] })).ok).toBe(true);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("asks the same files again once the yes that asked them was settled VOID (12/11 nous_decision:38180bbd, its schedule BLOCKED)", async () => {
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:new", status: "OPEN", title: input.title }));
    const at = new Date(Date.now() - 4 * 60_000).toISOString();
    const prompt = { type: "PANE_TEXT", mode: "PROMPT", roomId: "room:cleo0001", paneId: "pane:kate0001", text: "Send the reply in reply.md" };
    const kate = { id: "pane:kate0001", roomId: "room:cleo0001", paneName: "Kate", title: "Kate", mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false };
    const approved = (id: string, file: string, outcome: string) => ({ id, ownerUserId: "user:operator", category: "EXTERNAL", title: `Earlier ${id}`, body: "", options: [],
      recommendation: null, refs: { files: [file] }, action: prompt, status: "APPROVED", answer: null, outcome, createdAt: at, answeredAt: at });
    const decisions = [approved("nous_decision:void0001", "/var/lib/spaceapp-user/agent-workspace/mail/reply.md", "Void (marked by Nous): its control_schedule ended BLOCKED, nothing sent"),
      approved("nous_decision:done0001", "/var/lib/spaceapp-user/agent-workspace/mail/other.md", "Done (marked by Nous): msg-1 — sent by hand")];
    const tools = createNousTools({ ask, decisions: async () => decisions, rooms: async () => [{ id: "room:cleo0001", name: "Cleo" }], listPanes: async () => [kate] } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:void", callId: "toolu_void", traceId: "trace:void" };
    const question = (file: string) => tools.execute("space_ask_operator", { category: "EXTERNAL", title: `Send ${file}`, body: "Send it.", recommendation: "Yes. Πρόβλεψη: ναι (85%)",
      action: prompt, refs: { files: [`/var/lib/spaceapp-user/agent-workspace/mail/${file}`] }, checked: ["The mail thread: no reply yet"] }, ctx);
    expect((await question("reply.md")).ok).toBe(true);
    expect(await question("other.md")).toMatchObject({ ok: false, refused: true, display: "nous_decision:done0001 already asks these files" });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("asks a copilot item again once it was put up for review after the yes that decided it (4/11 mktpost:FXtekInmGgmV)", async () => {
    // 4/11 23:40/23:41 UTC: yeses with decision "revise"; the Marketing Copilot fixed both posts and requested review again at 23:42/23:43, and every new ask was held.
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:new", status: "OPEN", title: input.title }));
    const minutes = (count: number) => new Date(Date.now() - count * 60_000).toISOString();
    const post = (itemId: string, decision = "approve") => ({ type: "COPILOT", copilot: "MARKETING", item: "REVIEW", itemId, paneId: "pane:kate0001", decision });
    const earlier = (id: string, status: string, at: string, action: Record<string, unknown>) => ({ id, ownerUserId: "user:operator", category: "EXTERNAL", title: `Earlier ${id}`,
      body: "", options: [], recommendation: null, refs: {}, action, status, answer: null, outcome: status === "APPROVED" ? "Approved and done." : null, createdAt: at,
      answeredAt: status === "OPEN" ? null : at });
    const decisions = [earlier("nous_decision:revi0001", "APPROVED", minutes(12), post("mktpost:revised00001", "revise")),
      earlier("nous_decision:same0001", "APPROVED", minutes(3), post("mktpost:samereq00001")),
      earlier("nous_decision:open0001", "OPEN", minutes(12), post("mktpost:openask00001")),
      earlier("nous_decision:gone0001", "APPROVED", minutes(12), post("mktpost:nolonger0001", "revise"))];
    // The items the copilots wait on: each with the time it was last put up for review (the post's updatedAt).
    const items = [{ copilot: "MARKETING", kind: "REVIEW", id: "mktpost:revised00001", paneId: null, title: "Review the X post", detail: "", createdAt: minutes(10) },
      { copilot: "MARKETING", kind: "REVIEW", id: "mktpost:samereq00001", paneId: null, title: "Review the X post", detail: "", createdAt: minutes(5) },
      { copilot: "MARKETING", kind: "REVIEW", id: "mktpost:openask00001", paneId: null, title: "Review the X post", detail: "", createdAt: minutes(5) }];
    const tools = createNousTools({ ask, decisions: async () => decisions, copilots: { items: async () => items }, rooms: async () => [], listPanes: async () => [] } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:rereview", callId: "toolu_rereview", traceId: "trace:rereview" };
    const question = (itemId: string) => tools.execute("space_ask_operator", { category: "EXTERNAL", title: `Publish ${itemId}`, body: "Publish it.",
      recommendation: "Yes. Πρόβλεψη: ναι (85%)", action: post(itemId), checked: ["The Marketing rail: the post waits"] }, ctx);
    // Revised, then requested again after that yes: a new decision.
    expect((await question("mktpost:revised00001")).ok).toBe(true);
    // A yes given since the item's latest request, or an open ask, still decides it.
    expect(await question("mktpost:samereq00001")).toMatchObject({ ok: false, refused: true, display: "nous_decision:same0001 already decides mktpost:samereq00001" });
    expect(await question("mktpost:openask00001")).toMatchObject({ ok: false, refused: true, display: "nous_decision:open0001 already decides mktpost:openask00001" });
    // An item no longer waiting has no review request to compare: its yes still decides it.
    expect(await question("mktpost:nolonger0001")).toMatchObject({ ok: false, refused: true, display: "nous_decision:gone0001 already decides mktpost:nolonger0001" });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("R56: a copilot item whose yes failed is asked once more; a second failed yes, or an item that no longer waits, still holds", async () => {
    // 3/11 17:50-20:09 UTC: decision 56b40039 (X reply mktpost:pxnVPA94GcS6) was approved but its action never ran (the API restarted); every
    // re-ask was held "already decides … its outcome: none recorded", and Kate had to file a new review for the same text.
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:new", status: "OPEN", title: input.title }));
    const at = new Date(Date.now() - 60 * 60_000).toISOString();
    const post = (itemId: string) => ({ type: "COPILOT", copilot: "MARKETING", item: "REVIEW", itemId, paneId: "pane:kate0001", decision: "approve" });
    const yes = (id: string, itemId: string, outcome: string | null) => ({ id, ownerUserId: "user:operator", category: "EXTERNAL", title: `Earlier ${id}`, body: "",
      options: [], recommendation: null, refs: {}, action: post(itemId), status: "APPROVED", answer: null, outcome, createdAt: at, answeredAt: at });
    const decisions = [yes("nous_decision:once0001", "mktpost:failed000001", "Not run: the API restarted before the approved action finished."),
      yes("nous_decision:twic0001", "mktpost:failed000002", "Failed: The marketing copilot is busy."),
      yes("nous_decision:twic0002", "mktpost:failed000002", "Failed: The marketing copilot is busy."),
      yes("nous_decision:gone0001", "mktpost:failed000003", "Failed: This post is no longer waiting for a decision."),
      yes("nous_decision:once0002", "mktpost:failed000004", "Failed: The marketing copilot is busy."),
      yes("nous_decision:runs0001", "mktpost:failed000004", null)];
    const tools = createNousTools({ ask, decisions: async () => decisions, rooms: async () => [{ id: "room:cleo0001", name: "Cleo" }], listPanes: async () => [] } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:r56", callId: "toolu_r56", traceId: "trace:r56" };
    const question = (itemId: string) => tools.execute("space_ask_operator", { category: "EXTERNAL", title: `Reply ${itemId}`, body: "Publish it.",
      recommendation: "Yes. Πρόβλεψη: ναι (85%)", action: post(itemId), checked: ["The Marketing rail: the post waits"] }, ctx);
    expect((await question("mktpost:failed000001")).ok).toBe(true);
    expect(await question("mktpost:failed000002")).toMatchObject({ ok: false, refused: true, display: "mktpost:failed000002 failed twice",
      result: expect.stringContaining("The marketing copilot is busy.") });
    expect(await question("mktpost:failed000003")).toMatchObject({ ok: false, refused: true, display: "nous_decision:gone0001 already decides mktpost:failed000003" });
    // No outcome yet: the approved action is still running (a restart marks it "Not run", see the resume case).
    expect(await question("mktpost:failed000004")).toMatchObject({ ok: false, refused: true, display: "nous_decision:runs0001 already decides mktpost:failed000004" });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("asks an item again once when its approved action FAILED, and holds after a second failure (4/11 REVIEW)", async () => {
    // 56b40039 (X reply mktpost:pxnVPA94GcS6) ACTION FAILED, and every re-ask was refused "already decides".
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:new", status: "OPEN", title: input.title }));
    const failed = (id: string, itemId: string, outcome: string | null) => ({ id, ownerUserId: "user:operator", category: "EXTERNAL", title: `Earlier ${id}`, body: "",
      options: [], recommendation: null, refs: {}, status: "APPROVED", answer: "Approved", outcome, createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      answeredAt: new Date(Date.now() - 3_600_000).toISOString(), action: { type: "COPILOT", copilot: "MARKETING", item: "REVIEW", itemId, paneId: "pane:kate0001", decision: "approve" } });
    const decisions = [failed("nous_decision:56b40039", "mktpost:pxnVPA94GcS6", "Failed: the X composer did not open"),
      failed("nous_decision:85a2e2a2", "mktpost:hetzner00003", "Failed: Reddit refused the post"),
      failed("nous_decision:85a2e2a3", "mktpost:hetzner00003", "Not run: the API restarted before the approved action finished.")];
    const tools = createNousTools({ ask, decisions: async () => decisions } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:r55", callId: "toolu_r55", traceId: "trace:r55" };
    const question = (title: string, itemId: string) => tools.execute("space_ask_operator", { category: "EXTERNAL", title, body: "Publish it.",
      recommendation: "Yes. Πρόβλεψη: ναι (85%)", action: { type: "COPILOT", copilot: "MARKETING", item: "REVIEW", itemId, paneId: "pane:kate0001", decision: "approve" },
      refs: {}, checked: ["The Marketing rail: the reply waits"] }, ctx);
    expect((await question("X reply again", "mktpost:pxnVPA94GcS6")).ok).toBe(true);
    expect(await question("Hetzner update again", "mktpost:hetzner00003")).toMatchObject({ ok: false, refused: true, display: "mktpost:hetzner00003 failed twice",
      result: expect.stringContaining("Reddit refused the post") });
    expect((await question("Hetzner update again", "mktpost:hetzner00003")).result).toContain("Not run: the API restarted");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("asks a corrected decision with replaces: no twin hold for that one, and the old one closes as replaced (R37)", async () => {
    // 7 days to 2/11: 4 of the 20 stale asks were Nous's own corrected re-asks (29/10 17:04 held "f308fe72 already asks this", withdrawn, asked again).
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:new00001", status: "OPEN", title: input.title }));
    const withdraw = vi.fn(async () => true);
    const open = (id: string, title: string, status = "OPEN") => ({ id, ownerUserId: "user:operator", category: "EXTERNAL", title, body: "", options: [],
      recommendation: null, refs: {}, action: null, status, answer: null, outcome: null, createdAt: new Date(Date.now() - 60_000).toISOString(), answeredAt: null });
    const decisions = [open("nous_decision:f308fe72", "Send the free-server applications"), open("nous_decision:closed01", "Send the AWS mail", "APPROVED")];
    const tools = createNousTools({ ask, withdraw, decisions: async () => decisions, rooms: async () => [], listPanes: async () => [] } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:r37", callId: "toolu_r37", traceId: "trace:r37" };
    const question = (replaces?: string) => tools.execute("space_ask_operator", { category: "EXTERNAL", title: "Send the free-server applications, all 47 texts",
      body: "All in one.", recommendation: "Yes. Πρόβλεψη: ναι (85%)", checked: ["The report: 47 texts ready"], ...(replaces ? { replaces } : {}) }, ctx);
    expect(await question()).toMatchObject({ ok: false, refused: true, display: "nous_decision:f308fe72 already asks this" });
    // Only an open decision can be replaced: nothing is asked otherwise.
    expect(await question("nous_decision:closed01")).toMatchObject({ ok: false, display: "nous_decision:closed01 is not open",
      // Goal 401b115b (9/11): the refusal names the open ones that can be replaced.
      result: expect.stringContaining('Your open decisions: nous_decision:f308fe72 ("Send the free-server applications") (space_nous_decisions status "OPEN" lists them)') });
    expect(ask).not.toHaveBeenCalled();
    const asked = await question("nous_decision:f308fe72");
    expect(asked).toMatchObject({ ok: true, result: expect.stringContaining("nous_decision:f308fe72 closed as replaced by it.") });
    expect(withdraw).toHaveBeenCalledWith("user:operator", "nous_decision:f308fe72", "Send the free-server applications, all 47 texts", false, "nous_decision:new00001");
    expect(ask).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ replaces: "nous_decision:f308fe72" }));
    // Nous 13/11: an ask that resolved to the decision it replaces never cancels itself ("Replaced by" its own id).
    withdraw.mockClear();
    ask.mockResolvedValueOnce({ id: "nous_decision:f308fe72", status: "OPEN", title: "Send the free-server applications, all 47 texts",
      body: 'Not covered by "May send to third parties": copilot memory mailmem:SLvZ9IZgCRc4 requires that you read this review ("…").\n\nAll in one.' } as never);
    const same = await question("nous_decision:f308fe72");
    // and an ask maySend did not run tells Nous why, so it is not sent another way.
    expect(same).toMatchObject({ ok: true, result: expect.stringContaining('Asked (nous_decision:f308fe72). The operator answers in the Nous dock; you hear back in a later turn. '
      + 'Do not repeat the question. Not covered by "May send to third parties": copilot memory mailmem:SLvZ9IZgCRc4 requires that you read this review ("…"). '
      + "It went to the operator; do not run it another way.") });
    expect(same.result).not.toContain("closed as replaced");
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("asks only with a prediction: the field, written in one form and stored, or the recommendation's line; the ledger scores the stored one (R12-11)", async () => {
    // 29/10: 698c318f and e755da44 were asked without «Πρόβλεψη»: 5 of the day's 17 decisions could not be scored.
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:new", status: "OPEN", title: input.title }));
    const tools = createNousTools({ ask, rooms: async () => [], listPanes: async () => [] } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:p1", callId: "toolu_p", traceId: "trace:p" };
    const base = { category: "DIRECTION", title: "Which plan first?", body: "Two plans wait.", options: ["(α) Lab", "(β) Shop"], checked: ["The plan map: both wait on Nous"] };
    expect(await tools.execute("space_ask_operator", { ...base, recommendation: "The lab." }, ctx)).toMatchObject({ ok: false, display: "Asked without a prediction",
      result: expect.stringContaining("Every decision carries a prediction (goal 7365014c criterion 3)") });
    expect(await tools.execute("space_ask_operator", { ...base, recommendation: "The lab.", prediction: { answer: "(γ) Both", confidence: 70 } }, ctx))
      .toMatchObject({ ok: false, display: "The prediction names no answer" });
    expect(ask).not.toHaveBeenCalled();
    // R67 (3/11 16:26 "approve" refused): an approve/decline word reads as yes/no.
    expect(await tools.execute("space_ask_operator", { ...base, title: "Approve?", recommendation: "The lab.", prediction: { answer: " Approve ", confidence: 70 } }, ctx))
      .toMatchObject({ ok: true });
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ recommendation: "The lab.\nPrediction: yes (70 %)" }), expect.anything());
    ask.mockClear();
    // The field: one line in one form at the end (an older line replaced), stored on the decision.
    await tools.execute("space_ask_operator", { ...base, recommendation: "The lab. Prediction: yes", prediction: { answer: "(α) lab", confidence: 75 } }, ctx);
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ recommendation: "The lab.\nPrediction: (α) Lab (75 %)", refs: { prediction: { answer: "(α) Lab", confidence: 75 } } }), expect.anything());
    // F-lang (1.2.0 lab 2/11): a Greek card keeps the Greek label.
    await tools.execute("space_ask_operator", { ...base, recommendation: "Το lab.", prediction: { answer: "(α) lab", confidence: 75 } }, ctx);
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ recommendation: "Το lab.\nΠρόβλεψη: (α) Lab (75 %)" }), expect.anything());
    // The line alone is read the way the scorer reads it.
    await tools.execute("space_ask_operator", { ...base, title: "Start the lab?", options: [], recommendation: "Start it. Πρόβλεψη: ναι (90%)" }, ctx);
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ refs: { prediction: { answer: "yes", confidence: 90 } } }), expect.anything());
    // 13/11 review: "prediction: expected object, received string" (repeating since 11/11): the line as a string is the object.
    await tools.execute("space_ask_operator", { ...base, title: "Start the lab?", options: [], recommendation: "Start it.", prediction: "Πρόβλεψη: ναι (90%)" }, ctx);
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ refs: { prediction: { answer: "yes", confidence: 90 } } }), expect.anything());
    await tools.execute("space_ask_operator", { ...base, recommendation: "The lab.", prediction: "(β) Shop 65%" }, ctx);
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ refs: { prediction: { answer: "(β) Shop", confidence: 65 } } }), expect.anything());

    const repository = new InMemoryNousRepository();
    const service = createNousService({ repository, runner: async () => ({ text: "ok", isError: false }), world: async () => ({ text: "world", overview: {} }),
      settings: async () => ({ enabled: false, maxTurnsPerHour: 20 }), notifications: { raise: vi.fn(async () => null), resolve: vi.fn(async () => 0) }, executeAction: vi.fn() } as unknown as NousServiceDeps);
    const decision = await service.ask({ ownerUserId: "user:operator", category: "DIRECTION", title: "Start the lab?", body: "Πρόβλεψη: ναι (60%) in an old note.", options: [],
      recommendation: "Wait.", refs: { prediction: { answer: "no", confidence: 80 } }, action: null }, { checked: ["The plan map"] });
    await service.answer("user:operator", decision.id, { answer: "APPROVE" });
    expect((await repository.listLedger("user:operator", "2000-01-01T00:00:00.000Z"))[0]).toMatchObject({ predicted: "DECLINE", match: false });
    await service.idle("user:operator");
  });

  it("goal 7365014c step 2 (6/11): stores a predicted written answer when there are no options, and holds a send with no action while maySend is on", async () => {
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:new", status: "OPEN", title: input.title }));
    let covers = true;
    const tools = createNousTools({ ask, rooms: async () => [], listPanes: async () => [], coversApproval: async () => covers } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:w1", callId: "toolu_w", traceId: "trace:w" };
    const base = { category: "DIRECTION", title: "When do the pages go out?", body: "Five pages wait.", recommendation: "All this week.", checked: ["The plan map: five pages wait"] };
    expect(await tools.execute("space_ask_operator", { ...base, prediction: { answer: "yes, but all within one week", confidence: 60 } }, ctx)).toMatchObject({ ok: true });
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ recommendation: "All this week.\nPrediction: «yes, but all within one week» (60 %)",
      refs: { prediction: { answer: "yes, but all within one week", confidence: 60, written: true } } }), expect.anything());
    // With options a free text still names no answer.
    expect(await tools.execute("space_ask_operator", { ...base, options: ["Now", "Later"], prediction: { answer: "yes, but sooner", confidence: 60 } }, ctx))
      .toMatchObject({ ok: false, display: "The prediction names no answer" });
    ask.mockClear();
    // 12d23d83, f203a999, 78c1fa7b: a send with a kind and no action reached the operator with maySend ON.
    const send = { category: "EXTERNAL", title: "Send the reply to Anna", body: "The reply.", recommendation: "Yes. Prediction: yes (90%)", checked: ["Gmail: Anna asked"], refs: { sendKind: "mail-reply" } };
    expect(await tools.execute("space_ask_operator", send, ctx)).toMatchObject({ ok: false, refused: true, display: "maySend covers this send" });
    expect(ask).not.toHaveBeenCalled();
    covers = false;
    expect(await tools.execute("space_ask_operator", send, ctx)).toMatchObject({ ok: true });
  });

  it("leaves a thread to the Mail Copilot's open review card for its first hour (R12-2)", async () => {
    // Operator rule 18374163; 29/10 09:12 37073b9f asked about a thread whose Mail review card was already waiting in Needs you.
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:new", status: "OPEN", title: input.title }));
    const minutes = (count: number) => new Date(Date.now() - count * 60_000).toISOString();
    const card = (id: string, threadId: string, createdAt: string, payload: Record<string, unknown> = {}) => ({ id, source: "MAIL_COPILOT", kind: "REVIEW_REQUESTED", title: "Reply to Maria", createdAt,
      link: { target: `thread:ops@example.invalid:${threadId}` }, payload });
    const list = vi.fn(async () => [card("notification:fresh001", "t-fresh", minutes(20)), card("notification:old00001", "t-old", minutes(70)),
      // R42-1: both allowance and old hour holds are Nous's while covered; the stored hold alone does not bypass R12-2.
      card("notification:held0001", "t-held", minutes(5), { heldForNous: { until: minutes(-55), allowance: "maySend" } }),
      card("notification:hour0001", "t-hour", minutes(5), { heldForNous: { until: minutes(-55) } })]);
    let covered = false;
    const tools = createNousTools({ ask, notifications: { list }, rooms: async () => [], listPanes: async () => [], coversApproval: async () => covered } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:m1", callId: "toolu_m", traceId: "trace:m" };
    const send = (threadId: string) => tools.execute("space_ask_operator", { category: "EXTERNAL", title: "Send the reply to Maria", body: "The reply.", recommendation: "Send. Πρόβλεψη: ναι (80%)",
      options: ["Send", "Hold"], refs: { mailThread: { account: "ops@example.invalid", threadId } }, checked: ["The thread: Maria asked twice"] }, ctx);
    // W45 step 2: a hold (REFUSED, never a reliability mistake), worded as final until the card's hour ends.
    expect(await send("t-fresh")).toMatchObject({ ok: false, refused: true, display: "The rail card notification:fresh001 is the ask",
      result: expect.stringMatching(/Nothing asked\. Do not call it again before \d\d:\d\d UTC; a reminder decision is allowed once the card has waited an hour\./) });
    expect(ask).not.toHaveBeenCalled();
    // The card waited over an hour, or no card names the thread: asked.
    expect((await send("t-old")).ok).toBe(true);
    expect((await send("t-other")).ok).toBe(true);
    expect(await send("t-held")).toMatchObject({ ok: false, display: "The rail card notification:held0001 is the ask" });
    expect(await send("t-hour")).toMatchObject({ ok: false, display: "The rail card notification:hour0001 is the ask" });
    expect(ask).toHaveBeenCalledTimes(2);
    // 2/11 15:39 UTC mailrev:Ad2HiP-_y5SI: with "May send" on the card is a covered approval held for Nous ("Nous reviewing"), no ask of the operator's:
    // Nous's decision on it, the exact call its inbox line names, is asked and "May send" runs it at once. With the allowance off the card stays the ask.
    const decide = () => tools.execute("space_ask_operator", { category: "EXTERNAL", title: "Approve the reply to Maria", body: "The reply.", recommendation: "Approve. Πρόβλεψη: ναι (90%)",
      options: ["Approve", "Hold"], checked: ["The thread: Maria asked twice"],
      action: { type: "COPILOT", copilot: "MAIL", item: "REVIEW", itemId: "mailrev:fresh001", paneId: "pane:mail0001", decision: "approve" },
      refs: { sendKind: "mail-review", mailThread: { account: "ops@example.invalid", threadId: "t-fresh" } } }, ctx);
    expect(await decide()).toMatchObject({ ok: false, display: "The rail card notification:fresh001 is the ask" });
    expect(ask).toHaveBeenCalledTimes(2);
    covered = true;
    expect(await decide()).toMatchObject({ ok: true });
    expect(ask).toHaveBeenCalledTimes(3);
    expect(ask.mock.calls[2]![0]).toMatchObject({ action: { type: "COPILOT", copilot: "MAIL", item: "REVIEW", itemId: "mailrev:fresh001", decision: "approve" },
      refs: { sendKind: "mail-review", mailThread: { account: "ops@example.invalid", threadId: "t-fresh" } } });
    expect((await send("t-held")).ok).toBe(true);
    expect((await send("t-hour")).ok).toBe(true);
    expect(ask).toHaveBeenCalledTimes(5);
  });

  it("leaves a held Security or Monitoring change to its rail review card for the card's first hour (R15-3)", async () => {
    // 29/10 09:36 BKK: dc2fe0e2 was asked 2 minutes after Monitoring REVIEW card 1a88f088 about the same held change (the public-host backup watchdog).
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:new", status: "OPEN", title: input.title }));
    const minutes = (count: number) => new Date(Date.now() - count * 60_000).toISOString();
    const card = (id: string, source: string, reviewId: string, createdAt: string) => ({ id, source, kind: `${source.split("_")[0]}_REVIEW`, title: "Approve restart on pve?", createdAt,
      status: "READ", link: { target: `review:${reviewId}` } });
    const paneNeeds = vi.fn(async () => [card("notification:mon00001", "MONITORING_COPILOT", "monev:fresh", minutes(2)), card("notification:sec00001", "SECURITY_COPILOT", "secev:fresh", minutes(30)),
      card("notification:old00001", "MONITORING_COPILOT", "monev:old", minutes(70))]);
    const tools = createNousTools({ ask, paneNeeds, rooms: async () => [], listPanes: async () => [] } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:r1", callId: "toolu_r", traceId: "trace:r" };
    const decide = (copilot: string, itemId: string) => tools.execute("space_ask_operator", { category: "DIRECTION", title: `Approve the held change ${itemId}`, body: "The change.",
      recommendation: "Approve. Πρόβλεψη: ναι (80%)", options: ["Approve", "Decline"], checked: ["The rail: the change waits"],
      action: { type: "COPILOT", copilot, item: "REVIEW", itemId, paneId: "pane:mon00001", decision: "approve" } }, ctx);
    expect(await decide("MONITORING", "monev:fresh")).toMatchObject({ ok: false, refused: true, display: "The rail card notification:mon00001 is the ask",
      result: expect.stringContaining("Monitoring Copilot's review card notification:mon00001") });
    expect(await decide("SECURITY", "secev:fresh")).toMatchObject({ ok: false, display: "The rail card notification:sec00001 is the ask" });
    expect(ask).not.toHaveBeenCalled();
    // The card waited over an hour (one reminder), or no card names that review: asked.
    expect((await decide("MONITORING", "monev:old")).ok).toBe(true);
    expect((await decide("SECURITY", "secev:other")).ok).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("never asks the operator about a held own-host change the copilot may run itself, unless they asked to be asked (R16-7)", async () => {
    // Operator rule f360b58c 29/10 16:07 BKK: 300c4990 / 9da7575b asked about Node KEV upgrades the Security Copilot had held.
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:new", status: "OPEN", title: input.title }));
    const item = (id: string, title: string) => ({ copilot: "SECURITY", kind: "REVIEW", id, paneId: "pane:sec00001", title, detail: "" });
    const items = vi.fn(async () => [item("secevt:upgrade01", "PACKAGE_UPGRADE on public-host: Node 22.23.4 (KEV)"), item("secevt:reboot001", "HOST_REBOOT on public-host: kernel 6.12.114")]);
    let askOwnHosts = false;
    const tools = createNousTools({ ask, copilots: { items }, askOwnHosts: async () => askOwnHosts, rooms: async () => [], listPanes: async () => [] } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:o1", callId: "toolu_o", traceId: "trace:o" };
    const decide = (itemId: string) => tools.execute("space_ask_operator", { category: "DIRECTION", title: `Approve held change ${itemId}`, body: "The change.",
      recommendation: "Approve. Πρόβλεψη: ναι (90%)", options: ["Approve", "Decline"], checked: ["The rail: the change waits"],
      action: { type: "COPILOT", copilot: "SECURITY", item: "REVIEW", itemId, paneId: "pane:sec00001", decision: "approve" } }, ctx);
    expect(await decide("secevt:upgrade01")).toMatchObject({ ok: false, display: "Not asked: the operator's rule runs this change",
      result: expect.stringContaining("Operator rule f360b58c") });
    expect(ask).not.toHaveBeenCalled();
    // A reboot still asks; with "Ask me before changes on my own hosts" on, so does the upgrade.
    expect((await decide("secevt:reboot001")).ok).toBe(true);
    askOwnHosts = true;
    expect((await decide("secevt:upgrade01")).ok).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("refuses a RELEASE ask about a candidate the operator already approved: its publication steps run on that yes (R13-11)", async () => {
    // 29/10: e755da44 approved c8 25bcec3e77 (dated older here, past R11-4's 24 hours), then 3d986119 re-ran its failed test job and 995841e4 approved the GitHub "npm" environment gate.
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:rel0001", status: "OPEN", title: input.title }));
    const emma = { id: "pane:emma0001", roomId: "room:gates1", paneName: "Emma", title: "Emma", mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false };
    let trains = [{ product: "run-spaceapp", version: "1.1.10", status: "OPEN", sourceSha: "25bcec3e77aa11", approvedSha: "25bcec3e77aa11", captain: { paneId: "pane:emma0001", name: "Emma" } }];
    const approved = { id: "nous_decision:e755da44", ownerUserId: "user:operator", category: "RELEASE", title: "Approve c8", body: "", options: [], recommendation: null, refs: {},
      action: { type: "RELEASE_APPROVE", product: "run-spaceapp" }, status: "APPROVED", answer: "approve", outcome: "Approved.", createdAt: "2026-10-27T03:20:00.000Z", answeredAt: "2026-10-27T03:26:00.000Z" };
    const tools = createNousTools({ ask, rooms: async () => [{ id: "room:gates1", name: "Main" }], listPanes: async () => [emma], decisions: async () => [approved], liveTrains: async () => trains } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:c1", callId: "toolu_c", traceId: "trace:c" };
    const release = (action: Record<string, unknown>, title = "Release step") => tools.execute("space_ask_operator", { category: "RELEASE", title, body: "Next step.",
      recommendation: "Yes. Πρόβλεψη: ναι (90%)", action, checked: ["The release train: candidate recorded"] }, ctx);
    const pane = (text: string) => ({ type: "PANE_TEXT", mode: "PROMPT", roomId: "room:gates1", paneId: "pane:emma0001", text });
    expect(await release({ type: "RELEASE_APPROVE", product: "run-spaceapp" })).toMatchObject({ ok: false,
      result: expect.stringContaining("run-spaceapp 1.1.10: the operator approved this version (decision nous_decision:e755da44, 2026-10-27 03:26 UTC), candidate 25bcec3e77: its publication steps") });
    expect((await release(pane("Re-run the failed test job of commit 25bcec3e77 (gh run rerun 1234 --failed)."), "Re-run tests")).ok).toBe(false);
    expect((await release(pane("Approve the GitHub npm environment gate for run-spaceapp 1.1.10."), "Approve the gate")).ok).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    // A hotfix approve is unchanged; a new commit is a new candidate.
    expect((await release(pane("space-queue approve q-20261029-070000-abcd"), "Approve the hotfix")).ok).toBe(true);
    // R13-15b: a newer candidate of the approved version goes on to the server, which approves it on the earlier yes (service case below);
    // a step naming it is refused like the first candidate's; a different version is a new ask.
    trains = [{ ...trains[0]!, sourceSha: "9f1e2d3c4b5a69" }];
    expect((await release({ type: "RELEASE_APPROVE", product: "run-spaceapp" }, "Approve c9")).ok).toBe(true);
    expect((await release(pane("Re-run the workflow of 9f1e2d3c4b."), "Re-run c9")).ok).toBe(false);
    trains = [{ ...trains[0]!, version: "1.1.11", approvedSha: null as never }];
    expect((await release({ type: "RELEASE_APPROVE", product: "run-spaceapp" }, "Approve 1.1.11")).ok).toBe(true);
  });

  it("approves a newer candidate of a version the operator approved on that yes, with no card (R13-15b, operator 29/10 14:14 BKK)", async () => {
    // «Γενικά δεν θα με ρωτάς τίποτα για τις εκδόσεις από τη στιγμή που σου έδωσα ένα αρχικό οκ να προχωρήσεις!!!!»
    const repository = new InMemoryNousRepository();
    const raise = vi.fn(async () => null);
    const approve = vi.fn(async () => {});
    const audit = vi.fn(async () => {});
    let train = { product: "run-spaceapp", version: "1.1.9", status: "OPEN", sourceSha: "c9c9c9c9c9c9", approvedSha: "c8c8c8c8c8c8", lab: null };
    const service = createNousService({ repository, runner: async () => ({ text: "ok", isError: false }), world: async () => ({ text: "world", overview: {} }),
      settings: async () => ({ enabled: false, maxTurnsPerHour: 20 }), notifications: { raise, resolve: vi.fn(async () => 0) }, executeAction: vi.fn(),
      mayPublish: { facts: async () => ({ train, securityOpen: null, unmerged: null }), approve, audit } } as unknown as NousServiceDeps);
    const first = await repository.createDecision({ ownerUserId: "user:operator", category: "RELEASE", title: "Approve 1.1.9 c8", body: "", options: [], recommendation: null, refs: {},
      action: { type: "RELEASE_APPROVE", product: "run-spaceapp" } });
    await repository.answerDecision("user:operator", first.id, { status: "APPROVED", answer: null });
    const ask = () => service.ask({ ownerUserId: "user:operator", category: "RELEASE", title: "Approve 1.1.9 c9", body: "The fix for the failed test.", options: [],
      recommendation: "Yes. Πρόβλεψη: ναι (95%)", refs: {}, action: { type: "RELEASE_APPROVE", product: "run-spaceapp" } });
    const decision = await ask();
    expect(decision).toMatchObject({ status: "APPROVED", answer: expect.stringMatching(new RegExp(`^Approved by your release OK ${first.id} \\(`)),
      outcome: "Approved the run-spaceapp 1.1.9 train at c9c9c9c9c9 on your release OK of this version." });
    expect(decision.body).toMatch(/^Approved by your release OK /);
    expect(approve).toHaveBeenCalledWith("run-spaceapp", "c9c9c9c9c9c9");
    expect(audit).toHaveBeenCalledWith("user:operator", decision.id, "run-spaceapp", "c9c9c9c9c9c9", first.id);
    expect(raise).not.toHaveBeenCalled();
    expect((await repository.listLedger("user:operator", "2000-01-01T00:00:00.000Z"))[0]).toMatchObject({ source: "ALLOWANCE", kind: "release-ok:run-spaceapp", match: null });
    // A new version (no approval on its train yet) is one ask: a card.
    train = { ...train, version: "1.1.10", approvedSha: null as never };
    expect((await ask()).status).toBe("OPEN");
    expect(raise).toHaveBeenCalledTimes(1);
    await service.idle("user:operator");
  });

  it("refuses a RELEASE or DESTRUCTIVE ask whose exact action the operator approved in the last 24 hours, naming that decision (R11-4)", async () => {
    // 28/10: 6979d130 and f678a9b9 re-asked the Qwen hotfix 4f82fa69 the operator had approved; 3c8c9163 re-asked the 1.1.9 candidate.
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:dup", status: "OPEN", title: input.title }));
    const emma = { id: "pane:emma0001", roomId: "room:gates1", paneName: "Emma", title: "Emma", mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false };
    const hour = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
    const earlier = (id: string, action: Record<string, unknown>, answeredAt: string, status = "APPROVED") => ({ id, ownerUserId: "user:operator", category: "RELEASE", title: "Approve the Qwen hotfix",
      body: "", options: [], recommendation: null, refs: {}, action, status, answer: "approve", outcome: "Sent to Emma in Main.", createdAt: answeredAt, answeredAt });
    const approved = { type: "PANE_TEXT", mode: "PROMPT", roomId: "room:gates1", paneId: "pane:emma0001", text: "space-queue approve q-20261028-085017-5c93" };
    const decisions = [earlier("nous_decision:4f82fa69", approved, hour(3)), earlier("nous_decision:old00001", { ...approved, text: "space-queue promote" }, hour(30)),
      earlier("nous_decision:declined", { type: "RELEASE_APPROVE", product: "run-spaceapp" }, hour(1), "DECLINED")];
    const stable = { available: true, active: [{ id: "q-20261028-085017-5c93", status: "AWAITING_APPROVAL" }], recent: [] };
    const tools = createNousTools({ ask, rooms: async () => [{ id: "room:gates1", name: "Main" }], listPanes: async () => [emma], decisions: async () => decisions,
      queues: async () => [{ name: "stable", report: stable }] } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:d1", callId: "toolu_d", traceId: "trace:d" };
    const release = (action: Record<string, unknown>, category = "RELEASE") => tools.execute("space_ask_operator", { category, title: "Approve it", body: "Again.", recommendation: "Yes. Πρόβλεψη: ναι (80%)", action, checked: ["The decisions: one approved"] }, ctx);
    expect(await release(approved)).toMatchObject({ ok: false, display: "nous_decision:4f82fa69 already approved this",
      result: expect.stringContaining("that yes is the operator's request; run it from there (its outcome: Sent to Emma in Main.). Nothing asked.") });
    expect(ask).not.toHaveBeenCalled();
    // Older than 24 hours, declined, or another action: asked as usual.
    expect((await release({ ...approved, text: "space-queue promote" })).ok).toBe(true);
    expect((await release({ type: "RELEASE_APPROVE", product: "run-spaceapp" })).ok).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("lets a newer candidate of a train approved in the last 24 hours past R11-4, on to R13-15b (10/11, run-spaceapp 1.2.0 64c3e719 -> 1a2d8e72)", async () => {
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:newer", status: "APPROVED", title: input.title }));
    const yes = { id: "nous_decision:9f8a7fba", ownerUserId: "user:operator", category: "RELEASE", title: "Approve 1.2.0", body: "", options: [], recommendation: null, refs: {},
      action: { type: "RELEASE_APPROVE", product: "run-spaceapp" }, status: "APPROVED", answer: "approve", outcome: "Approved.",
      createdAt: new Date(Date.now() - 3_600_000).toISOString(), answeredAt: new Date(Date.now() - 3_600_000).toISOString() };
    let trains = [{ product: "run-spaceapp", version: "1.2.0", status: "OPEN", sourceSha: "1a2d8e72aa11", approvedSha: "64c3e719bb22", captain: { paneId: "pane:emma0001", name: "Emma" } }];
    const tools = createNousTools({ ask, rooms: async () => [{ id: "room:gates1", name: "Main" }], listPanes: async () => [], decisions: async () => [yes], liveTrains: async () => trains } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:n1", callId: "toolu_n", traceId: "trace:n" };
    const release = () => tools.execute("space_ask_operator", { category: "RELEASE", title: "Approve 1.2.0 1a2d8e72", body: "The clean publish commit.",
      recommendation: "Yes. Πρόβλεψη: ναι (95%)", action: { type: "RELEASE_APPROVE", product: "run-spaceapp" }, checked: ["The release train: candidate recorded"] }, ctx);
    expect((await release()).ok).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    // The same approved candidate again is still refused by R11-4.
    trains = [{ ...trains[0]!, approvedSha: "1a2d8e72aa11" }];
    expect(await release()).toMatchObject({ ok: false, display: "nous_decision:9f8a7fba already approved this" });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("asks for a hotfix approval only once its ticket waits on the stable queue (R10 hotfix-grant: ticket first, one decision)", async () => {
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:h", status: "OPEN", title: input.title }));
    const emma = { id: "pane:emma0001", roomId: "room:gates1", paneName: "Emma", title: "Emma", mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false };
    const ticket = (id: string, status: string) => ({ id, status, statusSince: null, branch: "b", sha: "a".repeat(40), submittedAt: "", updatedAt: "", summary: "", submitter: null, note: null,
      deployedCommit: null, remotes: null, conflictFiles: [], autoResolvedFiles: [] });
    const stable = { available: true, active: [ticket("q-20261028-085017-5c93", "AWAITING_APPROVAL")], recent: [ticket("q-20261028-070000-aaaa", "DEPLOYED")] };
    const tools = createNousTools({ ask, rooms: async () => [{ id: "room:gates1", name: "Main" }], listPanes: async () => [emma],
      queues: async () => [{ name: "stable", report: stable }, { name: "dev", report: { available: true, active: [], recent: [] } }] } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:h1", callId: "toolu_h", traceId: "trace:h" };
    const approve = (text: string) => tools.execute("space_ask_operator", { category: "RELEASE", title: "Approve the Qwen pins hotfix", body: "Stable fix.", recommendation: "Yes. Πρόβλεψη: ναι (80%)",
      action: { type: "PANE_TEXT", roomId: "room:gates1", paneId: "pane:emma0001", text, mode: "PROMPT" }, checked: ["The stable queue: the ticket"] }, ctx);
    expect(await approve("Submit the hotfix, then space-queue approve it.")).toMatchObject({ ok: false, result: expect.stringContaining("The action approves no ticket. Have the pane submit the hotfix first") });
    expect(await approve("space-queue approve q-20261028-090000-bbbb")).toMatchObject({ ok: false, display: "No ticket q-20261028-090000-bbbb on the stable queue" });
    expect(await approve("space-queue approve q-20261028-070000-aaaa")).toMatchObject({ ok: false, result: expect.stringContaining("q-20261028-070000-aaaa is DEPLOYED: only a hotfix waiting for approval") });
    expect(ask).not.toHaveBeenCalled();
    expect((await approve("space-queue approve q-20261028-085017-5c93")).ok).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(NOUS_PERSONA).toContain("A stable hotfix goes in this order: the pane submits its ticket first");
  });

  it("R20-fail-1 (a): a Space Control batch that would fail on the operator's yes is refused at ask time, naming the Settings path", async () => {
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:x", status: "OPEN", title: input.title }));
    const tools = createNousTools({ ask, rooms: async () => [{ id: "room:gates1", name: "Main" }], listPanes: async () => [] } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:g1", callId: "toolu_g", traceId: "trace:g" };
    const base = { category: "DIRECTION", title: "Goal turns every 10 minutes", body: "Saves tokens.", recommendation: "Yes. Πρόβλεψη: ναι (80%)", checked: ["Settings: goals.gapSeconds is 60"] };
    const nous = await tools.execute("space_ask_operator", { ...base, action: { type: "SPACE_CONTROL", roomId: "room:gates1",
      actions: [{ kind: "resource", operation: "settings.update", input: { domain: "nous", patch: { goals: { gapSeconds: 600 } } } }] } }, ctx);
    expect(nous).toMatchObject({ ok: false, display: "The action would fail", result: expect.stringContaining('settings.update takes the domains appearance, voice, task_titles, tools and plugins with a patch; "nous" is not one') });
    expect(nous.result).toContain("Settings (Assistants & AI → Nous; Notifications → Quiet hours)");
    expect((await tools.execute("space_ask_operator", { ...base, action: { type: "SPACE_CONTROL", roomId: "room:gates1", actions: [{ kind: "pane", operation: "explode" }] } }, ctx)).result)
      .toMatch(/^actions\.0/);
    expect(ask).not.toHaveBeenCalled();
    expect((await tools.execute("space_ask_operator", { ...base, action: { type: "SPACE_CONTROL", roomId: "room:gates1",
      actions: [{ kind: "resource", operation: "settings.update", input: { domain: "appearance", patch: { theme: "dark" } } }] } }, ctx)).ok).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("R21-2: a delete is checked for its id at ask time, and the approved batch carries the operator's yes as each delete's confirmation", async () => {
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:x", status: "OPEN", title: input.title }));
    const tools = createNousTools({ ask, rooms: async () => [{ id: "room:gates1", name: "Main" }], listPanes: async () => [] } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:g1", callId: "toolu_g", traceId: "trace:g" };
    const base = { category: "DESTRUCTIVE", title: "Delete the old export", body: "A week old.", recommendation: "Delete it. Πρόβλεψη: ναι (80%)", checked: ["Agent Files: the export is a week old"] };
    const noId = await tools.execute("space_ask_operator", { ...base, action: { type: "SPACE_CONTROL", roomId: "room:gates1", actions: [{ kind: "resource", operation: "files.delete" }] } }, ctx);
    expect(noId).toMatchObject({ ok: false, display: "The action would fail", result: expect.stringContaining('actions.0: files.delete names nothing to delete') });
    expect(ask).not.toHaveBeenCalled();
    expect(confirmedControlBatch([
      { kind: "resource", operation: "files.delete", input: { id: "artifact:a1" } },
      { kind: "resource", operation: "tasks.delete", id: "task:t1" },
      { kind: "clipboard", operation: "delete", id: "clipboard:c1" },
      { kind: "resource", operation: "files.publish", input: { path: "a.md" } }
    ], "nous_decision:c0cda5e8")).toEqual([
      { kind: "resource", operation: "files.delete", id: "artifact:a1", input: { id: "artifact:a1" }, confirm: true, approvalReason: "The operator's yes on nous_decision:c0cda5e8" },
      { kind: "resource", operation: "tasks.delete", id: "task:t1", confirm: true, approvalReason: "The operator's yes on nous_decision:c0cda5e8" },
      { kind: "clipboard", operation: "delete", id: "clipboard:c1", confirm: true },
      { kind: "resource", operation: "files.publish", input: { path: "a.md" } }
    ]);
    for (const action of confirmedControlBatch([{ kind: "resource", operation: "media.delete", id: "artifact:m1" }], "nous_decision:c0cda5e8")) expect(controlActionSchema.safeParse(action).success).toBe(true);
  });

  it("asks last (goal ee5a573e): every decision carries what Nous checked first, approvals of an action too (evening audit 29/10), and the operator sees the list", async () => {
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:x", status: "OPEN", title: input.title }));
    const tools = createNousTools({ ask, rooms: async () => [{ id: "room:gates1", name: "Main" }], listPanes: async () => [] } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:g1", callId: "toolu_g", traceId: "trace:g" };
    const base = { title: "Which logo?", body: "Two drafts are ready.", recommendation: "The blue one. Πρόβλεψη: ναι (80%)" };
    const direction = await tools.execute("space_ask_operator", { ...base, category: "DIRECTION", options: ["Blue", "Red"] }, ctx);
    expect(direction).toMatchObject({ ok: false, result: expect.stringContaining("checked is required: Ask last (operator goal ee5a573e") });
    const actionless = await tools.execute("space_ask_operator", { ...base, category: "EXTERNAL" }, ctx);
    expect(actionless.ok).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    const approval = { ...base, category: "EXTERNAL", title: "Send the reply",
      action: { type: "COPILOT", copilot: "MAIL", item: "REVIEW", itemId: "mailrev:1", paneId: null, decision: "APPROVE" } };
    expect(await tools.execute("space_ask_operator", approval, ctx)).toMatchObject({ ok: false, result: expect.stringContaining("checked is required") });
    expect(ask).not.toHaveBeenCalled();
    const checked = ["Space Memory: no logo preference", "Design pane: both drafts delivered 27/10"];
    expect((await tools.execute("space_ask_operator", { ...approval, checked }, ctx)).ok).toBe(true);
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ category: "EXTERNAL", action: expect.objectContaining({ itemId: "mailrev:1" }) }), { checked });
    expect((await tools.execute("space_ask_operator", { ...base, category: "DIRECTION", options: ["Blue", "Red"], checked }, ctx)).ok).toBe(true);
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ category: "DIRECTION" }), { checked });

    const raise = vi.fn(async () => null);
    const service = createNousService({ repository: new InMemoryNousRepository(), runner: async () => ({ text: "ok", isError: false }),
      world: async () => ({ text: "world", overview: {} }), settings: async () => ({ enabled: false, maxTurnsPerHour: 20 }),
      notifications: { raise, resolve: vi.fn(async () => 0) }, executeAction: vi.fn() } as unknown as NousServiceDeps);
    const decision = await service.ask({ ownerUserId: "user:operator", category: "DIRECTION", title: "Which logo?", body: "Two drafts are ready.", options: ["Blue", "Red"],
      recommendation: "The blue one.", refs: {}, action: null }, { checked });
    const block = "\n\nChecked first:\n• Space Memory: no logo preference\n• Design pane: both drafts delivered 27/10";
    expect(decision.body).toBe(`Two drafts are ready.${block}`);
    // The card's text is what Telegram sends too.
    expect((raise.mock.calls[0] as unknown as [{ body: string }])[0].body).toBe(`Recommendation: The blue one.\nTwo drafts are ready.${block}`);
    await service.idle("user:operator");
  });

  it("writes the recipients' domains' mail of 30 days, per account, on an EXTERNAL card (R10-17, R13-12)", async () => {
    // Lesson 28/10 19:31 BKK: the Shopflix card said «δεν έχει γράψει τίποτα» while two threads from other Shopflix senders held answers.
    const threads = vi.fn(async (_owner: string, query: { q?: string }) => query.q?.startsWith("from:shopflix.gr") ? {
      threads: [{ account: "shop@example.invalid", subject: "Re: Price feed", receivedAt: "2026-10-28T09:12:00.000Z" }, { account: "shop@example.invalid", subject: "Feed errors", receivedAt: "2026-10-25T08:00:00.000Z" }], nextPageToken: null, errors: [] }
      : query.q?.startsWith("from:quiet.example") ? { threads: [], nextPageToken: null, errors: [] } : { threads: [], nextPageToken: null, errors: [{ account: "a@b.co", message: "403" }] });
    const thread = vi.fn(async () => ({ messages: [{ from: { name: "Maria", address: "maria@shopflix.gr" }, to: [{ name: "", address: "shop@example.invalid" }] }] }));
    const mail = createNousMailContext({ threads: threads as never, thread: thread as never });
    const raise = vi.fn(async () => null);
    const service = createNousService({ repository: new InMemoryNousRepository(), runner: async () => ({ text: "ok", isError: false }),
      world: async () => ({ text: "world", overview: {} }), settings: async () => ({ enabled: false, maxTurnsPerHour: 20 }), mailContext: (owner: string, refs: never) => mail.lines(owner, refs),
      notifications: { raise, resolve: vi.fn(async () => 0) }, executeAction: vi.fn() } as unknown as NousServiceDeps);
    const ask = (title: string, category: "EXTERNAL" | "DIRECTION", refs: Record<string, unknown>) => service.ask({ ownerUserId: "user:operator", category, title, body: "The reply.",
      options: [], recommendation: "Yes.", refs, action: null }, { checked: ["Gmail: the thread"] });
    const sent = await ask("Reply to Shopflix", "EXTERNAL", { recipients: ["info@quiet.example", "maria@shopflix.gr", "eva@unread.example"], mailThread: { account: "shop@example.invalid", threadId: "t1" } });
    // One list item per line, so the card shows each on its own line (operator 30/10 08:44 BKK).
    // The mailbox holding the threads is Nous's (mail.lines below); the operator reads its kind (operator 2/11 09:49 BKK).
    expect(sent.body.split("\n\n")[0]).toBe(['- Mail from quiet.example in 30 days: none', '- Mail from shopflix.gr in 30 days: 2 threads in a connected mailbox, newest 2026-10-28 "Re: Price feed"',
      "- Mail from unread.example in 30 days: unknown (the mail read failed)"].join("\n"));
    expect((raise.mock.calls[0] as unknown as [{ body: string }])[0].body).toContain('Mail from shopflix.gr in 30 days: 2 threads in a connected mailbox');
    expect(sent.body).not.toContain("shop@example.invalid");
    // Operator 2/11 09:49 BKK «γιατι βλεπω ολα αυτα τα εμαιλ!!»: account facts are Nous's; an asked decision's body holds none of his addresses.
    const facts = await service.ask({ ownerUserId: "user:operator", category: "EXTERNAL", title: "Send the partner forms", body: "The forms.", options: [], recommendation: "Yes.",
      refs: {}, action: null }, { checked: ["Vault: the logins"] });
    expect(facts.body).not.toMatch(/Vault: \d|Sign-ins for|Connected Google accounts|@/);
    expect(threads).toHaveBeenCalledWith("user:operator", { account: "all", labelId: "ALL", q: "from:shopflix.gr OR to:shopflix.gr newer_than:30d", max: 50 });
    // The domain of the thread's own account is never listed; the lines are cached 2 minutes; other categories get none.
    expect(await mail.lines("user:operator", { mailThread: { account: "shop@example.invalid", threadId: "t1" } })).toEqual(['Mail from shopflix.gr in 30 days: shop@example.invalid: 2 threads, newest 2026-10-28 "Re: Price feed"']);
    // R13-12: a site the texts name joins only when it holds mail.
    expect(await mail.lines("user:operator", {}, ["shopflix.gr", "quiet.example"])).toEqual(['Mail from shopflix.gr in 30 days: shop@example.invalid: 2 threads, newest 2026-10-28 "Re: Price feed"']);
    expect(threads).toHaveBeenCalledTimes(3);
    expect((await ask("Which logo?", "DIRECTION", { recipients: ["maria@shopflix.gr"] })).body).not.toContain("Mail from");
    await service.idle("user:operator");
  });

  it("names no mail provider, own account or e-mail address's domain as a site; a free-mail recipient is searched by its address (operator 30/10 08:44 BKK)", async () => {
    // «Γιατί αναφέρει όλα αυτά τα εμαιλ σε κάθε decisions;»: gmail.com, google.com and spaceapp.dev lines on every EXTERNAL card.
    const threads = vi.fn(async (_owner: string, query: { q?: string }) => ({ threads: [{ account: "operator@example.invalid", subject: query.q!.split(" ")[0]!, receivedAt: "2026-10-29T09:00:00.000Z" }],
      nextPageToken: null, errors: [] }));
    const mail = createNousMailContext({ threads: threads as never, accounts: async () => ["operator@example.invalid", "ntheo@spaceapp.dev"] });
    const sites = namedSites(undefined, ["Reply to support@shopflix.gr from ntheo@spaceapp.dev", "Copy operator@example.invalid; sign in at accounts.google.com and app.spaceapp.dev first."]);
    expect(sites).toEqual(["accounts.google.com", "app.spaceapp.dev"]);
    expect(await mail.lines("user:operator", { recipients: ["support@shopflix.gr", "ntheo@spaceapp.dev"] }, sites)).toEqual(['Mail from shopflix.gr in 30 days: operator@example.invalid: 1 thread, newest 2026-10-29 "from:shopflix.gr"']);
    expect(await mail.lines("user:operator", { recipients: ["Maria.K@gmail.com", "operator@example.invalid"] })).toEqual(['Mail with maria.k@gmail.com in 30 days: operator@example.invalid: 1 thread, newest 2026-10-29 "from:maria.k@gmail.com"']);
    expect(threads).toHaveBeenCalledTimes(2);
  });

  it("names no systemd unit, file or local name as a site, only hosts with a real public suffix (operator 31/10 17:00 BKK)", () => {
    // The restart card read "Sign-ins for space-browser-host.service: Space never signed in there".
    expect(namedSites(undefined, ["Run the guarded restart of space-browser-host.service and codex-pane-host.service (graphical.target, x.socket, y.timer).",
      "Check scripts/space-queue.mjs, apps/api/src/app.ts, vm207.lan and example.local; then sign in at upwork.com and foo.github.io."])).toEqual(["upwork.com", "foo.github.io"]);
    expect(namedSites("space-browser-host.service", [])).toEqual([]);
    expect(namedSites("https://www.upwork.com/jobs", [])).toEqual(["upwork.com"]);
    // Every site an ask names gets its account facts (until 1/11 the first 5).
    expect(namedSites(undefined, ["a.com b.com c.com d.com e.com f.com g.com"])).toHaveLength(7);
  });

  it("tells Nous an allowance-held ask was not asked, so it never says the operator must approve it (operator 31/10 17:00 BKK)", async () => {
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:held0001", status: "OPEN", title: input.title, runsWhen: "the stable merge queue has a ticket in flight" }));
    const tools = createNousTools({ ask, rooms: async () => [], listPanes: async () => [] } as unknown as NousToolDeps);
    const result = await tools.execute("space_ask_operator", { category: "DIRECTION", title: "Guarded Browser Host restart on stable", body: "Restart it.", options: ["Yes", "No"],
      recommendation: "Yes. Πρόβλεψη: ναι (90%)", checked: ["space_queue_status: stable busy"] }, { owner: "user:operator", turnId: "nous_turn:h", callId: "toolu_h", traceId: "trace:h" });
    expect(result).toMatchObject({ ok: true, display: "Runs by itself when this clears: the stable merge queue has a ticket in flight",
      result: expect.stringContaining("Not asked (nous_decision:held0001)") });
  });

  // R65 (goal ee5a573e «να βρίσκεις πληροφορίες πριν ρωτήσεις»): R53's check for cards, on the two 3/11 cards the operator could have been spared.
  it("holds a card whose question the operator's earlier answer or a memory already answers, and lets it through with ruleDiffers (3/11 Hetzner pay and DAC7, R65)", async () => {
    const entry = (id: string, title: string, body: string, rule: boolean) => ({ id, title, body, rule, stems: cardStems(`${title} ${body}`) });
    const memory = [
      // 2/11 12:05 BKK, saved from his card answer; a free-text rule that shares the words "CAPTCHA" and "claude" decides nothing here.
      entry("space_memory:ab1542c4", "Operator: [Dino · Bob] My answer to \"Πληρώνεις τώρα το 129,50 € (το αμφισβητούμενο 159,22 € μένει απλήρωτο);\": Όχι ακόμα",
        "[Dino · Bob] My answer to \"Πληρώνεις τώρα το 129,50 € (το αμφισβητούμενο 159,22 € μένει απλήρωτο);\": Όχι ακόμα", true),
      entry("space_memory:6c5b5ffc", "Operator 28/10 12:03 BKK: pass every job application that waited for a CAPTCHA with the next run", "claude.ai hCaptcha pages are ready for the operator.", true),
      entry("space_memory:cd0c91d7", "Temu Seller Center: email-code sign-in since 3/11; DAC7 declared 3/11 13:14 UTC (TIN processing)",
        "INTRATRADE provided all EU TINs; Permanent Establishment in an EU state: No (no foreign registration or branch).", false)
    ];
    const notify = vi.fn(async () => ({ ok: true, display: "Sent the card", result: "ok" }));
    const dana = { id: "pane:dana0001", roomId: "room:alex0001", paneName: "Dana", title: "Dana", mode: "TERMINAL", isClosed: false };
    const cody = { ...dana, id: "pane:cody0001", paneName: "Cody", title: "Cody" };
    const copilotMemory = vi.fn(async () => [{ source: "JOB_COPILOT", id: "jobmem:Address0001", key: "home address", text: "Home street address: Kanakari 12, Patra", updatedAt: "2026-10-13T00:00:00.000Z" }]);
    const tools = createNousTools({ rooms: async () => [{ id: "room:alex0001", name: "Alex" }], listPanes: async () => [dana, cody], paneNotices: { notify },
      cardMemory: async () => memory, copilotMemory } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:r65", callId: "toolu_r65", traceId: "trace:r65" };
    // 3/11 12:19 BKK Alex/Dana asked what he had answered on 2/11 («Όχι ακόμα»); he answered «δεν θα πληρώσω τώρα, έχουμε περιθώριο».
    const hetzner = { text: "Hetzner: πλήρωσες το 129,50 € (085001365346);", question: "Πλήρωσες το τιμολόγιο 085001365346 (129,50 €);", options: ["Το πλήρωσα", "Όχι ακόμα"], recommended: "Το πλήρωσα" };
    const card = (item: Record<string, unknown>) => tools.execute("space_notify_operator", { room: "Alex", pane: "Dana", title: "Hetzner invoice", items: [item],
      checked: ["Hetzner robot: invoice 085001365346 open, due 15/11"] }, ctx);
    expect(await card(hetzner)).toMatchObject({ ok: false, refused: true, display: "Your rule already answers this",
      result: expect.stringContaining("earlier answer [space_memory:ab1542c4]") });
    // 3/11 20:16 BKK: the DAC7 item asked a company fact; a focus request goes through the same check.
    const dac7 = { room: "Alex", pane: "Cody", reason: "Temu DAC7 for INTRATRADE: other EU TINs or a Permanent Establishment?",
      question: "Temu DAC7 for INTRATRADE: does it hold other EU TINs or a Permanent Establishment in an EU state?", options: ["No to both", "Yes"], recommended: "No to both",
      checked: ["Temu Seller Center: DAC7 form open"] };
    expect(await tools.execute("space_focus_pane", dac7, ctx)).toMatchObject({ ok: false, refused: true, display: "Space already holds this",
      result: expect.stringContaining("Space Memory [space_memory:cd0c91d7]") });
    // A copilot's memory answers a fact too; secret-named keys never count.
    expect(await card({ text: "Which address goes on the Patra form?", question: "Which home street address goes on the Patra form?", options: ["Kanakari 12", "Other"], recommended: "Kanakari 12" }))
      .toMatchObject({ refused: true, result: expect.stringContaining("JOB_COPILOT memory jobmem:Address0001") });
    expect(notify).not.toHaveBeenCalled();
    // Hands work a memory shares words with still goes to the operator (only a rule or their earlier answer holds it), and so does a short question.
    expect((await card({ text: "hCaptcha on claude.ai: are you ready?", question: "hCaptcha claude.ai: είσαι έτοιμος;", options: ["Έτοιμος τώρα", "Αργότερα"], recommended: "Έτοιμος τώρα",
      steps: ["Open https://claude.ai/login", "Solve the hCaptcha"] })).ok).toBe(true);
    expect((await tools.execute("space_focus_pane", { ...dac7, reason: "Upload the INTRATRADE ID for Temu DAC7: other EU TINs or a Permanent Establishment?",
      question: "Upload the ID for Temu DAC7: does it hold other EU TINs or a Permanent Establishment in an EU state?" }, ctx)).ok).toBe(true);
    // ruleDiffers lets the item through and the card says how it differs.
    expect((await card({ ...hetzner, ruleDiffers: "A dunning notice now names suspension on 6/11" })).ok).toBe(true);
    expect(notify).toHaveBeenLastCalledWith("user:operator", expect.anything(), expect.objectContaining({ id: "pane:dana0001" }),
      expect.objectContaining({ items: [expect.objectContaining({ ruleDiffers: "A dunning notice now names suspension on 6/11" })] }));
    expect((await tools.execute("space_focus_pane", { ...dac7, ruleDiffers: "The memory is TOP IMPORTS's form, not INTRATRADE's" }, ctx)).ok).toBe(true);
    expect(notify).toHaveBeenLastCalledWith("user:operator", expect.anything(), expect.objectContaining({ id: "pane:cody0001" }),
      expect.objectContaining({ items: [expect.objectContaining({ ruleDiffers: "The memory is TOP IMPORTS's form, not INTRATRADE's" })] }));
  });

  // R66 (goal ee5a573e, lessons-1104-duplicate-hands-cards: on 4/11 three cards asked what Space held and five subjects reached the operator twice).
  describe("R66: cards refused when Space holds the answer or another pane's card asks the same", () => {
    const ctx = { owner: "user:operator", turnId: "nous_turn:r66", callId: "toolu_r66", traceId: "trace:r66" };
    const dana = { id: "pane:dana0001", roomId: "room:alex0001", paneName: "Dana", title: "Dana", mode: "TERMINAL", isClosed: false };
    const max = { ...dana, id: "pane:max00001", paneName: "Max", title: "Max" };
    const entry = (id: string, title: string, body: string) => ({ id, title, body, rule: false, stems: cardStems(`${title} ${body}`) });
    const setup = (deps: Partial<NousToolDeps> & { open?: () => Promise<unknown[]>; closedSince?: () => Promise<unknown[]> } = {}) => {
      const notify = vi.fn(async () => ({ ok: true, display: "Sent the card", result: "ok" }));
      const { open, closedSince, ...rest } = deps;
      const tools = createNousTools({ rooms: async () => [{ id: "room:alex0001", name: "Alex" }], listPanes: async () => [dana, max], paneNotices: { notify, ...(open ? { open } : {}), ...(closedSince ? { closedSince } : {}) },
        ...rest } as unknown as NousToolDeps);
      const card = (pane: string, item: Record<string, unknown>, checked = ["Space Memory: looked"]) => tools.execute("space_notify_operator", { room: "Alex", pane, title: `${pane} needs you`, items: [item],
        checked }, ctx);
      return { tools, notify, card };
    };

    it("(1) answers a phone question from Space Memory or Live memory: «τηλέφωνο» is no call, and the number's memory shares one word of the question (the 4/11 +66 miss)", async () => {
      // R65 let it through: CARD_HANDS read «τηλέφωνο» as a call, and holdsFact needs three of the question's stems where the memory shares one.
      const memory = [entry("space_memory:e9810832", "Startup programs: OVHcloud and the other forms 30/10", "Phone +66 82 558 4972 (the operator's) and Industry \"Technology\".")];
      const phoneItem = { text: "Hetzner Form A: το τηλέφωνο του αιτούντος", question: "Ποιο τηλέφωνο γράφω ως αιτών στο Form A της Hetzner;" };
      const { card, notify } = setup({ cardMemory: async () => memory });
      expect(await card("Max", phoneItem)).toMatchObject({ ok: false, refused: true, display: "Space already holds this",
        result: expect.stringContaining("+66 82 558 4972 (Space Memory [space_memory:e9810832])") });
      // Live personal memory alone answers it too (copilotMemory reads it); a masked number is no value.
      const live = setup({ cardMemory: async () => [entry("space_memory:mask0001", "Bank OTP", "codes go to the operator's Thai phone +66 ..72 only")],
        copilotMemory: async () => [{ source: "Live personal memory", id: "livemem:phone", key: "phone", text: "+66 82 558 4972", updatedAt: "2026-11-01T00:00:00.000Z" }] });
      expect(await live.card("Max", phoneItem)).toMatchObject({ refused: true, result: expect.stringContaining("+66 82 558 4972 (Live personal memory livemem:phone)") });
      // A call, or a code to the phone, is still the operator's.
      expect((await card("Max", { text: "Call Hetzner support by phone about the claim", steps: ["Open https://www.hetzner.com/support", "Call the number shown"] })).ok).toBe(true);
      expect((await card("Max", { text: "Read the SMS code on your phone for Piraeus", question: "Which SMS code did your phone get?", code: true })).ok).toBe(true);
      expect((await card("Max", { ...phoneItem, ruleDiffers: "Form A needs the Greek number after the porting" })).ok).toBe(true);
      expect(notify).toHaveBeenCalledTimes(3);
    });

    it("(2) refuses a sign-in item for a site with a Vault login or a sign-in record unless triedStored says the stored method failed (4/11 X @oll4com)", async () => {
      const siteSignins = new InMemorySiteSigninsRepository();
      await siteSignins.record("user:operator", { site: "claude.ai", method: "GOOGLE", googleAccountEmail: "ntheogr@gmail.com", outcome: "SUCCESS" }, "test");
      const call = vi.fn(async (input: { body: { site?: string } }) => ({ status: "LISTED", auditId: null,
        items: !input.body.site || input.body.site === "x.com" ? [{ handle: "vault:x1", label: "X @oll4com", origins: ["https://x.com"] }] : [] }));
      const { card, notify, tools } = setup({ siteSignins, vault: { agent: { call } } } as unknown as Partial<NousToolDeps>);
      // The 4/11 10:26 BKK card named the site only as "X".
      const x = { text: "X @oll4com: σύνδεση για τα posts Hetzner", steps: ["Open https://x.com/login", "Sign in as @oll4com"] };
      expect(await card("Dana", x)).toMatchObject({ ok: false, refused: true, display: "Space holds a sign-in for this site", result: expect.stringContaining("Vault login \"X @oll4com\" for x.com") });
      expect(await tools.execute("space_focus_pane", { room: "Alex", pane: "Dana", reason: "Sign in to claude.ai for the Max plan page", checked: ["Dana: login page"] }, ctx))
        .toMatchObject({ refused: true, result: expect.stringContaining("site sign-in record claude.ai (GOOGLE, 1 successful)") });
      expect(notify).not.toHaveBeenCalled();
      // The stored method failed: the card goes, and says what was tried.
      expect((await card("Dana", { ...x, triedStored: "Vault fill: X asked for the phone, no hint shown" })).ok).toBe(true);
      expect(notify).toHaveBeenLastCalledWith("user:operator", expect.anything(), expect.objectContaining({ id: "pane:dana0001" }),
        expect.objectContaining({ items: [expect.objectContaining({ triedStored: "Vault fill: X asked for the phone, no hint shown" })] }));
      // A link («σύνδεσμος») or a site Space holds nothing for is no stored sign-in; ruleDiffers still overrides.
      expect((await card("Dana", { text: "Άνοιξε τον σύνδεσμο του X για το post", steps: ["Open the post's link in the Main room", "Read the post"] })).ok).toBe(true);
      expect((await card("Dana", { text: "Sign in to skroutz.gr for the return", steps: ["Open https://www.skroutz.gr/login", "Sign in"] })).ok).toBe(true);
      expect((await card("Dana", { text: x.text, ruleDiffers: "This is the second X account, not the Vault's", steps: ["Open the X app", "Sign in as @oll4news"] })).ok).toBe(true);
    });

    it("(2) matches only the host of the card's link: 11/11 03:08Z an npmjs.com card was refused for spaceapp.dev, web.app and 192.0.2.x logins", async () => {
      const siteSignins = new InMemorySiteSigninsRepository();
      await siteSignins.record("user:operator", { site: "spaceapp.dev", method: "OTHER", outcome: "SUCCESS" }, "test");
      const items = [{ handle: "vault:s1", label: "SpaceApp dev", origins: ["https://spaceapp.dev"] }, { handle: "vault:w1", label: "Stremio subs", origins: ["https://stremio-dual-subs.web.app"] },
        { handle: "vault:p1", label: "Proxmox public-host", origins: ["https://192.0.2.5:8006"] }, { handle: "vault:l1", label: "Local Space", origins: ["http://127.0.0.1:4911"] }];
      // The Vault's list: everything without a site (what R66 reads), by host with one (vault/agent.ts listFilter).
      const call = vi.fn(async ({ body }: { body: { site?: string } }) => ({ status: "LISTED", auditId: null, items: items.filter((item) => !body.site
        || item.origins.some((origin) => { const host = new URL(origin).hostname; return host === body.site || host.endsWith(`.${body.site}`); })) }));
      const { card, tools } = setup({ siteSignins, vault: { agent: { call } } } as unknown as Partial<NousToolDeps>);
      // The text names no host: the old brand match read "spaceapp" (run-spaceapp), "web" (web.app) and the "0" of 1.2.0 as the IP logins' brand "0".
      const reason = "Approve the npm login link for Jack's run-spaceapp 1.2.0 train (web login) as operator";
      const steps = ["Open https://www.npmjs.com/login?next=/login/cli/abc", "Approve as operator"];
      expect(await card("Dana", { text: reason, steps })).toMatchObject({ ok: true });
      expect(await tools.execute("space_focus_pane", { room: "Alex", pane: "Dana", reason, steps, checked: ["Dana: npm login link waiting"] }, ctx)).not.toMatchObject({ refused: true });
      // An npmjs.com login in the Vault is still the stored method.
      items.push({ handle: "vault:n1", label: "npm operator", origins: ["https://www.npmjs.com"] });
      expect(await card("Dana", { text: reason, steps })).toMatchObject({ refused: true, result: expect.stringContaining("npm operator") });
    });

    it("(3) answers an installed app version question from Space's device records (4/11 «δεν μου εμφανισε εκδοση»)", async () => {
      const appDevices = vi.fn(async () => [{ platform: "ANDROID", appVersion: "0.2.13", lastSeenAt: "2026-11-04T13:55:12.000Z" }]);
      const { card, notify } = setup({ appDevices });
      expect(await card("Max", { text: "Nous app: which version is installed?", question: "Ποια έκδοση της εφαρμογής Nous βλέπεις στο κινητό;" })).toMatchObject({ ok: false, refused: true,
        display: "Space's records answer this", result: expect.stringContaining("ANDROID app 0.2.13, last seen 2026-11-04 13:55 UTC") });
      expect(await card("Max", { text: "Did the app update to 0.2.14?", question: "Did the Nous app update to 0.2.14?", options: ["Yes", "Not yet"], recommended: "Not yet" }))
        .toMatchObject({ refused: true, display: "Space's records answer this" });
      // Installing is hands work, not a question the records answer; with no version recorded nothing is held.
      expect((await card("Max", { text: "Install the 0.2.14 APK on your phone", steps: ["Open http://127.0.0.1:4911/apps", "Install 0.2.14"] })).ok).toBe(true);
      expect((await setup({ appDevices: async () => [{ platform: "ANDROID", appVersion: null, lastSeenAt: "2026-11-04T13:55:12.000Z" }] })
        .card("Max", { text: "Nous app version?", question: "Which version of the Nous app do you see?" })).ok).toBe(true);
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("(4) refuses an item whose subject an open Nous card on another pane already asks, by words or by meaning, with that card's id (4/11 DeepInfra, Skroutz)", async () => {
      const open = async () => [
        { id: "notification:deep0001", paneId: "pane:max00001", title: "Max needs you", payload: { items: [{ text: "DeepInfra Turnstile blocks the sign-up: solve it" }] } },
        { id: "notification:skro0001", paneId: "pane:max00001", title: "Max needs you", payload: { items: [{ text: "Skroutz: επιστροφή παραγγελίας", question: "Τύπωσες την ετικέτα επιστροφής;" }] } },
        { id: "notification:capt0001", paneId: "pane:max00001", title: "Max needs you", payload: { items: [{ text: "Solve the hCaptcha on claude.ai" }] } }];
      // Meaning across languages comes from the embeddings (a stand-in here: every Skroutz text is one vector).
      const embed = vi.fn(async (texts: string[]) => texts.map((text) => /skroutz/i.test(text) ? [1, 0, 0, 0] : /deepinfra/i.test(text) ? [0, 1, 0, 0]
        : /claude/i.test(text) ? [0, 0, 1, 0] : [0, 0, 0, 1]));
      const { card, notify } = setup({ open, embed });
      expect(await card("Dana", { text: "DeepInfra sign-up: solve the Cloudflare Turnstile", steps: ["Open https://deepinfra.com/login", "Solve the check"] }))
        .toMatchObject({ ok: false, refused: true, display: "An open card already asks this", result: expect.stringContaining("Card notification:deep0001") });
      expect(await card("Dana", { text: "Print the Skroutz return label", question: "Did you print the label?", options: ["Printed", "Not yet"], recommended: "Not yet" }))
        .toMatchObject({ refused: true, result: expect.stringContaining("Card notification:skro0001") });
      expect(notify).not.toHaveBeenCalled();
      // Another site is another subject; the same pane's card is replaced by the new list; ruleDiffers overrides.
      expect((await card("Dana", { text: "Solve the hCaptcha on chatgpt.com", steps: ["Open https://chatgpt.com/auth", "Solve it"] })).ok).toBe(true);
      expect((await card("Max", { text: "DeepInfra sign-up: solve the Cloudflare Turnstile", steps: ["Open https://deepinfra.com/login", "Solve the check"] })).ok).toBe(true);
      expect((await card("Dana", { text: "DeepInfra sign-up: solve the Cloudflare Turnstile", ruleDiffers: "A second DeepInfra account, for the lab key",
        steps: ["Open https://deepinfra.com/login", "Solve the check"] })).ok).toBe(true);
      // Without the embedder the words alone decide.
      expect((await setup({ open }).card("Dana", { text: "Print the Skroutz return label", question: "Did you print the label?", options: ["Printed", "Not yet"], recommended: "Not yet" })).ok).toBe(true);
    });

    it("(4c) 1056: a card's recommended option meets its lessons (13/11 REVIEW: Vault→keep and Pavago→skip were answered against the recommendation)", async () => {
      const recall = vi.fn(async (_owner: string, text: string) => /Delete it/.test(text)
        ? [{ key: "lessons-prediction-misses", text: "The operator keeps Vault entries; recommend Keep.", updatedAt: "", similarity: 0.8, shared: [] }] : []);
      const { card, notify } = setup({ lessons: { recall } } as unknown as Partial<NousToolDeps>);
      const item = { text: "Old Vault login for the closed Toggl account", question: "What should happen to it?", options: ["Keep", "Delete it"], recommended: "Delete it" };
      expect(await card("Dana", item)).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("recommend Keep") });
      expect(notify).not.toHaveBeenCalled();
    });

    it("(4d) 1056: a card or decision recommending against a saved principle rule is held once (keep over delete)", async () => {
      const operatorRules = async () => [{ id: "space_memory:keep0001", title: "Records", body: "Keep old entries over deleting them." }];
      const { card, notify, tools } = setup({ operatorRules } as Partial<NousToolDeps>);
      const item = { text: "Old Vault login for the closed Toggl account", question: "What should happen to it?", options: ["Keep", "Delete it"], recommended: "Delete it" };
      expect(await card("Dana", item)).toMatchObject({ refused: true, result: expect.stringContaining("\"Delete it\" goes against \"keep over delete\" (operator rule [space_memory:keep0001]") });
      expect((await card("Dana", item)).ok).toBe(true);
      expect((await card("Max", { ...item, ruleDiffers: "The login leaks a shared password" })).ok).toBe(true);
      expect(notify).toHaveBeenCalledTimes(2);
      expect(await tools.execute("space_ask_operator", { category: "DESTRUCTIVE", title: "Delete the old Toggl backups?", body: "They take 2 GB.", recommendation: "Yes. Prediction: yes (70%)",
        checked: ["Disk: 2 GB of Toggl backups"] }, ctx)).toMatchObject({ refused: true, result: expect.stringContaining("keep over delete") });
    });

    it("(4b) refuses an item a card closed in the last 2 hours already asked, on any pane (13/11 REVIEW: one npm 2FA link on 3 cards)", async () => {
      const closedSince = vi.fn(async () => [{ id: "notification:npm00001", paneId: "pane:dana0001", title: "Dana needs you", status: "RESOLVED", resolvedAt: "2026-11-12T09:12:00.000Z",
        updatedAt: "2026-11-12T09:12:00.000Z", payload: { items: [{ text: "npm 2FA link for run-spaceapp 1.2.0: open it and approve the publish" }] } }]);
      const { card, notify } = setup({ closedSince });
      expect(await card("Dana", { text: "Approve the npm 2FA link for the run-spaceapp 1.2.0 publish" }))
        .toMatchObject({ refused: true, display: "A card asked this in the last 2 hours", result: expect.stringContaining("Card notification:npm00001 (\"Dana needs you\", resolved at 09:12 UTC)") });
      expect(Date.now() - (closedSince.mock.calls[0] as unknown as [string, number])[1]).toBeGreaterThanOrEqual(2 * 3_600_000);
      expect(notify).not.toHaveBeenCalled();
      expect((await card("Dana", { text: "Approve the npm 2FA link for the run-spaceapp 1.2.0 publish", ruleDiffers: "The first link expired before it was used" })).ok).toBe(true);
    });

    it("(5) two panes, one subject, one card: the same ref, thread or site holds the second whatever its words (plan clipboard:USQ6ktIIN_1D step 9)", async () => {
      // The first pane's card is open when the second pane asks; nothing here shares two words, and there is no embedder.
      const cards: Array<{ id: string; paneId: string; title: string; payload: { items: unknown[] } }> = [];
      const { tools, notify } = setup({ open: async () => cards });
      notify.mockImplementation(async (...call: unknown[]) => {
        const [, , pane, args] = call as [string, unknown, { id: string }, { title: string; items: unknown[] }];
        cards.splice(0, cards.length, ...cards.filter((card) => card.paneId !== pane.id), { id: `notification:${pane.id.slice(5, 9)}`, paneId: pane.id, title: args.title, payload: { items: args.items } });
        return { ok: true, display: "Sent the card", result: "ok" };
      });
      const card = (pane: string, item: Record<string, unknown>, checked = ["Space Memory: looked"]) => tools.execute("space_notify_operator", { room: "Alex", pane, title: `${pane} needs you`, items: [item],
        checked }, ctx);
      expect((await card("Max", { text: "W-8BEN for Meridial: sign the tax form", ref: "task:w8ben0001", target: "url:https://app.meridial.com/tax",
        steps: ["Open https://app.meridial.com/tax", "Sign the form"] })).ok).toBe(true);
      // Same site: another page of meridial.com, other words.
      expect(await card("Dana", { text: "Approve the payout details", target: "url:https://meridial.com/payouts", steps: ["Open https://meridial.com/payouts", "Approve"] }))
        .toMatchObject({ ok: false, refused: true, display: "An open card already asks this", result: expect.stringContaining("Card notification:max0 (\"Max needs you\") already asks") });
      // Same ref; and focus requests go through the same check.
      expect(await tools.execute("space_focus_pane", { room: "Alex", pane: "Dana", reason: "Tax paperwork waits on you", ref: "task:w8ben0001", checked: ["Dana: the task is open"] }, ctx))
        .toMatchObject({ refused: true, result: expect.stringContaining("(the same ref task:w8ben0001)") });
      // Same mail thread on another pane's card.
      cards.push({ id: "notification:mail0001", paneId: "pane:cody0001", title: "Cody needs you", payload: { items: [{ text: "Reply to the landlord", target: "thread:me:18c9f2" }] } });
      expect(await card("Dana", { text: "Answer about the deposit", target: "thread:me:18c9f2" })).toMatchObject({ refused: true, result: expect.stringContaining("(the same target thread:me:18c9f2)") });
      // A bare "browser" target, another site, or ruleDiffers is no duplicate.
      expect((await card("Dana", { text: "Choose the plan for the pane browser", target: "browser", question: "Which plan?", options: ["Pro", "Free"], recommended: "Pro" })).ok).toBe(true);
      expect((await card("Dana", { text: "Approve the payout details", steps: ["Open https://wise.com/payouts", "Approve"], target: "url:https://wise.com/payouts" })).ok).toBe(true);
      expect((await card("Dana", { text: "Approve the payout details", target: "url:https://meridial.com/payouts", ruleDiffers: "A second Meridial account, for the lab",
        steps: ["Open https://meridial.com/payouts", "Approve"] })).ok).toBe(true);
      expect(notify).toHaveBeenCalledTimes(4);
    });

    it("(6) a draft's send that an ON maySend covers is held for space_ask_operator; with it OFF it passes; a sign-in item never (plan clipboard:USQ6ktIIN_1D last step)", async () => {
      // 5/11 12:17 BKK: the job-followup Gmail draft card the operator answered "Nous should do it".
      const draft = { text: "Job follow-up to Agoda: send the Gmail draft yourself", steps: ["Open Gmail → Drafts", "Press Send"] };
      const on = setup({ coversApproval: async () => true });
      expect(await on.card("Max", draft)).toMatchObject({ ok: false, refused: true, display: "maySend covers this send",
        result: expect.stringContaining("maySend is ON: use space_ask_operator with sendKind, refs.files and recipients; the allowance approves it") });
      expect(await on.card("Max", { text: "Στείλε το πρόχειρο στον recruiter" })).toMatchObject({ refused: true, display: "maySend covers this send" });
      expect(await on.tools.execute("space_focus_pane", { room: "Alex", pane: "Dana", reason: "Approve the reply", target: "thread:me:18c9f2", checked: ["Dana: reply written"] }, ctx))
        .toMatchObject({ refused: true, display: "maySend covers this send" });
      // Real hands work beside a draft stays the operator's; so does a send with no draft or thread named.
      expect((await on.card("Max", { text: "Sign in to Gmail, then send the draft", steps: ["Open https://mail.google.com", "Sign in"] })).ok).toBe(true);
      expect((await on.card("Max", { text: "Solve the CAPTCHA, then send the draft" })).ok).toBe(true);
      expect((await on.card("Max", { text: "Send the signed W-8BEN scan", steps: ["Open https://app.meridial.com/tax", "Upload it"] })).ok).toBe(true);
      // maySend OFF (or Nous off): the same card reaches the operator.
      expect((await setup({ coversApproval: async () => false }).card("Max", draft)).ok).toBe(true);
      expect((await setup().card("Max", draft)).ok).toBe(true);
      expect(on.notify).toHaveBeenCalledTimes(3);
    });

    it("(7) refuses premature payment/checkout/card-entry focus cards unless checked confirms final card form and verified amount/tier (R83-1, Upwork 80 Connects, Cloudflare+card)", async () => {
      const { card, tools, notify } = setup();
      // Upwork 80 Connects card: intermediate step (Select 80 Connects bundle) or missing final card form + verified amount
      const upworkCard = { text: "Upwork: purchase Connects for proposals", steps: ["Open Upwork", "Select 80 Connects bundle", "Enter card details"] };
      expect(await card("Max", upworkCard, ["Upwork: open"])).toMatchObject({ ok: false, refused: true, display: "Premature checkout card",
        result: expect.stringContaining("premature checkout/payment card") });
      // Premature Cloudflare + card focus card
      expect(await tools.execute("space_focus_pane", { room: "Alex", pane: "Dana", reason: "Enter card details on service checkout",
        steps: ["Pass Cloudflare Turnstile challenge", "Enter card details"], checked: ["Cloudflare challenge open"] }, ctx))
        .toMatchObject({ ok: false, refused: true, display: "Premature checkout card",
          result: expect.stringContaining("premature checkout/payment card") });
      // Missing verified amount/tier in checked
      expect(await card("Dana", { text: "Enter card details for payment" }, ["At the final card-input form"]))
        .toMatchObject({ ok: false, refused: true, result: expect.stringContaining("the verified amount or tier") });
      // Missing final card form in checked
      expect(await card("Dana", { text: "Enter card details for payment" }, ["Verified amount: $15.00 for 80 Connects"]))
        .toMatchObject({ ok: false, refused: true, result: expect.stringContaining("final card-input form") });
      expect(notify).not.toHaveBeenCalled();
      // Passes with both confirmed in checked and no intermediate steps in steps
      expect((await card("Dana", { text: "Enter card details for payment", steps: ["Enter card details on form"] },
        ["At the final card-input form", "Verified amount: $15.00 for 80 Connects package"])).ok).toBe(true);
      expect((await tools.execute("space_focus_pane", { room: "Alex", pane: "Dana", reason: "Enter CVV for billing",
        checked: ["At the final card-input form", "Verified total: $20/month tier"] }, ctx)).ok).toBe(true);
      expect(notify).toHaveBeenCalledTimes(2);
    });

    it("(8) holds only card entry, never a card that names a payout, a review card or a 2FA card (12-13/11: Alignerr ID check, Arize review, Upwork 2FA)", async () => {
      const { card, notify } = setup();
      // Dino/Nik 17:38Z: the Persona ID + selfie check; the ID country becomes the payout country («πληρωμή»).
      expect((await card("Max", { text: "Alignerr identity check: Persona ID + selfie", target: "url:https://app.alignerr.com/persona-reverification",
        steps: ["Open https://app.alignerr.com/persona-reverification", "Scan the ID: its country becomes the payout country (χώρα πληρωμής)", "Take the selfie"] })).ok).toBe(true);
      // Dino/Jack 17:49Z: the Mail review card of thread "Arize AX startup pricing".
      expect((await card("Dana", { text: "Review card: the reply to Arize AX startup pricing waits in Mail Copilot", target: "review:mailrev:oLB398mFW7pu",
        ref: "notification:ac6a5788ff164b1d9a141764" })).ok).toBe(true);
      // Bruno/Dana ~23:40 BKK: Upwork's Google 2FA card.
      expect((await card("Max", { text: "Upwork Google 2FA card: approve the sign-in prompt on your phone", steps: ["Open the Google prompt on your phone", "Tap Yes"] })).ok).toBe(true);
      expect(notify).toHaveBeenCalledTimes(3);
      // The real case (operator rule 7/11) still waits for the final card form and the verified amount.
      expect(await card("Dana", { text: "Namecheap: renew spaceapp.dev", steps: ["Open https://www.namecheap.com/cart/checkout", "Add payment method", "Enter the card number"] }))
        .toMatchObject({ ok: false, refused: true, display: "Premature checkout card", result: expect.stringContaining("final card-input form") });
      expect(notify).toHaveBeenCalledTimes(3);
    });

    it("(9) passes an identity check under a payments URL, an ID card, a 2FA login and a phone pairing card; a checkout URL still holds (13/11 review)", async () => {
      const { card, notify } = setup();
      expect((await card("Max", { text: "Upwork identity check: ID + selfie", target: "url:https://www.upwork.com/nx/payments/identity-verification" })).ok).toBe(true);
      expect((await card("Max", { text: "Contra wants ID card details: photograph the ID card, then a selfie" })).ok).toBe(true);
      expect((await card("Max", { text: "Upwork Google 2FA SMS code", steps: ["Open https://www.upwork.com/ab/account-security/login?redir=/nx/payments/", "Type the SMS code"] })).ok).toBe(true);
      expect((await card("Dana", { text: "Nous Pro: pair your phone, scan the QR in the paid Nous app", steps: ["Open http://127.0.0.1:4911/nous/pair", "Scan the QR"] })).ok).toBe(true);
      expect(notify).toHaveBeenCalledTimes(4);
      expect(await card("Dana", { text: "Fiverr: buy the gig", steps: ["Open https://www.fiverr.com/payments/checkout", "Enter the card number"] }))
        .toMatchObject({ ok: false, refused: true, display: "Premature checkout card" });
      expect(notify).toHaveBeenCalledTimes(4);
    });
  });

  it("keeps the account facts for Nous's holds, never on asks and cards, and refuses once to create or sign in where Space has the account (R20-ask-1, operator 2/11 09:49 BKK)", async () => {
    // 30/10: three "you could have found it" corrections, all about accounts (a Google business account, a Microsoft account that never existed, a Vault login).
    const siteSignins = new InMemorySiteSigninsRepository();
    await siteSignins.record("user:operator", { site: "braintrust.com", method: "GOOGLE", googleAccountEmail: "ntheogr@gmail.com", outcome: "SUCCESS" }, "test");
    const call = vi.fn(async (input: { body: { site?: string } }) => ({ status: "LISTED", auditId: null, items: input.body.site === "upwork.com"
      ? [{ handle: "vault:h1", label: "Upwork", origins: ["https://www.upwork.com"], account: "ntheogr@gmail.com" }]
      : input.body.site === undefined ? [{ handle: "vault:h2", label: "Shop (shop.owner@example.net)", origins: ["https://shop.example.net"] }] : [] }));
    const ask = vi.fn(async (input: { title: string }, _options?: object) => ({ id: "nous_decision:acc0001", status: "OPEN", title: input.title }));
    const notify = vi.fn(async () => ({ ok: true, display: "Sent the card", result: "ok" }));
    const andy = { id: "pane:andy0001", roomId: "room:gates1", paneName: "Andy", title: "Andy", mode: "TERMINAL", isClosed: false };
    const tools = createNousTools({ ask, rooms: async () => [{ id: "room:gates1", name: "Main" }], listPanes: async () => [andy], siteSignins, vault: { agent: { call } },
      mail: { accounts: async () => ["ntheogr@gmail.com"] }, paneNotices: { notify } } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:acc", callId: "toolu_acc", traceId: "trace:acc" };
    const card = (text: string, checked = ["Space Memory: nothing on it"]) => tools.execute("space_notify_operator", { room: "Main", pane: "Andy", title: "Andy needs you", items: [{ text }], checked }, ctx);
    expect(await card("Create a Google Workspace account for the shop")).toMatchObject({ ok: false, refused: true,
      result: expect.stringContaining("Not asked: a connected Google account exists (ntheogr@gmail.com): use it instead of a new one.") });
    expect(notify).not.toHaveBeenCalled();
    // What Nous tried, in checked, passes; the card carries no facts.
    expect((await card("Create a Google Workspace account for the shop", ["Connected Google accounts: the operator wants a separate one for the shop"])).ok).toBe(true);
    expect(notify).toHaveBeenLastCalledWith("user:operator", expect.anything(), expect.objectContaining({ id: "pane:andy0001" }), expect.anything());
    expect(await tools.execute("space_focus_pane", { room: "Main", pane: "Andy", reason: "Sign in to upwork.com for the proposal", checked: ["Andy: the page asks to log in"] }, ctx))
      .toMatchObject({ ok: false, refused: true, result: expect.stringContaining("an agent can do this (rule 4d47dcab): the Vault has a login for upwork.com; have a pane do it (space_vault_fill") });
    await card("Finish the braintrust.com profile's ID check");
    await tools.execute("space_ask_operator", { category: "DIRECTION", title: "Use the Microsoft account on microsoft.com?", body: "For the Azure trial.", options: ["Yes", "No"],
      recommendation: "Yes. Πρόβλεψη: ναι (60%)", checked: ["Space Memory: nothing"] }, ctx);
    // A slip in Nous's own wording is replaced by the account's kind before it is stored (operator 2/11 09:49 BKK).
    await tools.execute("space_ask_operator", { category: "DIRECTION", title: "Keep ntheogr@gmail.com for the shop?", body: "Its mail goes to NTheoGR@gmail.com and info@example.invalid.",
      options: ["Keep ntheogr@gmail.com", "Use a new one"], recommendation: "Keep it.", prediction: { answer: "Keep ntheogr@gmail.com", confidence: 70 }, checked: ["ntheogr@gmail.com: the shop's mails"] }, ctx);
    expect(ask.mock.calls.at(-1)).toEqual([expect.objectContaining({ title: "Keep your Gmail for the shop?", body: "Its mail goes to your Gmail and info@example.invalid.",
      options: ["Keep your Gmail", "Use a new one"], recommendation: expect.stringContaining("Keep your Gmail (70 %)"),
      refs: expect.objectContaining({ prediction: expect.objectContaining({ answer: "Keep your Gmail" }) }) }), expect.objectContaining({ checked: ["your Gmail: the shop's mails"] })]);
    await card("Check the shop mail in ntheogr@gmail.com and shop.owner@example.net", ["the inbox of ntheogr@gmail.com"]);
    expect(notify).toHaveBeenLastCalledWith("user:operator", expect.anything(), expect.anything(), expect.objectContaining({ room: "Main", pane: "Andy",
      items: [{ text: "Check the shop mail in your Gmail and your example.net mailbox" }], checked: ["the inbox of your Gmail"] }));
    // No card or decision the operator reads carries his addresses or Space's sign-in records.
    const sent = JSON.stringify([...notify.mock.calls, ...ask.mock.calls]);
    expect([sent.includes("ntheogr@gmail.com"), sent.includes("Sign-ins for"), sent.includes("Connected Google accounts: n")]).toEqual([false, false, false]);
    // A sign-in step keeps the account it signs in with; every other step names its kind.
    await tools.execute("space_notify_operator", { room: "Main", pane: "Andy", title: "Andy needs you", items: [{ text: "Sign in to https://example.org/login for the shop",
      steps: ["Open https://example.org/login", "Sign in with ntheogr@gmail.com", "Forward the code to ntheogr@gmail.com"] }], checked: ["example.org: no stored sign-in"] }, ctx);
    expect(notify).toHaveBeenLastCalledWith("user:operator", expect.anything(), expect.anything(), expect.objectContaining({
      items: [expect.objectContaining({ steps: ["Open https://example.org/login", "Sign in with ntheogr@gmail.com", "Forward the code to your Gmail"] })] }));

    // R21-asklast-pendings (lessons-1031-do-it-yourself): the pendings list's facts mark what an agent does, and a reply asking for it is held.
    expect(await tools.accountFactLines("user:operator", ["decision \"Sign in to upwork.com\"", "Handoff for the upwork.com sign-in"])).toEqual([
      "Vault login for upwork.com: an agent signs in (space_vault_fill); not the operator's", "Sign-ins for upwork.com: Space never signed in there (do not call it an existing account)",
      "Connected Google accounts: ntheogr@gmail.com", "Vault: 1 login for upwork.com: Upwork (ntheogr@gmail.com)"]);
    expect(await tools.accountFactLines("user:operator", ["Please unlock the Vault for the new card"])).toEqual(["Vault unlock: never the operator's (agents and Nous fill with no unlock; a saved login joins at once)"]);
    // A fresh tools instance: the focus ask above already used this hour's hold for upwork.com.
    const replyNow = vi.fn(async () => "SENT" as const);
    const fresh = createNousTools({ rooms: async () => [], listPanes: async () => [], siteSignins, vault: { agent: { call } }, mail: { accounts: async () => ["ntheogr@gmail.com"] }, replyNow } as unknown as NousToolDeps);
    const reply = (text: string, turnId = "nous_turn:reply") => fresh.execute("space_reply_now", { text }, { ...ctx, turnId });
    expect(await reply("Κάνε sign-in στο upwork.com, σου έστειλα handoff")).toMatchObject({ ok: false, refused: true, display: "Not sent: an agent can do it",
      result: expect.stringContaining("the Vault has a login for upwork.com") });
    expect(await reply("Unlock the Vault please")).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("Vault unlock: never the operator's") });
    expect(replyNow).not.toHaveBeenCalled();
    expect((await reply("Το upwork.com proposal στάλθηκε.")).ok).toBe(true);
  });

  it("names a site's Vault logins and mail on an EXTERNAL ask, and refuses a support message once until the sign-in and the mailbox were tried (R13-12)", async () => {
    // 29/10 12:46 6dffcd55: an Upwork support message; the account signs in with Google and Upwork's mail sat in a connected mailbox.
    const ask = vi.fn(async (input: { title: string }, _options?: object) => ({ id: "nous_decision:sup0001", status: "OPEN", title: input.title }));
    const call = vi.fn(async (input: { body: { site?: string } }) => ({ status: "LISTED", auditId: null, items: input.body.site === "upwork.com"
      ? [{ handle: "vault:h1", label: "Upwork", origins: ["https://www.upwork.com"], account: "ntheogr@gmail.com" }] : [] }));
    const mailContext = vi.fn(async () => ['Mail from upwork.com in 30 days: ntheogr@gmail.com: 4 threads, newest 2026-10-28 "Your account"']);
    const tools = createNousTools({ ask, rooms: async () => [], listPanes: async () => [], vault: { agent: { call } }, mailContext } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:s1", callId: "toolu_s", traceId: "trace:s" };
    const support = (checked: string[]) => tools.execute("space_ask_operator", { category: "EXTERNAL", title: "Send the Upwork support message", body: "Ask upwork.com support to reset the locked account.",
      recommendation: "Send it. Πρόβλεψη: ναι (85%)", checked }, ctx);
    const refused = await support(["Upwork: the sign-in page asks for a code"]);
    expect(refused).toMatchObject({ ok: false, refused: true, display: "Try the stored sign-in and the mailbox for upwork.com first",
      result: expect.stringMatching(/Vault: 1 login for upwork\.com: Upwork \(ntheogr@gmail\.com\).* Mail from upwork\.com in 30 days: ntheogr@gmail\.com: 4 threads/) });
    expect(ask).not.toHaveBeenCalled();
    // Asked again with the mailbox named: asked with the site passed for the mail lines; the Vault line stays Nous's (operator 2/11 09:49 BKK).
    expect((await support(["Vault: Upwork signs in with Google ntheogr@gmail.com", "ntheogr@gmail.com: Upwork's mail of 28/10 asks for a code"])).ok).toBe(true);
    expect(ask.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ sites: ["upwork.com"] }));
    expect(ask.mock.calls.at(-1)?.[1]).not.toHaveProperty("vaultLines");
    // Not a support message: no refusal, the lines still go.
    expect((await tools.execute("space_ask_operator", { category: "EXTERNAL", title: "Send the proposal", body: "Proposal for the upwork.com client.", recommendation: "Send. Πρόβλεψη: ναι (80%)",
      checked: ["The lead: budget fits"] }, ctx)).ok).toBe(true);
  });

  it("never holds Nous's own cards and decisions from the operator, even while it holds other notifications", async () => {
    const repository = new InMemorySpaceNotificationsRepository(undefined, true);
    const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }),
      nous: { held: async () => true, raised: () => {} } });
    const base = { ownerUserId: "user:operator", roomId: null, paneId: null, severity: "ATTENTION" as const, body: "", link: {}, payload: {}, telegram: null };
    await service.raise({ ...base, source: "NOUS", kind: "NEEDS_HANDS", title: "Upwork needs you", dedupeKey: "nous:pane:pane:andy0001" });
    await service.raise({ ...base, source: "NOUS", kind: "DECISION_RELEASE", title: "Release 1.2.0", dedupeKey: "nous:decision:x" });
    await service.raise({ ...base, source: "MAIL_COPILOT", kind: "REVIEW", title: "A review", dedupeKey: "mail:review:1" });
    expect(repository.telegram.map((item) => item.source)).toEqual(["NOUS", "NOUS"]);
  });

  describe("decision answers", () => {
    const sessionSecret = "nous-gates-test-secret-long-enough";
    const apps: FastifyInstance[] = [];
    afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

    it("come only from a person in the dock, never a proof session", async () => {
      const app = await createApp({ store: new InMemorySpaceStore(), auth: { sessionSecret, devLogin: false, secureCookies: false },
        nousRunner: async () => ({ text: "ok", isError: false }) });
      apps.push(app);
      const session = signSessionWithTtl({ id: "user:operator-proof", email: "space@space.local", role: "ADMIN" }, sessionSecret, 120);
      const proof = await app.inject({ method: "POST", url: "/api/nous/decisions/nous_decision:abcdef123456/answer",
        headers: { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! }, payload: { answer: "APPROVE" } });
      expect(proof.statusCode).toBe(403);
      const feedback = await app.inject({ method: "POST", url: "/api/nous/decisions/nous_decision:abcdef123456/feedback",
        headers: { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! }, payload: { couldHaveDecided: true } });
      expect(feedback.statusCode).toBe(403);
    });
  });
});
