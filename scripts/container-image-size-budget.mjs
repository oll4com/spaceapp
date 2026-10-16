#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const mebibyte = 1024 * 1024;

// Per-service images (scripts/stage-service-images.mjs) ended the
// one-size-fits-all layout in which every image carried the whole pruned
// monorepo: each target now ships only its own dependency closure, so the
// budgets are the per-service ceilings — core 850 MiB, browser 1350 MiB,
// cli 1000 MiB on both linux/amd64 and linux/arm64. Before this change the
// images measured core 1044.7 / 1066.9 MiB, browser 1719.9 / 1735.0 MiB and
// cli 1386.0 / 1237.1 MiB (amd64 / arm64). Historical notes: 1.1.3 raised
// core and browser (998.7 / 1670.6 MiB measured): the application added
// production dependencies pdfjs-dist with @napi-rs/canvas (81 MiB, API PDF
// handling), typescript (23 MiB, peer of @t3-oss/env-core) and js-tiktoken
// (22 MiB, Space Gateway token counting); the typescript peer no longer
// ships anywhere, because the staging closure expands only real
// dependencies. 1.1.5 raised core again: linux/arm64 measured 1066.9 MiB
// and linux/amd64 1045.0 MiB (sqlite3 in the image, the 1.1.5 application);
// the first public release run failed the arm64 build at 1050 MiB.
export const containerImageSizeBudgets = Object.freeze({
  core: 850 * mebibyte,
  browser: 1350 * mebibyte,
  cli: 1000 * mebibyte
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
  const output = execFileSync(
    "docker",
    ["image", "inspect", "--format", "{{.Size}}", image],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  ).trim();
  return Number(output);
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
