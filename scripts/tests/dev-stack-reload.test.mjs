import test from "node:test";
import assert from "node:assert/strict";
import { changedApiSource, changedPackageSource, runApiReloadProof,
  assertOwnedLogInfo, createOwnedAppendLog, openOwnedAppendLog, readOwnedLog } from "../dev-stack-reload.mjs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apiMarker = `DEV_STACK_API_${"a".repeat(32)}`;
const packageMarker = `DEV_STACK_PACKAGE_${"b".repeat(32)}`;

test("API probe changes only the unique original live-route service literal", () => {
  const original = Buffer.from('service: "space-api";\nservice: "space-api",\n    uptimeSeconds: 1;\n');
  const snapshot = Buffer.from(original);
  const changed = changedApiSource(original, apiMarker).toString();
  assert.equal(changed, `service: "space-api";\nservice: "${apiMarker}",\n    uptimeSeconds: 1;\n`);
  assert.deepEqual(original, snapshot);
});

test("missing or ambiguous original API anchors fail instead of patching arbitrary source", () => {
  const source = Buffer.from('service: "space-api",\n    uptimeSeconds: 1;\n');
  assert.throws(() => changedApiSource(Buffer.from("not the original route"), apiMarker), /API_ANCHOR/u);
  assert.throws(() => changedApiSource(Buffer.concat([source, source]), apiMarker), /API_ANCHOR/u);
  assert.throws(() => changedApiSource(source, '"; throw new Error()'), /API_INPUT/u);
  assert.throws(() => changedApiSource(Buffer.from([0xff, 0xfe]), apiMarker), /API_ANCHOR/u);
});

test("package probe appends a fixed-shape nonce without replacing existing exports", () => {
  const original = Buffer.from('export * from "./original.js";\n');
  const changed = changedPackageSource(original, packageMarker);
  assert.ok(changed.subarray(0, original.length).equals(original));
  assert.ok(changed.toString().endsWith(`console.log("${packageMarker}");\n`));
  assert.throws(() => changedPackageSource(changed, packageMarker), /PACKAGE_SOURCE/u);
  assert.throws(() => changedPackageSource(original, "unsafe"), /PACKAGE_INPUT/u);
});

test("live source changes are refused outside the exact isolated CI checkout", async () => {
  await assert.rejects(runApiReloadProof({ state: { repoRoot: "/unowned", stateDir: "/unowned/.dev-stack" } }),
    /ISOLATED_CI_ONLY/u);
});

const info = overrides => ({ file: true, symlink: false, nlink: 1n, uid: 42n,
  mode: 0o100600n, size: 0n, ...overrides });
