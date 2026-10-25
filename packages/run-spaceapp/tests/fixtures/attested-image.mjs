import { createHash } from "node:crypto";

// A SpaceApp image as the release workflow publishes it (BuildKit sbom + provenance mode=max), with real digests, and a
// fake ghcr.io serving it. `provenanceFor` changes one platform's provenance statement.
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function attestedImage({
  repository = "oll4com/spaceapp-core",
  architectures = ["amd64", "arm64"],
  workflowSha = "f1c4e8351bb899ab9bd741b6e0d531b6ba8436c8",
  runId = "39996418646",
  provenanceFor = (statement) => statement
} = {}) {
  const objects = new Map();
  const put = (value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = sha(bytes);
    objects.set(digest, bytes);
    return { digest, size: bytes.length };
  };
  const manifests = [];
  const attestationDescriptors = [];
  for (const architecture of architectures) {
    const image = put({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", architecture });
    manifests.push({ mediaType: "application/vnd.oci.image.manifest.v1+json", ...image, platform: { os: "linux", architecture } });
    const provenance = put(provenanceFor({
      _type: "https://in-toto.io/Statement/v0.1",
      predicateType: "https://slsa.dev/provenance/v1",
      subject: [{ name: `pkg:docker/ghcr.io/${repository}@1.1.8?platform=linux%2F${architecture}`, digest: { sha256: image.digest.slice(7) } }],
      predicate: {
        buildDefinition: { internalParameters: {
          github_repository: "oll4com/spaceapp",
          github_workflow_ref: "oll4com/spaceapp/.github/workflows/release.yml@refs/heads/main",
          github_workflow_sha: workflowSha,
          github_run_id: runId
        } },
        runDetails: { builder: { id: `https://github.com/oll4com/spaceapp/actions/runs/${runId}/attempts/1` } }
      }
    }, architecture));
    const attestation = put({ schemaVersion: 2, layers: [
      { ...put({ spdxVersion: "SPDX-2.3" }), annotations: { "in-toto.io/predicate-type": "https://spdx.dev/Document" } },
      { ...provenance, annotations: { "in-toto.io/predicate-type": "https://slsa.dev/provenance/v1" } }
    ] });
    attestationDescriptors.push({ mediaType: "application/vnd.oci.image.manifest.v1+json", ...attestation, platform: { os: "unknown", architecture: "unknown" },
      annotations: { "vnd.docker.reference.digest": image.digest, "vnd.docker.reference.type": "attestation-manifest" } });
  }
  const index = { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [...manifests, ...attestationDescriptors] };
  const { digest } = put(index);
  return { repository, digest, index, objects };
}

/**
 * A fake ghcr.io for `images`, as registry-https.mjs's httpsGet sees it: blobs redirect to the storage host like ghcr.io's.
 * `requests` lists every URL read with its Authorization header; `tags` maps a tag to an index digest; `answer(url)` may
 * replace any answer (or throw).
 */
export function fakeRegistry(images, { tags = {}, tamper = new Set(), answer = () => null } = {}) {
  const requests = [];
  const get = async (url, { headers = {} } = {}) => {
    const { host, pathname } = new URL(url);
    requests.push({ url, authorization: headers.Authorization ?? null });
    const replaced = await answer(url);
    if (replaced) return replaced;
    if (host === "ghcr.io" && pathname === "/token") return { status: 200, body: Buffer.from(JSON.stringify({ token: "anonymous" })) };
    if (host === "ghcr.io" && pathname.includes("/blobs/")) {
      return { status: 307, location: `https://pkg-containers.githubusercontent.com/ghcr1/blobs/${pathname.split("/").pop()}?sig=x`, body: Buffer.alloc(0) };
    }
    const digestOrTag = pathname.split("/").pop();
    const repository = host === "ghcr.io" ? pathname.split("/").slice(2, 4).join("/") : null;
    const digest = tags[`${repository}:${digestOrTag}`] ?? digestOrTag;
    const bytes = images.map((image) => image.objects.get(digest)).find(Boolean);
    if (!bytes || (repository && !images.some((image) => image.repository === repository && image.objects.has(digest)))) return { status: 404, body: Buffer.from("not found") };
    return { status: 200, body: tamper.has(digest) ? Buffer.concat([bytes, Buffer.from(" ")]) : bytes };
  };
  return { get, requests };
}
