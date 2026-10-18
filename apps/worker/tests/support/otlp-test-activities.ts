import { Context } from "@temporalio/activity";

/** Stub activities for the OTLP span integration test. No providers, no I/O. */

export async function flakyProbe(input: { roomId?: string; prompt?: string }): Promise<string> {
  void input;
  // Fails on the first attempt of every run so the tests can assert one span
  // per attempt; the message is deliberately sensitive-looking.
  if (Context.current().info.attempt === 1) {
    throw new Error("probe failure with a secret message that must never be exported");
  }
  return "flaky-ok";
}

export async function echoProbe(input: { roomId?: string; prompt?: string }): Promise<string> {
  void input;
  return "echo-ok";
}
