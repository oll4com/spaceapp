import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { readDatabaseUrl } from "./portable-backup.mjs";

const maxSetupTokenLength = 500;
const maxStdinBytes = 4 * 1024;
const setupTokenTtlMs = 15 * 60 * 1000;

export async function readOwnerSetupToken(stdin) {
  let value = "";
  for await (const chunk of stdin) {
    value += chunk.toString();
    if (Buffer.byteLength(value, "utf8") > maxStdinBytes) {
      throw new Error("Owner setup token input is too large.");
    }
  }
  const token = value.replace(/[\r\n]+$/, "");
  if (token.length < 32 || token.length > maxSetupTokenLength || /[\0\r\n]/.test(token)) {
    throw new Error("Owner setup token must be 32-500 characters without line breaks.");
  }
  return token;
}

export async function rotateOwnerSetupToken({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  now = new Date(),
  createClient = (connectionString) => new pg.Client({ connectionString })
} = {}) {
  const connectionString = await readDatabaseUrl(env);
  const token = await readOwnerSetupToken(stdin);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(now.getTime() + setupTokenTtlMs).toISOString();
  const client = createClient(connectionString);
  await client.connect();
  try {
    const result = await client.query(
      `
        INSERT INTO space_owner_setup (
          singleton,
          setup_token_hash,
          setup_token_expires_at,
          updated_at
        )
        VALUES (true, $1, $2, now())
        ON CONFLICT (singleton)
        DO UPDATE SET
          setup_token_hash = EXCLUDED.setup_token_hash,
          setup_token_expires_at = EXCLUDED.setup_token_expires_at,
          updated_at = now()
        WHERE space_owner_setup.owner_user_id IS NULL
        RETURNING singleton
      `,
      [tokenHash, expiresAt]
    );
    if (result.rowCount !== 1) {
      throw new Error("SpaceApp owner setup is already claimed.");
    }
  } finally {
    await client.end();
  }
  stdout.write(`SpaceApp owner setup token rotated; expires at ${expiresAt}.\n`);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  await rotateOwnerSetupToken().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Owner setup token rotation failed."}\n`);
    process.exitCode = 1;
  });
}
