import assert from "node:assert/strict";
import test from "node:test";
import {
  containerImageSizeBudgets,
  evaluateContainerImageSize,
  parseContainerImageSizeHistory
} from "../container-image-size-budget.mjs";

const mebibyte = 1024 * 1024;

test("size measurement sums unpacked history layers including zero-byte metadata", () => {
  assert.equal(parseContainerImageSizeHistory("0\r\n1048576\r\n2097152\r\n"), 3 * mebibyte);
  for (const output of ["", "1.5MB", "-1", "1\nNaN", "9007199254740992"]) {
    assert.throws(() => parseContainerImageSizeHistory(output));
  }
});

test("public container size budgets preserve the lightweight release ceilings", () => {
  assert.deepEqual(containerImageSizeBudgets, {
    core: 750 * mebibyte,
    browser: 1250 * mebibyte,
    cli: 750 * mebibyte
  });
});

test("container size budget accepts an image exactly at its target ceiling", () => {
  assert.deepEqual(
    evaluateContainerImageSize({
      target: "cli",
      sizeBytes: containerImageSizeBudgets.cli
    }),
    {
      target: "cli",
      sizeBytes: containerImageSizeBudgets.cli,
      budgetBytes: containerImageSizeBudgets.cli,
      remainingBytes: 0,
      ok: true
    }
  );
});

test("container size budget blocks an image one byte over its target ceiling", () => {
  const sizeBytes = containerImageSizeBudgets.core + 1;

  assert.deepEqual(evaluateContainerImageSize({ target: "core", sizeBytes }), {
    target: "core",
    sizeBytes,
    budgetBytes: containerImageSizeBudgets.core,
    remainingBytes: -1,
    ok: false
  });
});

test("container size budget rejects unknown targets", () => {
  assert.throws(
    () => evaluateContainerImageSize({ target: "unknown", sizeBytes: 1 }),
    /Unknown container target/
  );
});
