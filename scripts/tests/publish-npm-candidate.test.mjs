import assert from "node:assert/strict";
import test from "node:test";
import { publishCandidate } from "../publish-npm-candidate.mjs";

const identity = { version: "1.0.35", gitHead: "a".repeat(40), integrity: "sha512-YWJj", tag: "next" };
const metadata = { name: "run-spaceapp", version: identity.version, gitHead: identity.gitHead,
  dist: { integrity: identity.integrity, attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } } } };

function fixture(replies) {
  let publishes = 0, sleeps = 0;
  return {
    options: { ...identity, attempts: 3, log() {},
      query: async () => { const reply = replies.shift(); if (reply instanceof Error) throw reply; return reply; },
      publish: async () => { publishes++; }, sleep: async () => { sleeps++; } },
    counts: () => ({ publishes, sleeps })
  };
}

test("fresh publish waits for registry propagation without publishing twice", async () => {
  const f = fixture([null, null, {}, metadata, { next: identity.version }]);
  assert.equal((await publishCandidate(f.options)).published, true);
  assert.deepEqual(f.counts(), { publishes: 1, sleeps: 1 });
});

test("retry verifies the exact immutable artifact and never republishes", async () => {
  const f = fixture([metadata, metadata, { next: identity.version }]);
  assert.equal((await publishCandidate(f.options)).published, false);
  assert.deepEqual(f.counts(), { publishes: 0, sleeps: 0 });
});

test("existing mismatched commit or tarball fails closed before publication", async () => {
  for (const wrong of [{ ...metadata, gitHead: "b".repeat(40) },
    { ...metadata, dist: { ...metadata.dist, integrity: "sha512-b3RoZXI=" } }]) {
    const f = fixture([wrong]);
    await assert.rejects(publishCandidate(f.options), /differs/);
    assert.equal(f.counts().publishes, 0);
  }
});

test("an unavailable registry is not evidence that a version is absent", async () => {
  const f = fixture([new Error("HTTP 503")]);
  await assert.rejects(publishCandidate(f.options), /HTTP 503/);
  assert.equal(f.counts().publishes, 0);
});

test("wrong channel or missing provenance never produces a successful verification", async () => {
  for (const incomplete of [metadata, { ...metadata, dist: { integrity: identity.integrity } }]) {
    const f = fixture([incomplete, incomplete, { next: incomplete === metadata ? "1.0.34" : identity.version }]);
    f.options.attempts = 1;
    await assert.rejects(publishCandidate(f.options), /verification is incomplete/);
    assert.equal(f.counts().publishes, 0);
  }
});

test("verification retries temporary registry failures after publishing", async () => {
  const f = fixture([null, new Error("HTTP 503"), metadata, { next: identity.version }]);
  await publishCandidate(f.options);
  assert.deepEqual(f.counts(), { publishes: 1, sleeps: 1 });
});

test("publishing to latest is not permitted by the prerelease job", async () => {
  const f = fixture([]);
  await assert.rejects(publishCandidate({ ...f.options, tag: "latest" }), /Invalid/);
  assert.equal(f.counts().publishes, 0);
});
