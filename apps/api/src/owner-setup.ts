import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

const setupTokenTtlMs = 15 * 60 * 1000;
const maxSetupTokenFileBytes = 4 * 1024;

export interface OwnerSetupBootstrap {
  tokenHash: string;
  expiresAt: string;
}

export function createOwnerSetupBootstrap(token: string, expiresAt: string): OwnerSetupBootstrap {
  if (token.length < 32 || token.length > 500 || /[\0\r\n]/.test(token)) {
    throw new Error("SpaceApp setup token must be 32-500 characters without line breaks.");
  }
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new Error("SpaceApp setup token expiry must be an ISO timestamp.");
  }
  return {
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt
  };
}

export async function loadOwnerSetupBootstrap(
  env: NodeJS.ProcessEnv,
  now = new Date()
): Promise<OwnerSetupBootstrap | null> {
  const tokenFile = env.SPACE_SETUP_TOKEN_FILE;
  if (!tokenFile) return null;

  const tokenFileStat = await stat(tokenFile);
  if (!tokenFileStat.isFile() || tokenFileStat.size > maxSetupTokenFileBytes) {
    throw new Error("SpaceApp setup token file must be a regular file no larger than 4 KiB.");
  }
  const token = (await readFile(tokenFile, "utf8")).replace(/[\r\n]+$/, "");
  return createOwnerSetupBootstrap(token, new Date(now.getTime() + setupTokenTtlMs).toISOString());
}
