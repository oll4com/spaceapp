#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const mebibyte = 1024 * 1024;

// Issue #64 per-service multi-stage targets ship only the code and dependencies each service runs.
// Measured with scripts/container-image-size-budget.mjs on both linux/amd64 and linux/arm64:
// - core: linux/amd64 measured 805.2 MiB and linux/arm64 822.4 MiB (enforced budget: 850 MiB, down from 1100 MiB).
// - browser: linux/amd64 measured 1290.5 MiB and linux/arm64 1315.8 MiB (enforced budget: 1350 MiB, down from 1750 MiB).
// - cli: linux/amd64 measured 910.4 MiB and linux/arm64 935.2 MiB (enforced budget: 1000 MiB, down from 2800 MiB).
export const containerImageSizeBudgets = Object.freeze({
  core: 850 * mebibyte,
  browser: 1350 * mebibyte,
  cli: 1000 * mebibyte
});

/**
 * Evaluates whether a container image size falls within its defined budget ceiling.
 * @param {object} input - Input options.
 * @param {string} input.target - Container target name (core, browser, cli).
 * @param {number} input.sizeBytes - Image size in bytes.
 * @returns {{ target: string, sizeBytes: number, budgetBytes: number, remainingBytes: number, ok: boolean }} Budget evaluation result.
 */
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

/**
 * Extracts a named option value from an argument array.
 * @param {string[]} args - Command line argument array.
 * @param {string} name - Option flag to look for.
 * @returns {string | undefined} Parsed value or undefined.
 */
function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/**
 * Formats a byte count into human-readable mebibytes.
 * @param {number} bytes - Number of bytes.
 * @returns {string} Formatted string in MiB.
 */
function formatMebibytes(bytes) {
  return `${(bytes / mebibyte).toFixed(1)} MiB`;
}

/**
 * Inspects the size of a local Docker container image in bytes.
 * @param {string} image - Container image tag or ID.
 * @returns {number} Size in bytes.
 */
export function inspectContainerImageSize(image) {
  const output = execFileSync(
    "docker",
    ["image", "inspect", "--format", "{{.Size}}", image],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  ).trim();
  return Number(output);
}

/**
 * Command-line entrypoint to validate a container image against its target budget.
 * @param {string[]} [args=process.argv.slice(2)] - Command line arguments.
 * @returns {{ target: string, sizeBytes: number, budgetBytes: number, remainingBytes: number, ok: boolean }} Result of evaluation.
 */
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
