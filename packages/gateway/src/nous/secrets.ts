import { readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { gcpKmsDecrypter } from "./kms.js";

/**
 * Boot-time secrets of the Nous Gateway (plan clipboard:_0qBSFCftZuD step 4, K5-secrets; install plan §5 "Secrets in env", runbook I-2.9):
 * a secret is stored only KMS-wrapped (`gcloud kms encrypt`) and unwrapped at boot into memory-backed storage (tmpfs or ramfs), never
 * onto disk, mode 0400, replaced atomically. The pgBackRest S3 key pair and cipher pass are one env file this way. The host proves itself
 * to KMS with its X.509 workload identity, as for the credential key (kms.ts).
 * `NGW_KMS_KEY_NAME=<secrets key> GOOGLE_APPLICATION_CREDENTIALS=/etc/ngw/kms/wif.json node packages/gateway/dist/nous/secrets.js <wrapped file> <file in tmpfs>`
 */
const MEMORY_FILESYSTEMS = new Set([0x01021994, 0x858458f6]); // tmpfs, ramfs (statfs f_type)

export async function unwrapSecretToFile(options: { wrappedFile: string; outputFile: string; decrypt: (ciphertext: Buffer) => Promise<Buffer>;
  filesystemType?: (directory: string) => Promise<number> }) {
  const directory = dirname(resolve(options.outputFile));
  const type = await (options.filesystemType ?? (async (path) => (await statfs(path)).type))(directory);
  if (!MEMORY_FILESYSTEMS.has(type)) throw new Error(`${directory} is not tmpfs or ramfs; a secret is never written to disk.`);
  const plaintext = await options.decrypt(await readFile(options.wrappedFile));
  const temporary = `${options.outputFile}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, plaintext, { mode: 0o400, flag: "wx" });
    await rename(temporary, options.outputFile);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    plaintext.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [wrappedFile, outputFile] = process.argv.slice(2);
  const keyName = process.env.NGW_KMS_KEY_NAME, credentialConfigFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!wrappedFile || !outputFile || !keyName || !credentialConfigFile) {
    throw new Error("Usage: NGW_KMS_KEY_NAME=... GOOGLE_APPLICATION_CREDENTIALS=... secrets.js <wrapped file> <output file in tmpfs>");
  }
  await unwrapSecretToFile({ wrappedFile, outputFile, decrypt: gcpKmsDecrypter({ keyName, credentialConfigFile }) });
}
