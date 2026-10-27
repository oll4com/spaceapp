import { createHash } from "node:crypto";
import { IMAGE_TARGETS } from "./image-lock.mjs";
import { httpsGet, RegistryUnreachableError } from "./registry-https.mjs";

// SpaceApp's own images carry BuildKit SBOM and SLSA provenance attestations (reviews EXT-C-F5, IR117-C-F7). The npm
// package pins each image index by digest, and the index lists one attestation manifest per platform image, so every
// object read here by digest is the shipped bytes or bound to them: no signature service is needed. A platform image
// passes when its provenance names it as the subject and oll4com/spaceapp's release workflow on main as the builder;
// the run and the public commit that built it are returned as evidence. The release (verify-published-containers.mjs)
// and the launcher at install time run this same check.
export const RELEASE_REPOSITORY = "oll4com/spaceapp";
export const RELEASE_WORKFLOW_REF = `${RELEASE_REPOSITORY}/.github/workflows/release.yml@refs/heads/main`;
const SBOM_PREDICATE = "https://spdx.dev/Document";
const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
const REGISTRY = "https://ghcr.io";
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json"
].join(",");
const MAX_OBJECT_BYTES = 4 * 1024 * 1024;

const isAttestationOf = (entry, digest) =>
  entry?.annotations?.["vnd.docker.reference.type"] === "attestation-manifest" &&
  (digest === undefined || entry?.annotations?.["vnd.docker.reference.digest"] === digest);

/**
 * Checks one image index: every required linux platform (default: every one it lists) has an SBOM and a provenance
 * statement about that platform image, built by the release workflow, from `workflowSha` when given.
 */
export function evaluateImageAttestations({ image, index, attestations, architectures, workflowSha }) {
  const blockers = [];
  const platforms = {};
  const manifests = Array.isArray(index?.manifests) ? index.manifests : [];
  const required = architectures ?? manifests.filter((entry) => entry?.platform?.os === "linux").map((entry) => entry.platform.architecture);
  if (required.length === 0) blockers.push(`${image} lists no linux image.`);
  for (const architecture of required) {
    const platformManifest = manifests.find((entry) => entry?.platform?.os === "linux" && entry?.platform?.architecture === architecture);
    if (!platformManifest) {
      blockers.push(`${image} is missing linux/${architecture}.`);
      continue;
    }
    const matching = (Array.isArray(attestations) ? attestations : []).filter((entry) => isAttestationOf(entry?.descriptor, platformManifest.digest));
    const predicates = new Set(matching.flatMap((entry) => Array.isArray(entry?.manifest?.layers) ? entry.manifest.layers : [])
      .map((layer) => layer?.annotations?.["in-toto.io/predicate-type"]));
    if (!predicates.has(SBOM_PREDICATE)) blockers.push(`${image} does not expose an SBOM for linux/${architecture}.`);
    if (!predicates.has(PROVENANCE_PREDICATE)) {
      blockers.push(`${image} does not expose provenance for linux/${architecture}.`);
      continue;
    }
    const statement = matching.flatMap((entry) => Array.isArray(entry?.provenance) ? entry.provenance : []).find((candidate) =>
      candidate?.predicateType === PROVENANCE_PREDICATE &&
      (Array.isArray(candidate.subject) ? candidate.subject : []).some((subject) => `sha256:${subject?.digest?.sha256}` === platformManifest.digest));
    if (!statement) {
      blockers.push(`${image} has no provenance about its linux/${architecture} image ${platformManifest.digest}.`);
      continue;
    }
    const github = statement.predicate?.buildDefinition?.internalParameters ?? {};
    const builder = statement.predicate?.runDetails?.builder?.id;
    if (
      github.github_repository !== RELEASE_REPOSITORY ||
      github.github_workflow_ref !== RELEASE_WORKFLOW_REF ||
      !/^\d+$/.test(String(github.github_run_id ?? "")) ||
      typeof builder !== "string" ||
      !builder.startsWith(`https://github.com/${RELEASE_REPOSITORY}/actions/runs/${github.github_run_id}/`)
    ) {
      blockers.push(`${image} linux/${architecture} was not built by ${RELEASE_WORKFLOW_REF}.`);
    } else if (!/^[0-9a-f]{40}$/.test(String(github.github_workflow_sha ?? ""))) {
      blockers.push(`${image} linux/${architecture} provenance names no source commit.`);
    } else if (workflowSha && github.github_workflow_sha !== workflowSha) {
      blockers.push(`${image} linux/${architecture} was built from ${github.github_workflow_sha}, not ${workflowSha}.`);
    } else {
      platforms[architecture] = { digest: platformManifest.digest, runId: String(github.github_run_id), workflowSha: github.github_workflow_sha };
    }
  }
  return { ok: blockers.length === 0, blockers, platforms };
}

/**
 * Reads an image index (by digest or tag) and its attestation manifests and provenance statements from ghcr.io with an
 * anonymous pull token, through registry-https.mjs (proxy-aware). Every object is hashed; one read by digest that does
 * not hash to it is refused. A network failure or a 5xx/429 answer is a RegistryUnreachableError.
 */
