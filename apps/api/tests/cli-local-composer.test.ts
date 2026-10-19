import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemoryControlRepository } from "@space/db";
import { cliLocalComposerRecordKind, cliLocalComposerSubmissionSchema, createCliLocalComposerService } from "../src/cli-local-composer.js";

const identity = { ownerUserId: "user:alice", roomId: "room:composer", paneId: "pane:composer" };
const input = () => ({ submissionId: randomUUID(), expectedSessionId: "cli_session:composer", text: "first line\nsecond\tline" });
const attempt = () => ({ traceId: "trace:composer", assertCurrent: vi.fn(async () => undefined) });
function fixture(repository = new InMemoryControlRepository()) {
  const sendInput = vi.fn(async (_sessionId: string, _data: string, _trace: string, _key: string): Promise<unknown> => undefined);
  const wait = vi.fn(async (_ms: number) => undefined);
  const serialize = vi.fn(async <T>(_sessionId: string, work: () => Promise<T>) => work());
  const service = createCliLocalComposerService({ repository, sendInput, wait, serialize });
  return { repository, service, sendInput, wait, serialize };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("durable local CLI composer submissions", () => {
  it("persists before delivery, sends one multiline paste then Enter after settling, and survives a new service", async () => {
    const f = fixture();
    const draft = input();
    const control = attempt();
    const order: string[] = [];
    f.sendInput.mockImplementation(async (_session, data) => {
      expect((await f.repository.list(cliLocalComposerRecordKind, identity.ownerUserId))[0]?.value).toMatchObject({ status: "DISPATCHING" });
      order.push(data);
    });
    f.wait.mockImplementation(async ms => { order.push(`wait:${ms}`); });
    const sent = await f.service.submit(identity, draft, control);
    expect(sent).toEqual({ submissionId: draft.submissionId, sessionId: draft.expectedSessionId, status: "SENT" });
    expect(order).toEqual([`\u001b[200~${draft.text}\u001b[201~`, "wait:200", "\r"]);
    expect(control.assertCurrent).toHaveBeenCalledTimes(2);
    expect(f.serialize).toHaveBeenCalledOnce();
    const [paste, enter] = f.sendInput.mock.calls;
    expect(paste![3]).toMatch(/^local-composer:[a-f0-9]{64}:text$/);
    expect(enter![3]).toBe(paste![3].replace(/:text$/, ":enter"));
    const stored = await f.repository.list(cliLocalComposerRecordKind, identity.ownerUserId);
    expect(JSON.stringify(stored)).not.toContain(draft.text);
    const restarted = fixture(f.repository);
    expect(await restarted.service.get(identity, draft.submissionId)).toEqual(sent);
    expect(await restarted.service.submit(identity, draft, attempt())).toEqual(sent);
    expect(restarted.sendInput).not.toHaveBeenCalled();
  });

  it("keeps image paste boundaries and ordering, including image-only drafts", async () => {
    for (const text of ["describe these", ""]) {
      const f = fixture();
      const draft = { ...input(), text, imagePaths: ["/opt/spaceapp/var/artifacts/cli-uploads/one.png", "/opt/spaceapp/var/artifacts/cli-uploads/two.png"] };
      expect((await f.service.submit(identity, draft, attempt())).status).toBe("SENT");
      expect(f.sendInput.mock.calls.map(call => call[1])).toEqual([
        ...draft.imagePaths.map(path => `\u001b[200~${path}\u001b[201~`),
        ...(text ? [`\u001b[200~${text}\u001b[201~`] : []), "\r"
      ]);
      expect(f.wait).toHaveBeenCalledTimes(text ? 3 : 2);
      expect(new Set(f.sendInput.mock.calls.map(call => call[3])).size).toBe(f.sendInput.mock.calls.length);
    }
  });

  it("joins concurrent duplicate POSTs and lets GET report an in-progress receipt without changing it", async () => {
    const f = fixture();
    const draft = input();
    const started = gate();
    const release = gate();
    f.sendInput.mockImplementationOnce(async () => { started.resolve(); await release.promise; });
    const first = f.service.submit(identity, draft, attempt());
    await started.promise;
    const duplicate = f.service.submit(identity, draft, attempt());
    expect((await f.service.get(identity, draft.submissionId)).status).toBe("UNCERTAIN");
    expect((await f.repository.list(cliLocalComposerRecordKind, identity.ownerUserId))[0]).toMatchObject({ version: 1, value: { status: "DISPATCHING" } });
    release.resolve();
    expect((await Promise.all([first, duplicate])).map(result => result.status)).toEqual(["SENT", "SENT"]);
    expect(f.sendInput).toHaveBeenCalledTimes(2);
  });

  it("serializes distinct submissions to the same pane across service instances", async () => {
    const f = fixture();
    const other = fixture(f.repository);
    const started = gate();
    const release = gate();
    f.sendInput.mockImplementationOnce(async () => { started.resolve(); await release.promise; });
    const first = f.service.submit(identity, input(), attempt());
    await started.promise;
    const second = other.service.submit(identity, input(), attempt());
    await Promise.resolve();
    expect(other.sendInput).not.toHaveBeenCalled();
    release.resolve();
    expect((await Promise.all([first, second])).map(result => result.status)).toEqual(["SENT", "SENT"]);
    expect(other.sendInput).toHaveBeenCalledTimes(2);
  });

  it("never reuses an accepted ID for changed text, session or images", async () => {
    const f = fixture();
    const draft = { ...input(), imagePaths: ["/tmp/image.png"] };
    await f.service.submit(identity, draft, attempt());
    for (const changed of [
      { ...draft, text: `${draft.text}!` },
      { ...draft, expectedSessionId: "cli_session:replacement" },
      { ...draft, imagePaths: ["/tmp/other.png"] }
    ]) await expect(f.service.submit(identity, changed, attempt())).rejects.toThrow("different composer draft or CLI session");
    expect(f.sendInput).toHaveBeenCalledTimes(3);
    expect((await f.service.get({ ...identity, ownerUserId: "user:bob" }, draft.submissionId)).status).toBe("NOT_FOUND");
    expect((await f.service.get({ ...identity, paneId: "pane:other" }, draft.submissionId)).status).toBe("NOT_FOUND");
  });

  it("requires receipt storage to succeed before any terminal side effect", async () => {
    for (const mode of ["throw", "conflict"] as const) {
      const f = fixture();
      const write = vi.spyOn(f.repository, "write");
      if (mode === "throw") write.mockRejectedValue(new Error("database unavailable"));
      else write.mockResolvedValue(false);
      await expect(f.service.submit(identity, input(), attempt())).rejects.toThrow();
      expect(f.sendInput).not.toHaveBeenCalled();
      expect(f.serialize).not.toHaveBeenCalled();
    }
  });

  it("keeps a crash/incomplete tombstone if the final receipt cannot be committed", async () => {
    const f = fixture();
    const draft = input();
    const originalWrite = f.repository.write.bind(f.repository);
    vi.spyOn(f.repository, "write").mockImplementation((record, expectedVersion) => {
      if (expectedVersion > 0) throw new Error("database went away after input");
      return originalWrite(record, expectedVersion);
    });
    expect((await f.service.submit(identity, draft, attempt())).status).toBe("UNCERTAIN");
    expect((await f.repository.list(cliLocalComposerRecordKind, identity.ownerUserId))[0]?.value).toMatchObject({ status: "DISPATCHING" });
    const restarted = fixture(f.repository);
    expect((await restarted.service.submit(identity, draft, attempt())).status).toBe("UNCERTAIN");
    expect(restarted.sendInput).not.toHaveBeenCalled();
  });

  it.each([0, 1])("treats a failed input acknowledgement at step %s as uncertain and never replays", async failedStep => {
    const f = fixture();
    const draft = input();
    let step = 0;
    f.sendInput.mockImplementation(async () => { if (step++ === failedStep) throw new Error("host accepted input but reply was lost"); });
    expect((await f.service.submit(identity, draft, attempt())).status).toBe("UNCERTAIN");
    expect(f.sendInput).toHaveBeenCalledTimes(failedStep + 1);
    const restarted = fixture(f.repository);
    expect((await restarted.service.get(identity, draft.submissionId)).status).toBe("UNCERTAIN");
    expect((await restarted.service.submit(identity, draft, attempt())).status).toBe("UNCERTAIN");
    expect(restarted.sendInput).not.toHaveBeenCalled();
  });

  it("rejects before side effects if authority was lost while queued, and does not reuse that ID", async () => {
    const f = fixture();
    const draft = input();
    const control = attempt();
    control.assertCurrent.mockRejectedValue(new Error("stale lease"));
    expect((await f.service.submit(identity, draft, control)).status).toBe("REJECTED");
    expect(f.sendInput).not.toHaveBeenCalled();
    expect((await f.service.submit(identity, draft, attempt())).status).toBe("REJECTED");
    expect(f.sendInput).not.toHaveBeenCalled();
  });

  it("withholds Enter if control changes during the paste settle period", async () => {
    const f = fixture();
    const control = attempt();
    control.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValue(new Error("another page took over"));
    expect((await f.service.submit(identity, input(), control)).status).toBe("UNCERTAIN");
    expect(f.sendInput.mock.calls.map(call => call[1])).toHaveLength(1);
    expect(f.sendInput.mock.calls[0]![1]).not.toBe("\r");
  });

  it("rejects terminal control injection and relative/image paths containing key sequences", () => {
    for (const text of ["before\u001b[201~\rcommand", "x\u0000y", "a\bb", "line\rnext", "x\u009by", "\n \t"]) {
      expect(cliLocalComposerSubmissionSchema.safeParse({ ...input(), text }).success, JSON.stringify(text)).toBe(false);
    }
    for (const path of ["relative.png", "/tmp/x\ncommand", "/tmp/x\u001b[201~"])
      expect(cliLocalComposerSubmissionSchema.safeParse({ ...input(), imagePaths: [path] }).success).toBe(false);
    expect(cliLocalComposerSubmissionSchema.safeParse({ ...input(), text: "Ελληνικά\n日本語\t🙂" }).success).toBe(true);
  });
});
