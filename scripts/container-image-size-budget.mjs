#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const mebibyte = 1024 * 1024;

// 1.1.3 raised core and browser (998.7 / 1670.6 MiB measured): the current
// application adds production dependencies pdfjs-dist with @napi-rs/canvas
// (81 MiB, API PDF handling), typescript (23 MiB, peer of @t3-oss/env-core) and
// js-tiktoken (22 MiB, Space Gateway token counting).
// 1.1.5 raised core again: linux/arm64 measured 1066.9 MiB and linux/amd64 1045.0 MiB (sqlite3 in the image,
// the 1.1.5 application); the first public release run failed the arm64 build at 1050 MiB.
// 1.1.7 lowered all three to the per-target closures (each image installs only the workspaces it runs). Measured on
// 2026-10-22 by the container workflow (run 39783691420) on both architectures, as `docker image inspect .Size`
// reports them: core 793.0 / 824.9 MiB, browser 1237.1 / 1261.8 MiB, cli 839.8 / 669.4 MiB (amd64 / arm64); the
// browser figures include the Xvfb package set its headed sessions need.
// Each budget is the larger architecture plus about 6 %, rounded up, and never above the ceilings the per-service
// images were asked to meet: core 850, browser 1350, cli 1000 MiB.
export const containerImageSizeBudgets = Object.freeze({
  core: 850 * mebibyte,
  browser: 1334 * mebibyte,
  cli: 891 * mebibyte
});

/**
 * Compares an image size with its target's budget.
 * @param {{ target: 'core' | 'browser' | 'cli', sizeBytes: number }} options
 * @returns {{ target: string, sizeBytes: number, budgetBytes: number, remainingBytes: number, ok: boolean }}
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
 * The value following a `--name` option, or undefined.
 * @param {string[]} args
 * @param {string} name
 * @returns {string | undefined}
 */
function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/**
 * Formats a byte count as MiB with one decimal.
 * @param {number} bytes
 * @returns {string}
 */
function formatMebibytes(bytes) {
  return `${(bytes / mebibyte).toFixed(1)} MiB`;
}

/**
 * The size Docker reports for a local image (`docker image inspect --format '{{.Size}}'`).
 * @param {string} image
 * @returns {number} bytes
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
 * The command-line entry: measures `--image` and enforces the budget of `--target`, printing the summary
 * and throwing when the budget is exceeded.
 * @param {string[]} [args] defaults to the process arguments
 * @returns {ReturnType<typeof evaluateContainerImageSize>}
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
