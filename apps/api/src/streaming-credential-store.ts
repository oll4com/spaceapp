import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StreamingOAuthProvider, StreamingProviderReadiness } from "@space/contracts";

export interface StreamingProviderClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const providerFilename: Record<StreamingOAuthProvider, string> = {
  YOUTUBE: "youtube-client.json",
  TWITCH: "twitch-client.json",
  TIKTOK: "tiktok-client.json"
};

export const streamingProviderScopes: Record<StreamingOAuthProvider, string[]> = {
  YOUTUBE: [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly"
  ],
  TWITCH: ["moderator:read:followers", "channel:read:subscriptions"],
  TIKTOK: ["user.info.basic", "user.info.stats"]
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseClient(value: unknown): StreamingProviderClient {
  if (!isRecord(value)) throw new Error("Streaming provider client file must contain an object.");
  const clientId = typeof value.clientId === "string" ? value.clientId.trim() : "";
  const clientSecret = typeof value.clientSecret === "string" ? value.clientSecret.trim() : "";
  const redirectUri = typeof value.redirectUri === "string" ? value.redirectUri.trim() : "";
  if (!clientId || !clientSecret || !redirectUri || !URL.canParse(redirectUri)) {
    throw new Error("Streaming provider client file is incomplete.");
  }
  return { clientId, clientSecret, redirectUri };
}

function safeCredentialObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Streaming credential payload must contain an object.");
  return value;
}

function fileMode(mode: number): number {
  return mode & 0o777;
}

export class StreamingCredentialStore {
  private readonly credentialDirectory: string;

  constructor(readonly root: string) {
    if (!root.startsWith("/")) throw new Error("SPACE_STREAMING_SECRET_ROOT must be an absolute path.");
    this.credentialDirectory = join(root, "credentials");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await mkdir(this.credentialDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.credentialDirectory, 0o700);
  }

  clientPath(provider: StreamingOAuthProvider): string {
    return join(this.root, providerFilename[provider]);
  }

  async readiness(provider: StreamingOAuthProvider): Promise<StreamingProviderReadiness> {
    const path = this.clientPath(provider);
    let info;
    try {
      info = await stat(path);
    } catch {
      return {
        provider,
        status: "UNCONFIGURED",
        clientFilePresent: false,
        clientFileSecure: false,
        code: "CLIENT_FILE_MISSING",
        message: `${provider} OAuth client configuration is not installed.`,
        scopes: streamingProviderScopes[provider]
      };
    }
    const secure = info.isFile() && fileMode(info.mode) === 0o600;
    if (!secure) {
      return {
        provider,
        status: "ERROR",
        clientFilePresent: true,
        clientFileSecure: false,
        code: "CLIENT_FILE_PERMISSIONS",
        message: `${provider} OAuth client configuration must be a 0600 regular file.`,
        scopes: streamingProviderScopes[provider]
      };
    }
    try {
      await this.readClient(provider);
      return {
        provider,
        status: "READY",
        clientFilePresent: true,
        clientFileSecure: true,
        code: "READY",
        message: `${provider} OAuth client configuration is ready.`,
        scopes: streamingProviderScopes[provider]
      };
    } catch {
      return {
        provider,
        status: "ERROR",
        clientFilePresent: true,
        clientFileSecure: true,
        code: "CLIENT_FILE_INVALID",
        message: `${provider} OAuth client configuration is invalid.`,
        scopes: streamingProviderScopes[provider]
      };
    }
  }

  async readClient(provider: StreamingOAuthProvider): Promise<StreamingProviderClient> {
    const path = this.clientPath(provider);
    const info = await stat(path);
    if (!info.isFile() || fileMode(info.mode) !== 0o600) {
      throw new Error(`${provider} client file must be a 0600 regular file.`);
    }
    const raw = await readFile(path, { encoding: "utf8" });
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error(`${provider} client file is too large.`);
    return parseClient(JSON.parse(raw));
  }

  async writeCredential(credentialRef: string, payload: Record<string, unknown>): Promise<void> {
    await this.initialize();
    const finalPath = this.credentialPath(credentialRef);
    const temporaryPath = `${finalPath}.${randomBytes(8).toString("hex")}.tmp`;
    const serialized = `${JSON.stringify(safeCredentialObject(payload))}\n`;
    if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error("Streaming credential payload is too large.");
    await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, finalPath);
      await chmod(finalPath, 0o600);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async readCredential(credentialRef: string): Promise<Record<string, unknown>> {
    const path = this.credentialPath(credentialRef);
    const info = await stat(path);
    if (!info.isFile() || fileMode(info.mode) !== 0o600) {
      throw new Error("Streaming credential file permissions are invalid.");
    }
    const raw = await readFile(path, { encoding: "utf8" });
    if (Buffer.byteLength(raw) > 256 * 1024) throw new Error("Streaming credential payload is too large.");
    return safeCredentialObject(JSON.parse(raw));
  }

  async deleteCredential(credentialRef: string): Promise<void> {
    await unlink(this.credentialPath(credentialRef)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private credentialPath(credentialRef: string): string {
    if (!/^[A-Za-z0-9:_-]{8,200}$/.test(credentialRef)) throw new Error("Streaming credential reference is invalid.");
    const digest = createHash("sha256").update(credentialRef).digest("hex");
    return join(this.credentialDirectory, `${digest}.json`);
  }
}
