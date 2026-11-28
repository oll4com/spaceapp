import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cellEgressRuleset, createCellHost, defaultRun } from "./cell-host.js";
import { cellProof, createCellRunnerServer } from "./cell-runner.js";
import { createFirecrackerCellDriver } from "./firecracker-cell-driver.js";

// space-cell-runner (plan clipboard:ZGz1LnD51ELH step 7): run as root on a cells host by deploy/space-cell-runner/space-cell-runner.service
// from a bundled copy (npm run build:cell-runner -w @space/api). The token arrives only as the systemd credential "token".
interface RunnerConfig {
  listen: { host: string; port: number };
  hubSubnets: string[];
  root: string;
  chrootBase: string;
  coldDir: string;
  exportDir: string;
  readyTimeoutMs?: number;
  egressBytesPerSecond?: number;
}
const config = JSON.parse(readFileSync(process.argv[2] ?? "/etc/space-cell-runner/config.json", "utf8")) as RunnerConfig;
const credentials = process.env.CREDENTIALS_DIRECTORY;
if (!credentials) throw new Error("space-cell-runner runs only under systemd with LoadCredential=token.");
const token = readFileSync(join(credentials, "token"), "utf8").trim();

// The host's egress rules go in before any cell can start, and again on every start (the ruleset replaces itself).
await defaultRun("nft", [cellEgressRuleset(config.hubSubnets)]);
const { listen, hubSubnets, ...paths } = config;
const host = createCellHost({ ...paths, hubSubnets, proof: (id) => cellProof(token, id) });
const server = createCellRunnerServer(createFirecrackerCellDriver({ host }), token);
server.listen(listen.port, listen.host, () => console.log(`space-cell-runner listening on ${listen.host}:${listen.port}`));
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
