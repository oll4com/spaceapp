import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.mjs";
import { evaluateImageAttestations, loadImageAttestations, verifyLockedImages } from "../src/image-attestations.mjs";
import { createDefaultConfig, readRecordedDigests, writeRuntimeFiles } from "../src/index.mjs";
import { RegistryUnreachableError } from "../src/registry-https.mjs";
import { attestedImage, fakeRegistry } from "./fixtures/attested-image.mjs";

const images = () => ["core", "cli", "browser"].map((target) => attestedImage({ repository: `oll4com/spaceapp-${target}` }));
const lockOf = (built) => ({ schemaVersion: 1, runtimeVersion: "1.1.8", images: Object.fromEntries(built.map((image) => [image.repository.split("-").pop(), image.digest])) });
const loader = (registry) => (repository, reference) => loadImageAttestations(repository, reference, { get: registry.get });
const verifier = (registry) => (imageLock) => verifyLockedImages(imageLock, { load: loader(registry), now: () => new Date("2026-10-24T06:00:00Z") });

async function withEnv(values, body) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await body(); } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

test("a published image passes with each platform's SBOM and provenance from the release workflow", async () => {
  const image = attestedImage();
  const registry = fakeRegistry([image]);
  const result = evaluateImageAttestations({ image: "core", ...await loadImageAttestations(image.repository, image.digest, { get: registry.get }) });
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(Object.keys(result.platforms), ["amd64", "arm64"]);
  assert.deepEqual(result.platforms.amd64, { digest: image.index.manifests[0].digest, runId: "39996418646", workflowSha: "f1c4e8351bb899ab9bd741b6e0d531b6ba8436c8" });
  // The provenance statements are read, from ghcr.io's storage host without the registry token; the SBOMs are not.
  const sbomDigests = image.index.manifests.slice(2).map((descriptor) => JSON.parse(image.objects.get(descriptor.digest)).layers[0].digest);
  assert.ok(sbomDigests.every((digest) => !registry.requests.some(({ url }) => url.includes(digest))));
  const storage = registry.requests.filter(({ url }) => url.startsWith("https://pkg-containers.githubusercontent.com/"));
  assert.equal(storage.length, 2);
  assert.ok(storage.every(({ authorization }) => authorization === null));
  assert.ok(registry.requests.filter(({ url }) => url.includes("/v2/")).every(({ authorization }) => authorization === "Bearer anonymous"));
});

test("bytes that do not hash to the digest they were read by are refused", async () => {
  const image = attestedImage();
  const provenance = JSON.parse(image.objects.get(image.index.manifests[2].digest)).layers[1].digest;
  for (const tampered of [image.digest, image.index.manifests[2].digest, provenance]) {
    const registry = fakeRegistry([image], { tamper: new Set([tampered]) });
    await assert.rejects(loadImageAttestations(image.repository, image.digest, { get: registry.get }), /does not match its digest/);
  }
});

test("provenance about another image, from another workflow or without a commit is a blocker", () => {
  const cases = [
    [(statement) => ({ ...statement, subject: [{ digest: { sha256: "0".repeat(64) } }] }), /has no provenance about its linux\/amd64 image/],
    [(statement) => ({ ...statement, predicate: { ...statement.predicate, buildDefinition: { internalParameters: {
      ...statement.predicate.buildDefinition.internalParameters, github_workflow_ref: "oll4com/spaceapp/.github/workflows/release.yml@refs/heads/fork" } } } }), /was not built by oll4com\/spaceapp\/\.github\/workflows\/release\.yml@refs\/heads\/main/],
    [(statement) => ({ ...statement, predicate: { ...statement.predicate, runDetails: { builder: { id: "https://github.com/someone/spaceapp/actions/runs/39996418646/attempts/1" } } } }), /was not built by/],
    [(statement) => ({ ...statement, predicate: { ...statement.predicate, buildDefinition: { internalParameters: {
      ...statement.predicate.buildDefinition.internalParameters, github_workflow_sha: undefined } } } }), /names no source commit/]
  ];
  for (const [change, message] of cases) {
    const image = attestedImage({ provenanceFor: (statement, architecture) => architecture === "amd64" ? change(statement) : statement });
    const evidence = { index: image.index, attestations: [] };
    for (const descriptor of image.index.manifests.slice(2)) {
      const manifest = JSON.parse(image.objects.get(descriptor.digest));
      evidence.attestations.push({ descriptor, manifest, provenance: [JSON.parse(image.objects.get(manifest.layers[1].digest))] });
    }
    const result = evaluateImageAttestations({ image: "core", ...evidence });
    assert.equal(result.ok, false);
    assert.match(result.blockers.join(" "), message);
    assert.deepEqual(Object.keys(result.platforms), ["arm64"]);
  }
});

