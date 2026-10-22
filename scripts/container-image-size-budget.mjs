#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const mebibyte = 1024 * 1024;

// Per-entrypoint deploy closures, 2026-10-22; unpacked layer totals in MiB:
// linux/amd64: core 658.0, browser 1131.0, cli 679.8.
// linux/arm64: core 686.5, browser 1160.9, cli 711.6.
// Both architectures must pass these ceilings and the real-process smoke checks.
export const containerImageSizeBudgets = Object.freeze({
  core: 750 * mebibyte,
  browser: 1250 * mebibyte,
  cli: 750 * mebibyte
});

export function evaluateContainerImageSize({ target, sizeBytes }) {
  const budgetBytes = containerImageSizeBudgets[target];
  if (budgetBytes === undefined) {
    throw new Error(`Unknown container target: ${target}`);
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error(`Invalid container image size: ${sizeBytes}`);
  }

  const remainingBytes = budgetBytes - sizeBytes;
  return {
    target,
    sizeBytes,
    budgetBytes,
    remainingBytes,
    ok: remainingBytes >= 0
  };
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function formatMebibytes(bytes) {
  return `${(bytes / mebibyte).toFixed(1)} MiB`;
}

export function inspectContainerImageSize(image) {
  const container = `spaceapp-size-${randomUUID()}`;
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] };
  // A cross-platform image can be loaded but not unpacked in containerd, in
  // which case even history reports content sizes. Creating (never starting)
  // a disposable container forces unpacking without executing image code.
  execFileSync("docker", ["create", "--pull=never", "--name", container, "--entrypoint", "/bin/true", image], options);
  try {
    const output = execFileSync("docker", ["image", "history", "--human=false", "--format", "{{.Size}}", image], options).trim();
    return parseContainerImageSizeHistory(output);
  } finally {
    execFileSync("docker", ["rm", "--volumes", container], options);
  }
}

// Older containerd-backed Docker versions report compressed content in image
// inspect's Size. History with --human=false gives integer unpacked layer sizes,
// including overwritten bytes in earlier layers, on both image stores.
export function parseContainerImageSizeHistory(output) {
  const rows = output.trim().split(/\r?\n/);
  if (rows.some((row) => !/^\d+$/.test(row))) {
    throw new Error("Docker image history did not return integer layer sizes");
  }
  const total = rows.reduce((sum, row) => sum + Number(row), 0);
  if (!Number.isSafeInteger(total)) throw new Error("Docker layer sizes exceed a safe integer");
  return total;
}

export function runContainerImageSizeBudget(args = process.argv.slice(2)) {
  const target = optionValue(args, "--target");
  const image = optionValue(args, "--image");
  if (!target || !image) {
    throw new Error(
      "Usage: container-image-size-budget.mjs --target <core|browser|cli> --image <name:tag>"
    );
  }

  const result = evaluateContainerImageSize({
    target,
    sizeBytes: inspectContainerImageSize(image)
  });
  const summary = [
    `${result.target} image ${image}: ${formatMebibytes(result.sizeBytes)}`,
    `budget ${formatMebibytes(result.budgetBytes)}`,
    `remaining ${formatMebibytes(result.remainingBytes)}`
  ].join("; ");
  if (!result.ok) {
    throw new Error(`Container image size budget exceeded: ${summary}`);
  }
  process.stdout.write(`${summary}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runContainerImageSizeBudget();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
