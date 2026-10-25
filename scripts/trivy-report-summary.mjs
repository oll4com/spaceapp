#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];

export function buildTrivySummary(report, label) {
  const vulnerabilities = (report?.Results || [])
    .flatMap((result) => result?.Vulnerabilities || []);
  const rows = severities.map((severity) => {
    const matching = vulnerabilities.filter(
      (vulnerability) => (vulnerability?.Severity || "UNKNOWN") === severity
    );
    const fixable = matching.filter(
      (vulnerability) =>
        typeof vulnerability?.FixedVersion === "string" &&
        vulnerability.FixedVersion.trim() !== ""
    ).length;
    return { severity, fixable, unfixable: matching.length - fixable };
  });
  const fixableTotal = rows.reduce((total, row) => total + row.fixable, 0);
  const unfixableTotal = rows.reduce((total, row) => total + row.unfixable, 0);

  return [
    `### Trivy full report: ${label}`,
    "",
    "| Severity | Fixable | Unfixable |",
    "| --- | ---: | ---: |",
    ...rows.map(
      ({ severity, fixable, unfixable }) =>
        `| ${severity} | ${fixable} | ${unfixable} |`
    ),
    "",
    `**Total:** ${fixableTotal + unfixableTotal} (${fixableTotal} fixable, ${unfixableTotal} unfixable)`,
    ""
  ].join("\n");
}

function parseArgs(argv) {
  const options = { input: "", label: "" };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === "--input" && value) options.input = value;
    else if (name === "--label" && value) options.label = value;
    else {
      throw new Error(
        "Usage: trivy-report-summary.mjs --input <report.json> --label <name>"
      );
    }
  }
  if (!options.input || !options.label) {
    throw new Error(
      "Usage: trivy-report-summary.mjs --input <report.json> --label <name>"
    );
  }
  return options;
}

export async function runCli(argv) {
  const options = parseArgs(argv);
  const report = JSON.parse(await readFile(options.input, "utf8"));
  process.stdout.write(buildTrivySummary(report, options.label));
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  await runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Trivy summary failed."}\n`
    );
    process.exitCode = 1;
  });
}
