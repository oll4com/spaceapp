#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const mebibyte = 1024 * 1024;

// 2026-10-16, per-service trees, uncompressed layers after rootfs unpacking:
// linux/amd64: core 815.7 MiB, browser 1139.4 MiB, cli 798.7 MiB.
// linux/arm64: core 847.5 MiB, browser 1169.2 MiB, cli 664.1 MiB.
// Keep small margins within #64's ceilings. Core arm64 has only 2.5 MiB spare;
// the two-architecture gate must catch growth rather than hiding it in .Size.
export const containerImageSizeBudgets = Object.freeze({
  core: 850 * mebibyte,
  browser: 1200 * mebibyte,
  cli: 825 * mebibyte
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

export function inspectContainerImageSize(image, execute = execFileSync) {
  const docker = (args) => execute("docker", args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"]
  }).trim();
  const metadata = JSON.parse(docker(["image", "inspect", "--format", "{{json .}}", image]));
  // Pin the measurement if another process retags the supplied image name.
  const imageId = metadata.Id;
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("Docker returned an invalid image ID");
  // The containerd store lazily unpacks foreign-platform images: even history
  // reports zero for their application layers until a rootfs is materialized.
  // Creating a stopped, exclusively owned container forces unpacking without
  // executing any image code. Remove that container and its anonymous volumes.
  const container = docker(["create", "--platform", `${metadata.Os}/${metadata.Architecture}`,
    "--label", "spaceapp.image-size-probe=true", "--entrypoint", "/bin/true", imageId]);
  try {
    const history = docker(["image", "history", "--no-trunc", "--human=false", "--format", "{{.Size}}", imageId]);
    return uncompressedContainerImageSize(metadata.Size, history);
  } finally {
    docker(["rm", "--volumes", container]);
  }
}

export function uncompressedContainerImageSize(inspected, history) {
  const parseBytes = (value) => {
    if (!/^\d+$/.test(value)) throw new Error(`Invalid Docker image byte count: ${value}`);
    const bytes = Number(value);
    if (!Number.isSafeInteger(bytes)) throw new Error("Docker image byte count exceeds the safe integer range");
    return bytes;
  };
  const inspectBytes = parseBytes(String(inspected).trim());
  const layers = String(history).trim().split(/\r?\n/).map(parseBytes);
  const historyBytes = layers.reduce((sum, layer) => sum + layer, 0);
  if (!Number.isSafeInteger(historyBytes)) throw new Error("Docker image layer total exceeds the safe integer range");
  // The containerd image store can report compressed content in inspect.Size.
  // History with --human=false counts the uncompressed layers, including files
  // deleted by later layers. Keep the larger measurement on either image store.
  return Math.max(inspectBytes, historyBytes);
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
