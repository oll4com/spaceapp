import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptController } from "../src/prompt-controller.mjs";

function createMockStream(chunks = [], { isTTY = false } = {}) {
  let index = 0;
  const stream = new Readable({
    read() {
      if (index < chunks.length) {
        this.push(chunks[index++]);
      } else {
        this.push(null);
      }
    }
  });
  stream.isTTY = isTTY;
  if (isTTY) {
    stream.setRawMode = () => {};
  }
  return stream;
}

function captureOutput() {
  let captured = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      captured += chunk.toString();
      callback();
    }
  });
  return {
    stream,
    get text() {
      return captured;
    }
  };
}

test("PromptController correctly handles multi-line inputs in a single chunk without dropping", async () => {
  const stream = createMockStream(["y\n2\nmy-password\n"]);
  const out = captureOutput();
  const controller = new PromptController({ stdin: stream, stdout: out.stream });

  const first = await controller.readLine("Q1: ");
  assert.equal(first, "y");

  const second = await controller.readLine("Q2: ");
  assert.equal(second, "2");

  const third = await controller.readLine("Q3: ");
  assert.equal(third, "my-password");
});

test("PromptController preserves unread buffer across promptYesNo and promptChoice", async () => {
  const stream = createMockStream(["y\n2\n"]);
  const out = captureOutput();
  const controller = new PromptController({ stdin: stream, stdout: out.stream });

  const yesNo = await controller.promptYesNo("Continue?");
  assert.equal(yesNo, true);

  const choice = await controller.promptChoice("Pick option:", [
    { label: "Option 1", value: "one" },
    { label: "Option 2", value: "two" }
  ]);
  assert.equal(choice, "two");
});

test("PromptController handles split CRLF across two chunks", async () => {
  const stream = createMockStream(["yes\r", "\nno\n"]);
  const out = captureOutput();
  const controller = new PromptController({ stdin: stream, stdout: out.stream });

  const first = await controller.readLine("Q1: ");
  assert.equal(first, "yes");

  const second = await controller.readLine("Q2: ");
  assert.equal(second, "no");
});

test("PromptController answers using pre-configured answers file / dictionary", async () => {
  const stream = createMockStream([]);
  const out = captureOutput();
  const controller = new PromptController({
    stdin: stream,
    stdout: out.stream,
    answers: { profile: "light", companions: false }
  });

  const choice = await controller.promptChoice(
    "Profile:",
    [
      { label: "Auto", value: "auto" },
      { label: "Light", value: "light" },
      { label: "Standard", value: "standard" }
    ],
    { answerKey: "profile" }
  );
  assert.equal(choice, "light");

  const companions = await controller.promptYesNo("Enable companions?", {
    answerKey: "companions"
  });
  assert.equal(companions, false);
});

test("PromptController writes logs to logFile and masks secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spaceapp-log-test-"));
  const logPath = join(dir, "devtest.log");
  try {
    const stream = createMockStream(["my-secret-token\n"]);
    const out = captureOutput();
    const controller = new PromptController({
      stdin: stream,
      stdout: out.stream,
      logFile: logPath
    });

    await controller.readLine("Enter secret: ", { mask: true });
    await controller.close();

    const logContent = await readFile(logPath, "utf8");
    assert.match(logContent, /Enter secret/);
    assert.doesNotMatch(logContent, /my-secret-token/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
