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
    browser: 1334 * mebibyte,
    cli: 891 * mebibyte
  });
  // The ceilings the per-service image closures were asked to meet; a budget never climbs back above them.
  assert.ok(containerImageSizeBudgets.core <= 850 * mebibyte, "core budget within 850 MiB");
  assert.ok(containerImageSizeBudgets.browser <= 1350 * mebibyte, "browser budget within 1350 MiB");
  assert.ok(containerImageSizeBudgets.cli <= 1000 * mebibyte, "cli budget within 1000 MiB");
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
