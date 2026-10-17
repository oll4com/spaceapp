import { isAbsolute, relative, resolve, sep, join } from "node:path";
import { resolveSpaceInstance } from "@space/contracts";

function privateInstallRoot(env: NodeJS.ProcessEnv): string {
  const configured = env.SPACE_INSTALL_ROOT;
  if (!configured || !isAbsolute(configured) || resolve(configured) === resolve("/opt/spaceapp")) {
    throw new Error("Dev service storage requires a private absolute SPACE_INSTALL_ROOT.");
  }
  return resolve(configured);
}

/** Keep installed defaults; a dev instance's mutable service data stays under its own install root. */
export function instanceStorageDirectory(
  name: "plugins" | "personal-source-control" | "live-voice-logs" | "live-personal-memory.json" | "agent-docx-work",
  override?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const installed = `/opt/spaceapp/var/${name}`;
  if (resolveSpaceInstance(env) !== "dev") return override || installed;
  const root = privateInstallRoot(env);
  if (override && !isAbsolute(override)) throw new Error("Dev service storage override must be absolute.");
  const target = resolve(override || join(root, "var", name));
  const inside = relative(root, target);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error("Dev service storage cannot escape its private SPACE_INSTALL_ROOT.");
  }
  return target;
}

/** Loader and save routes must agree; dev never probes the installed credential candidates. */
export function instanceSecretDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  return resolveSpaceInstance(env) === "dev"
    ? [join(privateInstallRoot(env), "secrets")]
    : ["/opt/spaceapp/secrets", "/var/lib/spaceapp"];
}
