// The host paths this Space installation is built for (EXT-C-F18 R1). Source files take them from here instead of
// writing the path, so the public export rewrites this one file and the files that import it export byte-identical.
// Same values on every instance: nothing reads a setting yet. scripts/tests/host-paths.test.mjs keeps the converted
// packages free of the literals.

/** Where Space is installed: bin, secrets, var and the default room project. */
export const SPACE_INSTALL_ROOT = "/opt/spaceapp";
/** The home of the user the CLI panes and agents run as (its .codex, skills and plugins). */
export const SPACE_AGENT_HOME = "/var/lib/spaceapp-user";
/** Where Space Memory and the agent guidance documents live. */
export const SPACE_DOCS_ROOT = "/opt/spaceapp/docs";
/** The user the CLI panes and agents run as (sudo -u, the parity wrappers); its home is SPACE_AGENT_HOME. */
export const SPACE_AGENT_USER = "spaceapp-user";