test("an unreachable registry stops with the proxy settings and the opt-out; a failed check wins over it", async () => {
  const built = images();
  const lock = lockOf(built);
  for (const answer of [
    () => { throw new RegistryUnreachableError("ghcr.io: connect ECONNREFUSED"); },
    (url) => url.includes("spaceapp-cli") ? { status: 503, body: Buffer.alloc(0) } : null
  ]) {
    const error = await verifyLockedImages(lock, { load: loader(fakeRegistry(built, { answer })) }).catch((reason) => reason);
    assert.ok(error instanceof RegistryUnreachableError);
    for (const named of ["HTTPS_PROXY", "NO_PROXY", "~/.docker/config.json", "SPACEAPP_IMAGE_VERIFY=off"]) assert.ok(error.message.includes(named), named);
  }
  // core cannot be reached, cli has no attestation for its digest: the failed check is what stops, with no opt-out offered.
  const mixed = fakeRegistry(built, { answer: (url) => url.includes("spaceapp-core") ? Promise.reject(new RegistryUnreachableError("timed out")) : null });
  const error = await verifyLockedImages({ ...lock, images: { ...lock.images, cli: `sha256:${"9".repeat(64)}` } }, { load: loader(mixed) }).catch((reason) => reason);
  assert.equal(error instanceof RegistryUnreachableError, false);
  assert.match(error.message, /could not be verified, so none of them was pulled: ghcr\.io\/oll4com\/spaceapp-cli@sha256:9{64}: ghcr\.io answered HTTP 404/);
  assert.doesNotMatch(error.message, /SPACEAPP_IMAGE_VERIFY/);
});

test("a locked package's images are verified once, before their digests are recorded or runtime.env names them", async () => {
  const built = images();
  const lock = lockOf(built);
  const registry = fakeRegistry(built);
  const root = await mkdtemp(join(tmpdir(), "spaceapp-image-attestations-"));
  await writeRuntimeFiles(root, createDefaultConfig({ version: "1.1.8" }), lock, verifier(registry));
  const evidence = JSON.parse(await readFile(join(root, "image-attestations.json"), "utf8"));
  assert.equal(evidence["1.1.8"].verifiedAt, "2026-10-24T06:00:00.000Z");
  assert.equal(evidence["1.1.8"].images.cli.index, lock.images.cli);
  assert.equal(evidence["1.1.8"].images.browser.platforms.arm64.workflowSha, "f1c4e8351bb899ab9bd741b6e0d531b6ba8436c8");
  assert.deepEqual(await readRecordedDigests(root), { "1.1.8": lock.images });
  // The next start with the same package reads nothing from the registry.
  const reads = registry.requests.length;
  await writeRuntimeFiles(root, createDefaultConfig({ version: "1.1.8" }), lock, verifier(registry));
  assert.equal(registry.requests.length, reads);

  // A package whose images do not check out writes nothing: no digests, no evidence, no runtime.env.
  const fresh = await mkdtemp(join(tmpdir(), "spaceapp-image-attestations-refused-"));
  const unattested = { ...lock, images: { ...lock.images, core: `sha256:${"9".repeat(64)}` } };
  await assert.rejects(writeRuntimeFiles(fresh, createDefaultConfig({ version: "1.1.8" }), unattested, verifier(registry)),
    /SpaceApp 1\.1\.8 images could not be verified, so none of them was pulled: ghcr\.io\/oll4com\/spaceapp-core@sha256:9{64}: ghcr\.io answered HTTP 404/);
  for (const file of ["image-digests.json", "image-attestations.json", "runtime.env"]) {
    assert.equal(await stat(join(fresh, file)).catch(() => null), null, file);
  }
});

test("SPACEAPP_IMAGE_VERIFY=off records the version as unverified, warns on every run, and is verified once it is unset", async () => {
  const built = images();
  const lock = lockOf(built);
  const registry = fakeRegistry(built);
  const root = await mkdtemp(join(tmpdir(), "spaceapp-image-verify-off-"));
  await withEnv({ SPACEAPP_IMAGE_VERIFY: "off" }, () => writeRuntimeFiles(root, createDefaultConfig({ version: "1.1.8" }), lock, verifier(registry)));
  assert.equal(registry.requests.length, 0);
  assert.equal(JSON.parse(await readFile(join(root, "image-attestations.json"), "utf8"))["1.1.8"].skipped, "SPACEAPP_IMAGE_VERIFY=off");
  assert.match(await readFile(join(root, "runtime.env"), "utf8"), /SPACEAPP_CORE_IMAGE_DIGEST=@sha256:/);
  await writeRuntimeFiles(root, createDefaultConfig({ version: "1.1.8" }), lock, verifier(registry));
  assert.ok(registry.requests.length > 0);
  assert.equal(JSON.parse(await readFile(join(root, "image-attestations.json"), "utf8"))["1.1.8"].images.core.index, lock.images.core);

  let stderr = "";
  const io = { stdout: { write: () => true }, stderr: { write: (text) => { stderr += text; return true; } } };
  await run(["help"], { env: { SPACEAPP_IMAGE_VERIFY: "OFF", SPACEAPP_HOME: root }, ...io });
  assert.match(stderr, /^WARNING: SPACEAPP_IMAGE_VERIFY=off: SpaceApp does not check the provenance of its images/);
  stderr = "";
  await run(["help"], { env: { SPACEAPP_HOME: root }, ...io });
  assert.equal(stderr, "");
});
