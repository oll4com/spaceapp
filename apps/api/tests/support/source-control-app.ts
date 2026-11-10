import { InMemorySpaceStore } from "@space/runtime";
import { InMemorySourceControlRepository } from "../../../../packages/db/src/source-control-repository.js";
import { createApp } from "../../src/app.js";
import { signSession, createCsrfToken } from "../../src/auth.js";
import { getApiConfig } from "../../src/config.js";
import { SourceControlService } from "../../src/source-control/service.js";
import { DemoCredentialStore } from "../../src/demo-projects/credentials.js";
import { join } from "node:path";

// An app with personal source control on fake providers and credentials under `root`, shared by the source-control route tests.
export const secret = "source-control-proof-session-secret";
export const headers = (owner: string, csrf = true, role: "ADMIN" | "USER" = "ADMIN") => {
  const session = signSession({ id: owner, email: `${owner.replace(":", "-")}@example.invalid`, role }, secret);
  return { cookie: `space_session=${session}`, ...(csrf ? { "x-space-csrf-token": createCsrfToken(session, secret)! } : {}) };
};
export async function sourceControlApp(root: string) {
  const sourceControlService = new SourceControlService({
    repository: new InMemorySourceControlRepository(), credentials: new DemoCredentialStore(join(root, "secrets")), credentialRoot: join(root, "secrets"),
    providerFactory: (_provider, _server, token) => ({
      identity: async () => { if (token !== "proof-token") throw new Error("invalid"); return { login: "proof", email: null }; },
      lookup: async () => { throw new Error("unused"); }, createRepository: async () => { throw new Error("unused"); }, list: async () => ({ data: [], nextPage: null, nextCursor: null }), targets: async () => ({ data: [], nextPage: null, nextCursor: null }),
      repositories: async () => [], repository: async () => { throw new Error("unavailable"); }, create: async () => { throw new Error("unavailable"); }, validateCloneUrl: async url => url
    })
  });
  const store = new InMemorySpaceStore();
  const app = await createApp({ store, sourceControlService, config: getApiConfig({}), auth: { sessionSecret: secret, devLogin: false, secureCookies: false } });
  return { app, store };
}
