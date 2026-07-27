import process from "node:process";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { readDatabaseUrl } from "./portable-backup.mjs";

const maxPasswordLength = 500;
const maxStdinBytes = 4 * 1024;

export async function readOwnerPassword(stdin) {
  let value = "";
  for await (const chunk of stdin) {
    value += chunk.toString();
    if (Buffer.byteLength(value, "utf8") > maxStdinBytes) {
      throw new Error("Owner password input is too large.");
    }
  }
  const password = value.replace(/[\r\n]+$/, "");
  if (password.length < 6 || password.length > maxPasswordLength || /[\0\r\n]/.test(password)) {
    throw new Error("Owner password must be 6-500 characters without line breaks.");
  }
  return password;
}

export async function resetOwnerPassword({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  createClient = (connectionString) => new pg.Client({ connectionString }),
  hashPassword = defaultHashPassword
} = {}) {
  const connectionString = await readDatabaseUrl(env);

  const password = await readOwnerPassword(stdin);
  const passwordHash = await hashPassword(password);
  const client = createClient(connectionString);
  await client.connect();
  try {
    const result = await client.query(
      `
        UPDATE users
        SET password_hash = $1, updated_at = now()
        WHERE id = (
          SELECT owner_user_id
          FROM space_owner_setup
          WHERE singleton = true
        )
        RETURNING id
      `,
      [passwordHash]
    );
    if (result.rowCount !== 1) {
      throw new Error("SpaceApp owner setup has not been claimed.");
    }
  } finally {
    await client.end();
  }
  stdout.write("SpaceApp owner password updated.\n");
}

async function defaultHashPassword(password) {
  const { hashPassword } = await import("../apps/api/dist/auth.js");
  return hashPassword(password);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  await resetOwnerPassword().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Owner password reset failed."}\n`);
    process.exitCode = 1;
  });
}
