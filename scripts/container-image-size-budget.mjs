#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const mebibyte = 1024 * 1024;

// #64 split the monolithic image into per-target production dependency
// closures, so each budget tracks only what its target runs. The budgets
// are UNCOMPRESSED image sizes: what `docker image inspect .Size` reports
// on the classic overlay2 store used by the containers.yml runners, which
// is where the budget step runs. Measured by the containers.yml matrix:
// linux/amd64 core 724.9 MiB, browser 1218.8 MiB, cli 758.2 MiB (the old
// monolithic image measured core 1045.0 MiB); linux/arm64 tracks amd64
// within ~25 MiB (browser 1242.9 MiB). Each budget keeps room for the
// arm64 delta and dependency growth, while staying under the ceilings from
// the issue: core 850 MiB, browser 1350 MiB, cli 1000 MiB.
// Caveat: docker hosts running the containerd image store (Docker Desktop;
// docker 29 with the containerd snapshotter) report the COMPRESSED size in
// `docker image inspect .Size`, roughly 2.5-3x smaller for these images
// (core ~252 MiB, browser ~446 MiB, cli ~261 MiB on the wire). The CI
// matrix numbers are authoritative for these budgets.
export const containerImageSizeBudgets = Object.freeze({
  core: 800 * mebibyte,
  browser: 1300 * mebibyte,
  cli: 900 * mebibyte
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
