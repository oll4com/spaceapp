import { describeApiConfiguration, validateApiConfiguration } from "./config-registry.js";

const mode = process.argv[2] ?? "--defaults";
if (process.argv.length > 3 || !["--defaults", "--check"].includes(mode)) {
  process.stderr.write("Usage: config:reference [--defaults | --check]\n");
  process.exitCode = 2;
} else if (mode === "--check") {
  const issues = validateApiConfiguration(process.env);
  process.stdout.write(`${JSON.stringify({ scope: "api", valid: issues.length === 0, issues }, null, 2)}\n`);
  process.exitCode = issues.length === 0 ? 0 : 1;
} else {
  process.stdout.write(`${JSON.stringify({ scope: "api", fields: describeApiConfiguration() }, null, 2)}\n`);
}
