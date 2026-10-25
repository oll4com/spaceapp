import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadImageAttestations } from "../../packages/run-spaceapp/src/image-attestations.mjs";
import { attestedImage, fakeRegistry } from "../../packages/run-spaceapp/tests/fixtures/attested-image.mjs";
import { runCli } from "../verify-published-containers.mjs";

const sha = "f1c4e8351bb899ab9bd741b6e0d531b6ba8436c8";

// runCli prints its verdict; keep the test output clean and hand the verdict back.
async function verify(images, argv) {
  const tags = Object.fromEntries(images.map((image) => [`${image.repository}:1.1.8`, image.digest]));
  const registry = fakeRegistry(images, { tags });
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    return await runCli(["--version", "1.1.8", ...argv], (repository, reference) => loadImageAttestations(repository, reference, { get: registry.get }));
  } finally {
    process.stdout.write = write;
    process.exitCode = 0;
  }
}

const all = (options = {}) => ["core", "cli", "browser"].map((target) => attestedImage({ repository: `oll4com/spaceapp-${target}`, ...options }));

test("the release verifies both platforms of each image by its provenance, from this run's commit", async () => {
  assert.deepEqual(await verify(all(), ["--workflow-sha", sha]), { ok: true, blockers: [] });
});

test("an explicit amd64-only release needs amd64 only", async () => {
  const images = all({ architectures: ["amd64"] });
  assert.deepEqual(await verify(images, ["--architectures", "amd64"]), { ok: true, blockers: [] });
  assert.deepEqual((await verify(images, [])).blockers, [
    "ghcr.io/oll4com/spaceapp-core:1.1.8 is missing linux/arm64.",
    "ghcr.io/oll4com/spaceapp-cli:1.1.8 is missing linux/arm64.",
    "ghcr.io/oll4com/spaceapp-browser:1.1.8 is missing linux/arm64."
  ]);
});

test("missing evidence and images built from another commit are blockers", async () => {
  const core = attestedImage();
  const amd64Attestation = core.index.manifests[2];
  core.index = { ...core.index, manifests: core.index.manifests.filter((entry) => entry !== amd64Attestation) };
  const bytes = Buffer.from(JSON.stringify(core.index));
  core.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  core.objects.set(core.digest, bytes);
  const result = await verify([core, ...all().slice(1)], ["--targets", "core", "--workflow-sha", sha]);
  assert.deepEqual(result.blockers, [
    "ghcr.io/oll4com/spaceapp-core:1.1.8 does not expose an SBOM for linux/amd64.",
    "ghcr.io/oll4com/spaceapp-core:1.1.8 does not expose provenance for linux/amd64."
  ]);
  const other = "0".repeat(40);
  assert.deepEqual((await verify(all({ workflowSha: other }), ["--targets", "cli", "--architectures", "arm64", "--workflow-sha", sha])).blockers, [
    `ghcr.io/oll4com/spaceapp-cli:1.1.8 linux/arm64 was built from ${other}, not ${sha}.`
  ]);
});

test("the workflow commit must be a full commit id", async () => {
  await assert.rejects(verify(all(), ["--workflow-sha", "f1c4e83"]), /Usage: verify-published-containers\.mjs/);
});
