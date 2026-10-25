import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import {
  readOwnerPassword,
  resetOwnerPassword
} from "../reset-owner-password.mjs";

function capture() {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      }
    }),
    value: () => value
  };
}

test("owner password input is bounded and accepted only through stdin", async () => {
  await assert.rejects(
    () => readOwnerPassword(Readable.from(["short\n"])),
    /6-500/
  );
  assert.equal(
    await readOwnerPassword(Readable.from(["abc123\n"])),
    "abc123"
  );
});

test("owner password reset stores only the derived hash and closes the database client", async () => {
  const rawPassword = "correct horse battery staple";
  const stdout = capture();
  const calls = [];
  let connected = false;
  let ended = false;

  await resetOwnerPassword({
    env: { SPACE_DATABASE_URL: "postgresql://spaceapp.invalid/spaceapp" },
    stdin: Readable.from([`${rawPassword}\n`]),
    stdout: stdout.stream,
    hashPassword: async (password) => {
      assert.equal(password, rawPassword);
      return "scrypt$derived-password-hash";
    },
    createClient: (connectionString) => {
      assert.equal(connectionString, "postgresql://spaceapp.invalid/spaceapp");
      return {
        async connect() {
          connected = true;
        },
        async query(sql, values) {
          calls.push({ sql, values });
          return { rowCount: 1 };
        },
        async end() {
          ended = true;
        }
      };
    }
  });

  assert.equal(connected, true);
  assert.equal(ended, true);
  assert.deepEqual(calls[0].values, ["scrypt$derived-password-hash"]);
  assert.doesNotMatch(calls[0].sql, new RegExp(rawPassword));
  assert.doesNotMatch(stdout.value(), new RegExp(rawPassword));
  assert.match(stdout.value(), /updated/);
});

test("owner password reset reads the file-backed database URL used by container exec", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-owner-reset-"));
  const databaseUrlFile = join(root, "database-url");
  await writeFile(databaseUrlFile, "postgresql://spaceapp.invalid/spaceapp\n", { mode: 0o400 });

  try {
    await resetOwnerPassword({
      env: { SPACE_DATABASE_URL_FILE: databaseUrlFile },
      stdin: Readable.from(["another correct horse battery\n"]),
      stdout: capture().stream,
      hashPassword: async () => "scrypt$file-backed-password-hash",
      createClient: (connectionString) => {
        assert.equal(connectionString, "postgresql://spaceapp.invalid/spaceapp");
        return {
          async connect() {},
          async query() {
            return { rowCount: 1 };
          },
          async end() {}
        };
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
