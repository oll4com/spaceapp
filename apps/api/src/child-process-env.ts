// Space's own credentials never reach child processes: an agent CLI, a demo project or a browser that
// read SPACE_SESSION_SECRET or the database URL could mint ADMIN sessions (review F8/F20, 2026-10-14).
// Variables that only name a file (..._FILE) stay; third-party provider keys stay for the tools that use them.
const spaceCredential = /^SPACE_\w*(?:SECRET|TOKEN|PASSWORD)$|^SPACE_DATABASE_URL$|^SPACE_MCP_SERVERS_JSON$/;

export function childProcessEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !spaceCredential.test(name)));
}
