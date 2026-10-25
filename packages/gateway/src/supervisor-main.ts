import { fileURLToPath } from "node:url";
import { startSupervisor } from "./supervisor.js";

// systemd runs this file; the gateway itself runs as its cluster worker from the bundle next to it.
startSupervisor({ workerFile: fileURLToPath(new URL("./space-gateway.mjs", import.meta.url)) });
