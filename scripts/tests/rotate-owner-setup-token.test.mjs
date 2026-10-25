import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import {
  readOwnerSetupToken,
  rotateOwnerSetupToken
} from "../rotate-owner-setup-token.mjs";

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

test("owner setup rotation token is bounded and accepted only through stdin", async () => {
  await assert.rejects(
    () => readOwnerSetupToken(Readable.from(["too-short\n"])),
    /32-500/
  );
  assert.equal(
    await readOwnerSetupToken(Readable.from([`${"a".repeat(48)}\n`])),
    "a".repeat(48)
  );
});

test("owner setup rotation stores only the token hash while the instance is unclaimed", async () => {
  const rawToken = "b".repeat(48);
  const stdout = capture();
  const calls = [];
  let ended = false;

  await rotateOwnerSetupToken({
    env: { SPACE_DATABASE_URL: "postgresql://spaceapp.invalid/spaceapp" },
    stdin: Readable.from([`${rawToken}\n`]),
    stdout: stdout.stream,
    now: new Date("2026-07-23T12:00:00.000Z"),
    createClient: () => ({
      async connect() {},
      async query(sql, values) {
        calls.push({ sql, values });
        return { rowCount: 1 };
      },
      async end() {
        ended = true;
      }
    })
  });

  assert.equal(ended, true);
  assert.match(calls[0].values[0], /^[a-f0-9]{64}$/);
  assert.notEqual(calls[0].values[0], rawToken);
  assert.equal(calls[0].values[1], "2026-07-23T12:15:00.000Z");
  assert.match(calls[0].sql, /ON CONFLICT \(singleton\)/);
  assert.match(calls[0].sql, /owner_user_id IS NULL/);
  assert.doesNotMatch(calls[0].sql, new RegExp(rawToken));
  assert.doesNotMatch(stdout.value(), new RegExp(rawToken));
});

test("owner setup rotation refuses to replace a claimed owner", async () => {
  let ended = false;
  await assert.rejects(
    () => rotateOwnerSetupToken({
      env: { SPACE_DATABASE_URL: "postgresql://spaceapp.invalid/spaceapp" },
      stdin: Readable.from([`${"c".repeat(48)}\n`]),
      stdout: capture().stream,
      createClient: () => ({
        async connect() {},
        async query() {
          return { rowCount: 0 };
        },
        async end() {
          ended = true;
        }
      })
    }),
    /already claimed/i
  );
  assert.equal(ended, true);
});
