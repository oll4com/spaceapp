import assert from "node:assert/strict";
import test from "node:test";
import {
  containerImageSizeBudgets,
  evaluateContainerImageSize
} from "../container-image-size-budget.mjs";

const mebibyte = 1024 * 1024;

test("public container size budgets preserve the per-service uncompressed sizes with headroom", () => {
  assert.deepEqual(containerImageSizeBudgets, {
    core: 800 * mebibyte,
    browser: 1300 * mebibyte,
    cli: 900 * mebibyte
  });
});

test("per-service budgets stay under the #64 release ceilings", () => {
  const ceilings = { core: 850, browser: 1350, cli: 1000 };
  for (const [target, ceiling] of Object.entries(ceilings)) {
    assert.ok(
      containerImageSizeBudgets[target] <= ceiling * mebibyte,
      target + " budget exceeds the " + ceiling + " MiB ceiling"
    );
  }
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
