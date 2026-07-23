import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeWorkspaceName,
  stripTrailingLineEndings
} from "../src/string-utils.mjs";

test("normalizes workspace names in linear time without changing slug semantics", () => {
  assert.equal(normalizeWorkspaceName("  My  Project--One  "), "my-project--one");
  assert.equal(normalizeWorkspaceName("---"), "workspace");
  assert.equal(
    normalizeWorkspaceName(`${"!".repeat(250_000)}Project${"?".repeat(250_000)}`),
    "project"
  );
});

test("strips only trailing CR and LF characters from large values", () => {
  assert.equal(stripTrailingLineEndings("credential\r\n"), "credential");
  assert.equal(stripTrailingLineEndings("line\r\ninside"), "line\r\ninside");
  assert.equal(
    stripTrailingLineEndings(`${"a".repeat(250_000)}${"\r\n".repeat(250_000)}`),
    "a".repeat(250_000)
  );
});
