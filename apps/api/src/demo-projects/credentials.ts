import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const keyLengthBytes = 32;
const ivLengthBytes = 12;
const maximumPayloadBytes = 256 * 1024;

function fileMode(mode: number): number {
  return mode & 0o777;
}

/**
 * Encrypted credential storage for demo connectors. The master key lives in its
 * own 0600 file, payloads are AES-256-GCM ciphertext written atomically, and the
 * plaintext never leaves the API process.
 */
export class DemoCredentialStore {
  private readonly credentialDirectory: string;
  private cachedKey: Buffer | null = null;

  constructor(private readonly root: string) {
    if (!root.startsWith("/")) throw new Error("The demo credential root must be an absolute path.");
    this.credentialDirectory = join(root, "credentials");
  }

  private get keyPath(): string {
    return join(this.root, "master.key");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await mkdir(this.credentialDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.credentialDirectory, 0o700);
    await this.masterKey();
  }

  private async masterKey(): Promise<Buffer> {
    if (this.cachedKey) return this.cachedKey;
    try {
      const info = await stat(this.keyPath);
      if (!info.isFile() || fileMode(info.mode) !== 0o600) {
        throw new Error("The demo credential master key permissions are invalid.");
      }
      const raw = (await readFile(this.keyPath, "utf8")).trim();
      const key = Buffer.from(raw, "base64");
      if (key.length !== keyLengthBytes) throw new Error("The demo credential master key is invalid.");
      this.cachedKey = key;
      return key;
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing) throw error;
    }
    const key = randomBytes(keyLengthBytes);
    const temporaryPath = `${this.keyPath}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporaryPath, `${key.toString("base64")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.keyPath);
    await chmod(this.keyPath, 0o600);
    this.cachedKey = key;
    return key;
  }

  private credentialPath(reference: string): string {
    if (!/^[A-Za-z0-9:_-]{8,200}$/.test(reference)) throw new Error("The demo credential reference is invalid.");
    const digest = createHash("sha256").update(reference).digest("hex");
    return join(this.credentialDirectory, `${digest}.json`);
  }

  async write(reference: string, payload: Record<string, unknown>): Promise<void> {
    const key = await this.masterKey();
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) > maximumPayloadBytes) throw new Error("The demo credential payload is too large.");
    const iv = randomBytes(ivLengthBytes);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(serialized, "utf8"), cipher.final()]);
    const record = {
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64")
    };
    const finalPath = this.credentialPath(reference);
    const temporaryPath = `${finalPath}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, finalPath);
      await chmod(finalPath, 0o600);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async read(reference: string): Promise<Record<string, unknown>> {
    const key = await this.masterKey();
    const path = this.credentialPath(reference);
    const info = await stat(path);
    if (!info.isFile() || fileMode(info.mode) !== 0o600) {
      throw new Error("The demo credential file permissions are invalid.");
    }
    const raw = await readFile(path, { encoding: "utf8" });
    if (Buffer.byteLength(raw) > maximumPayloadBytes) throw new Error("The demo credential payload is too large.");
    const record = JSON.parse(raw) as { version?: unknown; iv?: unknown; tag?: unknown; data?: unknown };
    if (record.version !== 1 || typeof record.iv !== "string" || typeof record.tag !== "string" || typeof record.data !== "string") {
      throw new Error("The demo credential file is not readable.");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8")) as Record<string, unknown>;
  }

  async delete(reference: string): Promise<void> {
    await unlink(this.credentialPath(reference)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
