import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createVaultBroker, createVaultBrokerHttpServer, vaultBrokerSocketsPosture } from "./vault/broker-server.js";

// space-vault-broker (ADR-012): started by deploy/space-vault-broker.service from a root-owned bundled copy
// (npm run build:vault-broker -w @space/api). The ARK arrives only as the systemd credential "ark".
const credentials = process.env.CREDENTIALS_DIRECTORY;
if (!credentials) throw new Error("space-vault-broker runs only under systemd with LoadCredentialEncrypted=ark.");
const ark = readFileSync(join(credentials, "ark"));
const broker = await createVaultBroker({ ark: new Uint8Array(ark), stateDir: process.env.STATE_DIRECTORY ?? "/var/lib/space-vault-broker" });
ark.fill(0);
// Socket activation: systemd passes the API socket and the Browser Host socket (H2 Option A), named api and host, from fd 3.
const names = (process.env.LISTEN_FDNAMES ?? "").split(":");
if (process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== "2" || !names.includes("api") || !names.includes("host")) {
  throw new Error("space-vault-broker needs its systemd sockets (space-vault-broker.socket and space-vault-broker-host.socket).");
}
const servers = (["api", "host"] as const).map((channel) => {
  const server = createVaultBrokerHttpServer(broker, channel);
  server.listen({ fd: 3 + names.indexOf(channel) });
  return server;
});
// M1 (Option B): a socket with another owner, group or mode, or in a writable directory, means the access control is gone.
const posture = vaultBrokerSocketsPosture();
if (!posture.ok) {
  console.error(`space-vault-broker: socket posture ${posture.reason}; refusing to serve.`);
  process.exit(1);
}
const stop = () => { let open = servers.length; for (const server of servers) server.close(() => { open -= 1; if (open === 0) process.exit(0); }); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