test("owned proof log rejects foreign UID, links, unsafe modes and unbounded size", () => {
  assert.doesNotThrow(() => assertOwnedLogInfo(info(), 42n));
  for (const change of [{ file: false }, { symlink: true }, { nlink: 2n }, { uid: 43n },
    { mode: 0o100644n }, { mode: 0o104600n }, { size: -1n }, { size: 8388609n }]) {
    assert.throws(() => assertOwnedLogInfo(info(change), 42n), /DEV_STACK_RELOAD_LOG_METADATA/u);
  }
});
const posixOnly = { skip: process.platform === "win32" ? "POSIX UID/mode/no-follow semantics required" : false };
function logFixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "dev-log-"));
  const fds = [];
  t.after(() => {
    for (const fd of fds) fs.closeSync(fd);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, path: join(root,"proof.log"), remember: value => { fds.push(value.fd); return value; } };
}
test("both overlapping supervisor writers append without overwriting the other's bytes", posixOnly, t => {
  const f = logFixture(t), first = f.remember(createOwnedAppendLog(f.path));
  fs.writeSync(first.fd, "A0");
  const second = f.remember(openOwnedAppendLog(f.path, first.identity));
  fs.writeSync(second.fd,"B1"); fs.writeSync(first.fd,"A1"); fs.writeSync(second.fd,"B2");
  assert.equal(readOwnedLog(f.path, first.identity), "A0B1A1B2");
  assert.deepEqual(second.identity, first.identity);
});
test("initial creation remains exclusive and cannot truncate an existing sentinel", posixOnly, t => {
  const f = logFixture(t); fs.writeFileSync(f.path,"keep",{mode:0o600,flag:"wx"});
  assert.throws(() => createOwnedAppendLog(f.path), { code: "EEXIST" });
  assert.equal(fs.readFileSync(f.path,"utf8"),"keep");
});
test("append and read cannot create a missing log", posixOnly, t => {
  const f = logFixture(t), identity = { dev: "1", ino: "2" };
  assert.throws(() => openOwnedAppendLog(f.path,identity), { code: "ENOENT" });
  assert.throws(() => readOwnedLog(f.path,identity), { code: "ENOENT" });
  assert.equal(fs.existsSync(f.path),false);
});
test("append flags exclude creation and truncation even for the first inherited writer", posixOnly, t => {
  const f = logFixture(t), actual = fs.openSync, flags = [];
  const mock = t.mock.method(fs,"openSync",(...args) => { flags.push(args[1]); return actual(...args); });
  try {
    const first = f.remember(createOwnedAppendLog(f.path));
    f.remember(openOwnedAppendLog(f.path, first.identity));
    assert.equal(flags.length,3);
    assert.ok(flags[0] & fs.constants.O_EXCL);
    for (const value of flags.slice(1)) {
      assert.ok(value & fs.constants.O_APPEND); assert.ok(value & fs.constants.O_NOFOLLOW);
      assert.equal(value & (fs.constants.O_CREAT | fs.constants.O_TRUNC),0);
    }
  } finally { mock.mock.restore(); }
});
test("renamed/replaced log, symlink and hardlink cannot be adopted", posixOnly, t => {
  const f = logFixture(t), first = f.remember(createOwnedAppendLog(f.path));
  fs.writeSync(first.fd,"original");
  const saved = join(f.root,"original.log"); fs.renameSync(f.path,saved);
  fs.writeFileSync(f.path,"foreign",{mode:0o600,flag:"wx"});
  assert.throws(() => openOwnedAppendLog(f.path,first.identity), /LOG_IDENTITY/u);
  assert.throws(() => readOwnedLog(f.path,first.identity), /LOG_IDENTITY/u);
  assert.equal(fs.readFileSync(f.path,"utf8"),"foreign");
  fs.unlinkSync(f.path); fs.symlinkSync(saved,f.path);
  assert.throws(() => openOwnedAppendLog(f.path,first.identity), /LOG_METADATA/u);
  assert.throws(() => readOwnedLog(f.path,first.identity), /LOG_METADATA/u);
  fs.unlinkSync(f.path); fs.linkSync(saved,f.path);
  assert.throws(() => openOwnedAppendLog(f.path,first.identity), /LOG_METADATA/u);
  assert.equal(fs.readFileSync(saved,"utf8"),"original");
});
test("wrong mode, directory and oversized logs fail without chmod or truncation", posixOnly, t => {
  const f = logFixture(t), first = f.remember(createOwnedAppendLog(f.path));
  fs.fchmodSync(first.fd,0o644);
  assert.throws(() => openOwnedAppendLog(f.path,first.identity), /LOG_METADATA/u);
  assert.equal(fs.statSync(f.path).mode & 0o7777,0o644);
  fs.fchmodSync(first.fd,0o600); fs.ftruncateSync(first.fd,8388609);
  assert.throws(() => readOwnedLog(f.path,first.identity), /LOG_METADATA/u);
  assert.throws(() => openOwnedAppendLog(f.root,first.identity), /LOG_METADATA/u);
});
test("bounded prefix reader accepts concurrent append and sees later bytes next poll", posixOnly, t => {
  const f = logFixture(t), first = f.remember(createOwnedAppendLog(f.path)); fs.writeSync(first.fd,"prefix");
  const actual = fs.readSync; let appended=false;
  const mock=t.mock.method(fs,"readSync",(...args) => {
    const count=actual(...args);
    if(!appended){appended=true;fs.writeSync(first.fd,"later");}
    return count;
  });
  try { assert.equal(readOwnedLog(f.path,first.identity),"prefix"); }
  finally { mock.mock.restore(); }
  assert.equal(readOwnedLog(f.path,first.identity),"prefixlater");
  assert.throws(() => readOwnedLog(f.path,first.identity,1), /LOG_LIMIT/u);
});
test("prefix read refuses truncation during its read and closes the descriptor", posixOnly, t => {
  const f=logFixture(t), first=f.remember(createOwnedAppendLog(f.path)); fs.writeSync(first.fd,"prefix");
  const actual=fs.readSync; let reader;
  const mock=t.mock.method(fs,"readSync",(...args) => {
    reader=args[0];const count=actual(...args);fs.ftruncateSync(first.fd,0);return count;
  });
  try { assert.throws(() => readOwnedLog(f.path,first.identity), /LOG_SHRANK/u); }
  finally { mock.mock.restore(); }
  assert.throws(() => fs.fstatSync(reader),{code:"EBADF"});
});
test("partial positional reads assemble exactly the original bounded prefix", posixOnly, t => {
  const f=logFixture(t), first=f.remember(createOwnedAppendLog(f.path)); fs.writeSync(first.fd,"abcdef");
  const actual=fs.readSync; let calls=0;
  const mock=t.mock.method(fs,"readSync",(fd,bytes,offset,length,position) => {
    calls++; return actual(fd,bytes,offset,Math.min(length,2),position);
  });
  try { assert.equal(readOwnedLog(f.path,first.identity),"abcdef"); assert.equal(calls,3); }
  finally { mock.mock.restore(); }
});
test("a name replacement after append-open is refused and the acquired descriptor closes", posixOnly, t => {
  const f=logFixture(t), first=f.remember(createOwnedAppendLog(f.path));
  const replacement=join(f.root,"replacement.log"); fs.writeFileSync(replacement,"replacement",{mode:0o600,flag:"wx"});
  const actual=fs.openSync; let acquired;
  const mock=t.mock.method(fs,"openSync",(...args) => {
    acquired=actual(...args);fs.renameSync(f.path,join(f.root,"saved.log"));
    fs.renameSync(replacement,f.path);return acquired;
  });
  try { assert.throws(() => openOwnedAppendLog(f.path,first.identity),/LOG_IDENTITY/u); }
  finally { mock.mock.restore(); }
  assert.throws(() => fs.fstatSync(acquired),{code:"EBADF"});
  assert.equal(fs.readFileSync(f.path,"utf8"),"replacement");
});
test("a replacement during prefix read cannot be adopted as the original log", posixOnly, t => {
  const f=logFixture(t), first=f.remember(createOwnedAppendLog(f.path));fs.writeSync(first.fd,"original");
  const actual=fs.readSync;let reader;
  const mock=t.mock.method(fs,"readSync",(...args) => {
    reader=args[0];const count=actual(...args);fs.renameSync(f.path,join(f.root,"saved.log"));
    fs.writeFileSync(f.path,"replacement",{mode:0o600,flag:"wx"});return count;
  });
  try { assert.throws(() => readOwnedLog(f.path,first.identity),/LOG_IDENTITY/u); }
  finally { mock.mock.restore(); }
  assert.throws(() => fs.fstatSync(reader),{code:"EBADF"});
  assert.equal(fs.readFileSync(f.path,"utf8"),"replacement");
});
test("CI uses the pinned append writer for up/rebuild and bounded reads for both probes", () => {
  const source=fs.readFileSync(new URL("../dev-stack-ci.mjs",import.meta.url),"utf8");
  assert.match(source,/action === "up" \? createOwnedAppendLog\(logPath\) : openOwnedAppendLog\(logPath, ownedLogIdentity\)/u);
  assert.doesNotMatch(source,/readFileSync\(logPath|"ax"/u);
  assert.equal([...source.matchAll(/readOwnedLog\(logPath, ownedLogIdentity\)/gu)].length,2);
});
