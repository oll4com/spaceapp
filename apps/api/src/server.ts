import { createApp } from "./app.js";
import { getApiConfig } from "./config.js";
import { loadOwnerSetupBootstrap } from "./owner-setup.js";

const config = getApiConfig(process.env);
const setup = await loadOwnerSetupBootstrap(process.env);
const app = await createApp({ config, setup });

await app.listen({ host: config.host, port: config.port });
