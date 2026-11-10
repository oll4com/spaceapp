import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemorySourceControlRepository } from "../../../packages/db/src/source-control-repository.js";
import { SourceControlService } from "../src/source-control/service.js";
import { GitControlError } from "../src/source-control/errors.js";
import { DemoCredentialStore } from "../src/demo-projects/credentials.js";

let root: string, project: string, repository: InMemorySourceControlRepository;
let creates: number, outcome: "ok" | "unknown" | "collision" | "bad-request" | "not-sent";
const remote = { id: "42", fullName: "owner/repo", cloneUrl: "https://github.com/owner/repo.git", webUrl: "https://github.com/owner/repo", private: true, defaultBranch: "main", permissions: { pull: true, push: true, admin: true } };
function service() {
  return new SourceControlService({ repository, credentialRoot: join(root, "credentials"), credentials: new DemoCredentialStore(join(root, "credentials")), providerFactory: () => ({
    identity: async () => ({ login: "owner", email: null }), repositories: async () => [remote], repository: async () => remote,
    lookup: async () => remote, list: async () => ({ data: [remote], nextPage: null, nextCursor: null }),
    targets: async () => ({ data: [{ id: "user:owner", provider: "github" as const, kind: "user" as const, name: "owner", canCreateRepository: true }], nextPage: null, nextCursor: null }),
    create: async () => create(), createRepository: async () => create(), validateCloneUrl: async (url: string) => url
  }) });
}
async function create() {
  creates++;
  if (outcome === "unknown") throw Object.assign(new GitControlError("PROVIDER_UNAVAILABLE", "Provider unavailable", 503), { createAttempted: true });
  if (outcome === "collision") throw new GitControlError("REPOSITORY_COLLISION", "Name unavailable", 409);
  // GitLab and Bitbucket report a taken name with HTTP 400.
  if (outcome === "bad-request") throw Object.assign(new GitControlError("PROVIDER_REJECTED", "Rejected", 400), { createAttempted: true });
  // A target lookup failed with a provider outage before the create request was sent.
  if (outcome === "not-sent") throw Object.assign(new GitControlError("PROVIDER_UNAVAILABLE", "Provider unavailable", 503), { createNotSent: true });
  return remote;
}
const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
beforeEach(async () => {
  const scratch = join(tmpdir(), "repository-provider-test-fixtures");
  await mkdir(scratch, { recursive: true }); root = await mkdtemp(join(scratch, "publish-")); project = join(root, "project"); await mkdir(project);
  repository = new InMemorySourceControlRepository(); creates = 0; outcome = "ok";
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function setup(svc = service()) {
  await svc.connect("user:a", "github", { token: "fixture-token" }); const binding = await svc.bind("user:a", project, "github");
  const input = { bindingId: binding.id, expectedVersion: (await svc.status("user:a", binding.id)).version, paths: [], confirmed: true, private: true, name: "repo", targetId: "user:owner", operationId: "owned-publish-001" };
  return { svc, binding, input };
}
const author = { name: "Fixture", email: "fixture@example.invalid" };
describe("durable remote publishing", () => {
  it("previews explicit target/name/private default and leaves index and files intact", async () => {
    await writeFile(join(project, "staged.txt"), "staged\n"); git("add", "staged.txt"); await writeFile(join(project, "draft.txt"), "draft\n");
    const { svc, input } = await setup();
    const preview = await svc.previewPublish("user:a", input);
    expect(preview).toMatchObject({ name: "repo", private: true, targetId: "user:owner", hasCommits: false, willCommit: false, willPush: false });
    expect(creates).toBe(0); expect(git("diff", "--cached", "--name-only")).toBe("staged.txt"); expect(await readFile(join(project, "draft.txt"), "utf8")).toBe("draft\n");
  });
  it("records uncertain creates and never adopts a colliding name or retries POST after restart", async () => {
    const { svc, input, binding } = await setup(); outcome = "unknown";
    const first = await svc.operate("user:a", "publish", input, author);
    expect(first).toMatchObject({ ok: false, remoteCreated: false, createOutcome: "unknown", committed: false, pushed: false });
    outcome = "ok";
    const retried = await service().operate("user:a", "publish", input, author);
    expect(retried).toMatchObject({ ok: false, createOutcome: "unknown" }); expect(creates).toBe(1);
    expect((await repository.getBinding("user:a", binding.id))?.repository).toBeNull();
    expect(git("remote")).toBe("");
  });
  it("does not call a remote collision success and keeps another owner's binding inaccessible", async () => {
    const { svc, input } = await setup(); outcome = "collision";
    await expect(svc.operate("user:a", "publish", input, author)).rejects.toMatchObject({ code: "REPOSITORY_COLLISION" });
    await expect(service().operate("user:b", "publish", input, author)).rejects.toMatchObject({ code: "BINDING_NOT_FOUND" });
    expect(creates).toBe(1); expect(git("remote")).toBe("");
  });
  it("allows a new explicit operation after definite collision, but never retries the rejected operation", async () => {
    const { svc, input } = await setup(); outcome = "collision";
    await expect(svc.operate("user:a", "publish", input, author)).rejects.toMatchObject({ code: "REPOSITORY_COLLISION" });
    outcome = "unknown";
    await expect(svc.operate("user:a", "publish", input, author)).rejects.toMatchObject({ code: "REPOSITORY_COLLISION" });
    const next = await svc.operate("user:a", "publish", { ...input, name: "new-name", operationId: "owned-publish-002" }, author);
    expect(next).toMatchObject({ ok: false, createOutcome: "unknown" }); expect(creates).toBe(2);
  });
  it("records a 400 answer or a failure before the request as definitely not created, so a new publish can follow", async () => {
    const { svc, input } = await setup(); outcome = "bad-request";
    await expect(svc.operate("user:a", "publish", input, author)).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
    expect(await repository.getPublish("user:a", input.bindingId)).toMatchObject({ state: "rejected" });
    outcome = "not-sent";
    await expect(svc.operate("user:a", "publish", { ...input, operationId: "owned-publish-002" }, author)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(await repository.getPublish("user:a", input.bindingId)).toMatchObject({ state: "rejected", operationId: "owned-publish-002" });
    expect(await svc.pendingPublishes("user:a", project)).toEqual([]);
  });
  it("lists an unconfirmed publish and lets the owner dismiss it only after confirming, then publish again", async () => {
    const { svc, input, binding } = await setup(); outcome = "unknown";
    expect(await svc.operate("user:a", "publish", input, author)).toMatchObject({ createOutcome: "unknown" });
    expect(await svc.pendingPublishes("user:a", project)).toEqual([expect.objectContaining({ bindingId: binding.id, operationId: "owned-publish-001", state: "unknown", name: "repo", provider: "github" })]);
    await expect(svc.dismissPublish("user:b", binding.id, "owned-publish-001")).rejects.toMatchObject({ code: "BINDING_NOT_FOUND" });
    await expect(svc.dismissPublish("user:a", binding.id, "other-operation")).rejects.toMatchObject({ code: "PUBLISH_NOT_DISMISSIBLE" });
    expect(await svc.dismissPublish("user:a", binding.id, "owned-publish-001")).toMatchObject({ ok: true });
    expect(await svc.pendingPublishes("user:a", project)).toEqual([]);
    await expect(svc.dismissPublish("user:a", binding.id, "owned-publish-001")).rejects.toMatchObject({ code: "PUBLISH_NOT_DISMISSIBLE" });
    outcome = "collision";
    await expect(svc.operate("user:a", "publish", { ...input, operationId: "owned-publish-002" }, author)).rejects.toMatchObject({ code: "REPOSITORY_COLLISION" });
    expect(creates).toBe(2);
  });
  it("rejects an existing origin before remote creation", async () => {
    git("remote", "add", "origin", "https://other.invalid/owned/repo.git"); const { svc, input } = await setup();
    await expect(svc.operate("user:a", "publish", input, author)).rejects.toMatchObject({ code: "REMOTE_EXISTS" });
    expect(creates).toBe(0); expect(git("remote", "get-url", "origin")).toBe("https://other.invalid/owned/repo.git");
  });
});
