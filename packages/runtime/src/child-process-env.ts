// Remove Space credentials before launching children that do not need them. A child with the session
// secret or database URL could mint ADMIN sessions (review F8/F20, 2026-10-14).
// Variables that only name a file (..._FILE) stay; third-party provider keys stay for the tools that use them.
const spaceCredential = /^SPACE_\w*(?:SECRET|TOKEN|PASSWORD)$|^SPACE_DATABASE_URL$|^SPACE_MCP_SERVERS_JSON$/;

export function childProcessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => !spaceCredential.test(name)));
}
