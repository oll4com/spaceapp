import { describe, expect, it } from "vitest";
import {
  runNativeMetadataCommand,
  nativeProcessIdentity,
} from "../src/task-title-native.js";

describe("native metadata helper boundary", () => {
  it("passes JSON over stdin without shell interpolation", async () => {
    const input = JSON.stringify({
      title: "Title `command` $(other) Ελληνικά",
    });
    expect(
      await runNativeMetadataCommand(
        process.execPath,
        ["-e", "process.stdin.pipe(process.stdout)"],
        input,
      ),
    ).toBe(input);
    expect(await nativeProcessIdentity(process.pid)).toMatch(
      /^linux:[0-9a-f-]+:\d+$/,
    );
  });
  it("rejects excess input/output and process failures", async () => {
    await expect(
      runNativeMetadataCommand(process.execPath, [], "α".repeat(3000)),
    ).rejects.toThrow();
    await expect(
      runNativeMetadataCommand(
        process.execPath,
        ["-e", "process.stdout.write('α'.repeat(40000))"],
        "{}",
      ),
    ).rejects.toThrow();
    await expect(
      runNativeMetadataCommand("/nonexistent/space-helper", [], "{}"),
    ).rejects.toThrow();
  });
  it("cancels the helper process group, including children holding stdout open", async () => {
    const script =
      "const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,'ignore']});setInterval(()=>{},1000)";
    const started = Date.now();
    await expect(
      runNativeMetadataCommand(
        process.execPath,
        ["-e", script],
        "{}",
        undefined,
        500,
      ),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });
  it("honors cancellation before spawning", async () => {
    await expect(
      runNativeMetadataCommand(process.execPath, [], "{}", AbortSignal.abort()),
    ).rejects.toThrow();
  });
});
