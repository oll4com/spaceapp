import { fileURLToPath } from "node:url";
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
    throw new Error(`Unknown container target "${target}". Expected one of: core, browser, cli.`);
  }

  const numericSize = Number(sizeBytes);
  if (!Number.isFinite(numericSize) || numericSize < 0) {
    throw new Error(`Invalid image size ${sizeBytes}`);
  }

  const remainingBytes = budgetBytes - numericSize;
  return {
    target,
    sizeBytes: numericSize,
    budgetBytes,
    remainingBytes,
    ok: numericSize <= budgetBytes
  };
}

export function formatMebibytes(bytes) {
  return `${(bytes / mebibyte).toFixed(1)} MiB`;
}

function parseCliArguments(argv) {
  const options = {
    target: "",
    image: ""
  };

  for (let i = 2; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === "--target") {
      options.target = argv[i + 1] || "";
      i += 1;
    } else if (argument === "--image") {
      options.image = argv[i + 1] || "";
      i += 1;
    }
  }

  return options;
}

export async function runSizeBudgetCheck({ target, image, exec = null }) {
  if (!target || !image) {
    throw new Error("Usage: node scripts/container-image-size-budget.mjs --target <core|browser|cli> --image <image-ref>");
  }

  const execute =
    exec ||
    (async (command, arguments_) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      return promisify(execFile)(command, arguments_);
    });

  const { stdout } = await execute("docker", ["image", "inspect", image, "--format", "{{.Size}}"]);
  const sizeBytes = Number.parseInt(stdout.trim(), 10);
  const evaluation = evaluateContainerImageSize({ target, sizeBytes });

  const status = evaluation.ok ? "PASS" : "FAIL";
  console.log(
    `[container-size-budget] ${status}: target "${target}" image "${image}" is ${formatMebibytes(evaluation.sizeBytes)} (budget: ${formatMebibytes(evaluation.budgetBytes)}, remaining: ${formatMebibytes(evaluation.remainingBytes)})`
  );

  if (!evaluation.ok) {
    process.exitCode = 1;
  }

  return evaluation;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const cliOptions = parseCliArguments(process.argv);
    await runSizeBudgetCheck(cliOptions);
  } catch (error) {
    console.error(`[container-size-budget] ERROR: ${error.message}`);
    process.exit(1);
  }
}
