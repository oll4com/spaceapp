import assert from "node:assert/strict";
import test from "node:test";
import {
  containerImageSizeBudgets,
  evaluateContainerImageSize,
  inspectContainerImageSize,
  uncompressedContainerImageSize
} from "../container-image-size-budget.mjs";

const mebibyte = 1024 * 1024;

function lazyImageStore(historyAfterUnpack) {
  const id = `sha256:${"a".repeat(64)}`;
  let unpacked = false;
  const state = { removed: false };
  state.execute = (_program, args) => {
    if (args[0] === "image" && args[1] === "inspect") {
      return JSON.stringify({ Id: id, Os: "linux", Architecture: "arm64", Size: 5279 });
    }
    if (args[0] === "create") { unpacked = true; return "owned-stopped-container\n"; }
    if (args[0] === "image" && args[1] === "history") return unpacked ? historyAfterUnpack : "0\n0";
    if (args[0] === "rm" && args.includes("owned-stopped-container")) { state.removed = true; return "owned-stopped-container\n"; }
    throw new Error(`Unexpected Docker operation: ${args.join(" ")}`);
  };
  return state;
}

test("foreign-platform lazy layers are measured only after rootfs unpacking without running image code", () => {
  const store = lazyImageStore("0\n4198400\n");
  assert.equal(inspectContainerImageSize("fixture:arm64", store.execute), 4198400);
  assert.equal(store.removed, true);
});

test("the owned size probe is removed even if layer metadata is invalid", () => {
  const store = lazyImageStore("invalid");
  assert.throws(() => inspectContainerImageSize("fixture:arm64", store.execute), /Invalid Docker image byte count/);
  assert.equal(store.removed, true);
});

test("container size measurement cannot pass on compressed containerd content alone", () => {
  assert.equal(uncompressedContainerImageSize("350", "600\n0\n500\n"), 1100);
  assert.equal(uncompressedContainerImageSize("1200", "600\n500"), 1200);
  assert.equal(uncompressedContainerImageSize("1100", "600\r\n0\r\n500"), 1100);
});

test("container size measurement rejects missing, human-readable or overflowing layer counts", () => {
  for (const [inspected, history] of [["", "1"], ["1", ""], ["1", "5MB"], ["1", "-1"], ["1", "9007199254740991\n1"]]) {
    assert.throws(() => uncompressedContainerImageSize(inspected, history), /byte count|layer total/);
  }
});

test("public container size budgets preserve the lightweight release ceilings", () => {
  assert.deepEqual(containerImageSizeBudgets, {
    core: 850 * mebibyte,
    browser: 1200 * mebibyte,
    cli: 825 * mebibyte
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
