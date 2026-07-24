import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePublishedContainer,
  loadPublishedContainerEvidence
} from "../verify-published-containers.mjs";

const manifest = {
  manifests: [
    {
      digest: "sha256:amd64",
      platform: { os: "linux", architecture: "amd64" }
    },
    {
      digest: "sha256:arm64",
      platform: { os: "linux", architecture: "arm64" }
    },
    {
      digest: "sha256:amd64-attestation",
      annotations: {
        "vnd.docker.reference.digest": "sha256:amd64",
        "vnd.docker.reference.type": "attestation-manifest"
      },
      platform: { os: "unknown", architecture: "unknown" }
    },
    {
      digest: "sha256:arm64-attestation",
      annotations: {
        "vnd.docker.reference.digest": "sha256:arm64",
        "vnd.docker.reference.type": "attestation-manifest"
      },
      platform: { os: "unknown", architecture: "unknown" }
    }
  ]
};

const attestationManifest = {
  layers: [
    {
      annotations: {
        "in-toto.io/predicate-type": "https://spdx.dev/Document"
      }
    },
    {
      annotations: {
        "in-toto.io/predicate-type": "https://slsa.dev/provenance/v1"
      }
    }
  ]
};

test("published container verification requires both platforms and attestations", () => {
  assert.deepEqual(
    evaluatePublishedContainer({
      image: "ghcr.io/oll4com/spaceapp-core:0.1.4",
      manifest,
      attestations: [
        {
          descriptor: manifest.manifests[2],
          manifest: attestationManifest
        },
        {
          descriptor: manifest.manifests[3],
          manifest: attestationManifest
        }
      ]
    }),
    { ok: true, blockers: [] }
  );
});

test("published container verification reports missing architecture and evidence", () => {
  const result = evaluatePublishedContainer({
    image: "ghcr.io/oll4com/spaceapp-core:0.1.4",
    manifest: { manifests: [manifest.manifests[0], manifest.manifests[2]] },
    attestations: [
      {
        descriptor: manifest.manifests[2],
        manifest: { layers: [] }
      }
    ]
  });

  assert.deepEqual(result.blockers, [
    "ghcr.io/oll4com/spaceapp-core:0.1.4 does not expose an SBOM for linux/amd64.",
    "ghcr.io/oll4com/spaceapp-core:0.1.4 does not expose provenance for linux/amd64.",
    "ghcr.io/oll4com/spaceapp-core:0.1.4 is missing linux/arm64."
  ]);
});

test("published container verification reads compact attestation manifests instead of full SBOM documents", () => {
  const calls = [];
  const inspectRaw = (reference) => {
    calls.push(reference);
    if (reference.endsWith(":0.1.4")) return manifest;
    return attestationManifest;
  };

  assert.deepEqual(
    loadPublishedContainerEvidence(
      "ghcr.io/oll4com/spaceapp-core:0.1.4",
      inspectRaw
    ),
    {
      manifest,
      attestations: [
        {
          descriptor: manifest.manifests[2],
          manifest: attestationManifest
        },
        {
          descriptor: manifest.manifests[3],
          manifest: attestationManifest
        }
      ]
    }
  );
  assert.deepEqual(calls, [
    "ghcr.io/oll4com/spaceapp-core:0.1.4",
    "ghcr.io/oll4com/spaceapp-core@sha256:amd64-attestation",
    "ghcr.io/oll4com/spaceapp-core@sha256:arm64-attestation"
  ]);
});
