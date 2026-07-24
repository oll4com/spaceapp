import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { evaluatePublishedContainer } from "../verify-published-containers.mjs";

const verifierPath = resolve(import.meta.dirname, "../verify-published-containers.mjs");

const manifest = {
  manifests: [
    { platform: { os: "linux", architecture: "amd64" } },
    { platform: { os: "unknown", architecture: "unknown" } },
    { platform: { os: "linux", architecture: "arm64" } },
    { platform: { os: "unknown", architecture: "unknown" } }
  ]
};

test("published container verification requires both platforms and attestations", () => {
  assert.deepEqual(
    evaluatePublishedContainer({
      image: "ghcr.io/oll4com/spaceapp-core:0.1.4",
      manifest,
      sbom: { SPDXID: "SPDXRef-DOCUMENT" },
      provenance: { buildType: "https://mobyproject.org/buildkit@v1" }
    }),
    { ok: true, blockers: [] }
  );
});

test("published container verification reports missing architecture and evidence", () => {
  const result = evaluatePublishedContainer({
    image: "ghcr.io/oll4com/spaceapp-core:0.1.4",
    manifest: { manifests: manifest.manifests.slice(0, 2) },
    sbom: null,
    provenance: null
  });

  assert.deepEqual(result.blockers, [
    "ghcr.io/oll4com/spaceapp-core:0.1.4 is missing linux/arm64.",
    "ghcr.io/oll4com/spaceapp-core:0.1.4 does not expose two platform attestations.",
    "ghcr.io/oll4com/spaceapp-core:0.1.4 does not expose an SBOM.",
    "ghcr.io/oll4com/spaceapp-core:0.1.4 does not expose provenance."
  ]);
});

test("published container verification reads SLSA from Buildx provenance", async () => {
  const verifier = await readFile(verifierPath, "utf8");

  assert.match(verifier, /\["--format", "\{\{json \.Provenance\.SLSA\}\}"\]/);
  assert.doesNotMatch(verifier, /\["--format", "\{\{json \.SLSA\}\}"\]/);
});