export async function loadImageAttestations(repository, reference, { get = httpsGet } = {}) {
  // ghcr.io sends blobs to its storage host with a redirect; the token goes to ghcr.io only.
  const request = async (url, headers) => {
    for (let hop = 0; hop < 5; hop += 1) {
      const response = await get(url, { headers, maxBytes: MAX_OBJECT_BYTES });
      if (response.status < 300 || response.status >= 400 || !response.location) return response;
      const next = new URL(response.location, url);
      if (next.protocol !== "https:") throw new Error(`ghcr.io redirected ${repository} to ${next.protocol} ${next.host}.`);
      if (next.host !== new URL(url).host) headers = { Accept: headers.Accept };
      url = next.href;
    }
    throw new Error(`ghcr.io redirected ${repository} too often.`);
  };
  const answer = (response, what) => {
    if (response.status === 429 || response.status >= 500) throw new RegistryUnreachableError(`ghcr.io answered HTTP ${response.status} for ${what}`);
    if (response.status !== 200) throw new Error(`ghcr.io answered HTTP ${response.status} for ${what}.`);
    return response.body;
  };
  const { token } = JSON.parse(answer(await request(`${REGISTRY}/token?scope=repository:${repository}:pull`, {}), `a read token for ${repository}`).toString("utf8"));
  const read = async (kind, ref) => {
    const bytes = answer(await request(`${REGISTRY}/v2/${repository}/${kind}/${ref}`, { Authorization: `Bearer ${token}`, Accept: MANIFEST_TYPES }), `${repository} ${ref}`);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (ref.startsWith("sha256:") && digest !== ref) throw new Error(`${repository}@${ref} does not match its digest.`);
    return { digest, json: JSON.parse(bytes.toString("utf8")) };
  };
  const { digest, json: index } = await read("manifests", reference);
  const attestations = [];
  for (const descriptor of Array.isArray(index?.manifests) ? index.manifests : []) {
    if (!isAttestationOf(descriptor) || typeof descriptor.digest !== "string") continue;
    const { json: manifest } = await read("manifests", descriptor.digest);
    const provenance = [];
    for (const layer of Array.isArray(manifest?.layers) ? manifest.layers : []) {
      if (layer?.annotations?.["in-toto.io/predicate-type"] === PROVENANCE_PREDICATE) provenance.push((await read("blobs", layer.digest)).json);
    }
    attestations.push({ descriptor, manifest, provenance });
  }
  return { digest, index, attestations };
}

/** SPACEAPP_IMAGE_VERIFY=off: the opt-out for air-gapped or locked-down hosts; the launcher warns on every run. */
export const imageVerificationOff = (env = process.env) => String(env.SPACEAPP_IMAGE_VERIFY ?? "").trim().toLowerCase() === "off";
export const IMAGE_VERIFY_OFF_WARNING =
  "WARNING: SPACEAPP_IMAGE_VERIFY=off: SpaceApp does not check the provenance of its images before using them. " +
  "Unset it as soon as this host can reach ghcr.io, directly or through HTTPS_PROXY or the proxies in ~/.docker/config.json.\n";

/**
 * Install-time check of a package's image lock: each SpaceApp image must pass evaluateImageAttestations for every
 * platform its index lists. Returns the evidence an installation records (image-attestations.json). Any failed check
 * stops it; only when nothing failed but ghcr.io could not be reached does the error name the proxy settings and the
 * opt-out (RegistryUnreachableError).
 */
export async function verifyLockedImages(lock, { load = loadImageAttestations, now = () => new Date() } = {}) {
  const images = {};
  const blockers = [];
  const unreachable = [];
  for (const target of IMAGE_TARGETS) {
    const repository = `${RELEASE_REPOSITORY}-${target}`;
    const image = `ghcr.io/${repository}@${lock.images[target]}`;
    let result;
    try {
      result = evaluateImageAttestations({ image, ...await load(repository, lock.images[target]) });
    } catch (error) {
      const line = `${image}: ${error instanceof Error ? error.message : String(error)}`;
      if (error instanceof RegistryUnreachableError) {
        unreachable.push(line);
        continue;
      }
      result = { ok: false, blockers: [line] };
    }
    if (result.ok) images[target] = { index: lock.images[target], platforms: result.platforms };
    else blockers.push(...result.blockers);
  }
  if (blockers.length > 0) {
    throw new Error(`SpaceApp ${lock.runtimeVersion} images could not be verified, so none of them was pulled: ${blockers.join(" ")}`);
  }
  if (unreachable.length > 0) {
    throw new RegistryUnreachableError(
      `SpaceApp could not reach ghcr.io to verify its ${lock.runtimeVersion} images, so none of them was pulled (${unreachable.join(" ")}). ` +
      "If this host reaches the internet through a proxy, set HTTPS_PROXY (with NO_PROXY not covering ghcr.io or " +
      "pkg-containers.githubusercontent.com), or proxies.default.httpsProxy in ~/.docker/config.json, and run the command again. " +
      "On an air-gapped or locked-down host, SPACEAPP_IMAGE_VERIFY=off skips this check (a warning is printed on every run)."
    );
  }
  return { runtimeVersion: lock.runtimeVersion, verifiedAt: now().toISOString(), images };
}
