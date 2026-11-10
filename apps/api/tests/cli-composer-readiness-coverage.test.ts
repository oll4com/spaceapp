import { expect, it } from "vitest";
import { cliRuntimeDescriptors } from "../src/cli-runtime-descriptors.js";
import { cliComposerReady, codexInputReady } from "../src/cli-terminal.js";

// ADAPTER-001 (runtime extension): Space decides when a CLI accepts input from its screen. A runtime added to the
// descriptors must be classified here on purpose; before this test it silently got "no marker known" (null) and
// every prompt Space typed into it relied on a timeout. Each class below is the current truth, checked against code.
const ownReadinessFunction = ["cli:codex"]; // codexInputReady
const composerMarker = ["cli:autohand", "cli:claude", "cli:copilot", "cli:cursor", "cli:deepseek", "cli:droid", "cli:gemini", "cli:grok", "cli:hermes", "cli:kimi", "cli:muse", "cli:omp", "cli:opencode", "cli:qoder", "cli:qwen"];
// No marker: readiness is not read from the screen. Give the runtime a marker in cliComposerReadyPatterns
// (apps/api/src/cli-terminal.ts) from a captured idle screen, add its screen to cli-composer-readiness.test.ts, and move it up.
// 2026-10-29: Copilot and DeepSeek got markers from captured idle screens. Autohand, Kimi and Muse start on their login or setup
// screen on this host (Autohand: account and OpenRouter key; Kimi: Kimi Code OAuth; Muse: its login chooser), so no composer
// could be captured without signing in; they keep the startup timeout. 2026-11-03: Muse got its marker from its echo provider, which
// needs no sign-in. Kimi got its marker from Kimi Code 2.4.1's idle screen (it starts on this host's Kimi home).
// Autohand 0.9.9-space.1 now has a captured native component marker (100/42 columns, accepted synthetic input),
// with a separate real startup login negative. Signed-in whole-CLI execution remains unproved.
const noMarkerKnown: string[] = [];

it("classifies every runtime descriptor by how Space reads its composer readiness", () => {
  const ids = cliRuntimeDescriptors.map((descriptor) => descriptor.id).sort();
  const classified = [...ownReadinessFunction, ...composerMarker, ...noMarkerKnown].sort();
  expect(classified, "A runtime descriptor was added or removed: classify its composer readiness in this test.").toEqual(ids);
});

it("matches each class to the code", () => {
  for (const id of composerMarker) {
    expect(cliComposerReady(id, ""), `${id} has a marker, so an empty screen is not ready`).toBe(false);
  }
  for (const id of [...ownReadinessFunction, ...noMarkerKnown]) {
    expect(cliComposerReady(id, "anything"), `${id} has no marker in cliComposerReady`).toBeNull();
  }
  expect(codexInputReady("")).toBe(false);
});
