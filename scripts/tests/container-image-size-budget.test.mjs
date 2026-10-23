import assert from "node:assert/strict";
import test from "node:test";

import {
  containerImageSizeBudgets,
  evaluateContainerImageSize
} from "../container-image-size-budget.mjs";

const mebibyte = 1024 * 1024;

test("public container size budgets preserve the lightweight release ceilings", () => {
  assert.deepEqual(containerImageSizeBudgets, {
    core: 850 * mebibyte,
    browser: 1350 * mebibyte,
    cli: 1000 * mebibyte
  });
});

test("container size budget accepts an image exactly at its target ceiling", () => {
  const result = evaluateContainerImageSize({
    target: "core",
    sizeBytes: 850 * mebibyte
  });

  assert.equal(result.ok, true);
  assert.equal(result.remainingBytes, 0);
});

test("container size budget blocks an image one byte over its target ceiling", () => {
  const result = evaluateContainerImageSize({
    target: "core",
    sizeBytes: 850 * mebibyte + 1
  });

  assert.equal(result.ok, false);
  assert.equal(result.remainingBytes, -1);
});

test("container size budget rejects unknown targets", () => {
  assert.throws(
    () => {
      evaluateContainerImageSize({ target: "unknown", sizeBytes: 100 });
    },
    { message: /Unknown container target "unknown"/ }
  );
});
