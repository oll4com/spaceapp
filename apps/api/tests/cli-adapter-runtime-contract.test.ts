import { beforeAll, describe, expect, it } from "vitest";
import type { AgentRuntimeRegistry, CliAdapterLimitation } from "@space/contracts";
import { getApiConfig } from "../src/config.js";
import { discoverAgentRuntimes } from "../src/cli-runtimes.js";
import { cliAccountProfileRuntimeIds, cliRuntimeDescriptors } from "../src/cli-runtime-descriptors.js";
import { hasExactNativeTaskResume } from "../src/cli-native-task-resume.js";
import { findCliRunLifecycleAdapter } from "../src/cli-run-lifecycle-adapters.js";
import { dropStaleCliColorReplies, sanitizeCliTerminalInput } from "../src/cli-terminal.js";
import { interactivePickerForms, limitationOperation, sameArgv, factsFor, runtimeCases } from "./support/cli-adapter-contract.js";

// The adapter contract for EVERY advertised CLI runtime. Each fact below is
// derived from the launcher (buildCliSpawnArgs/buildCliEnvironment), the lifecycle
// adapter and the repository launch gates (wrapper filter + sudoers), never from
// the declaration itself. A runtime that cannot provide an operation must carry
// the matching limitation in its descriptor; a stale or missing one fails here.
// Static evidence only: no CLI, provider, credential or network is touched.
// The cases that need the repository launch gates (scripts/cli-launch-admission.mjs and the deploy wrappers and sudoers,
// not in the public tree): cli-adapter-launch-gates.test.ts.
describe("CLI adapter contract for every advertised runtime", () => {
  let registry: AgentRuntimeRegistry;
  beforeAll(async () => {
    registry = await discoverAgentRuntimes(getApiConfig({ SPACE_CLI_ENABLED: "false" }));
  });

  it("publishes a declaration with all six operations for each of the 16 descriptors", () => {
    expect(cliRuntimeDescriptors).toHaveLength(16);
    for (const descriptor of cliRuntimeDescriptors) {
      const runtime = registry.data.find(item => item.id === descriptor.id);
      expect(runtime?.cliAdapter?.operations, descriptor.id).toEqual({
        start: "PTY_SPAWN", send: "PTY_INPUT", interrupt: "PROCESS_TERMINATE",
        inspect: "HOST_PROCESS", events: "PTY_OUTPUT_AND_PROCESS_EXIT", reconnect: "LIVE_HOST_PROCESS"
      });
      expect(runtime?.cliAdapter?.limitations, descriptor.id).toEqual(descriptor.adapterLimitations);
    }
  });

  it("types a lone π into Droid as a paste, which Droid would otherwise read as Option+P", () => {
    expect(sanitizeCliTerminalInput("cli:droid", "π")).toBe("\u001b[200~π\u001b[201~");
    expect(sanitizeCliTerminalInput("cli:droid", "απ")).toBe("απ");
    expect(sanitizeCliTerminalInput("cli:claude", "π")).toBe("π");
  });

  it("passes a terminal color reply only shortly after the CLI asked, so a replayed query's answer never lands in the prompt", () => {
    const reply = "\u001b]11;rgb:0909/0b0b/0c0c\u001b\\";
    const cursor = "\u001b[12;3R";
    expect(dropStaleCliColorReplies(reply, 10_000, 10_400)).toBe(reply);
    expect(dropStaleCliColorReplies(`${reply}${cursor}`, 10_000, 60_000)).toBe(cursor);
    expect(dropStaleCliColorReplies("\u001b]4;1;rgb:ff/00/00\u0007", undefined, 1)).toBe("");
  });

  it.each(runtimeCases)("%s declares exactly the limitations its launcher and lifecycle imply", (_id, descriptor) => {
    const facts = factsFor(descriptor);
    const lifecycle = findCliRunLifecycleAdapter(descriptor.id)!;
    const modes = registry.data.find(item => item.id === descriptor.id)!.cliAdapter!.nativeResumeModes;
    const expected = new Set<CliAdapterLimitation["code"]>();
    if (facts.fresh.error) expected.add("START_REQUIRES_RESOLVED_MODEL");
    if (!facts.reference && !descriptor.nativeResumeArgs && !facts.steeredEnv) expected.add("NATIVE_RESUME_UNSUPPORTED");
    if (sameArgv(modes, ["PROVIDER_SELECTION"])) expected.add("PROVIDER_SELECTION_ONLY");
    if (interactivePickerForms[descriptor.id]) {
      expect(descriptor.nativeResumeArgs).toEqual(interactivePickerForms[descriptor.id]);
      expected.add("PROVIDER_SELECTION_INTERACTIVE_PICKER");
    }
    if (facts.reference && !descriptor.declaresNativeReference) expected.add("REFERENCE_PENDING_LIVE_PROOF");
    if (facts.steeredEnv) expected.add("REFERENCE_STEERED_BY_WRAPPER");
    if (!facts.hostLossResumes) expected.add("HOST_LOSS_RESTARTS_FRESH");
    if (lifecycle.completionStrategy === "UNAVAILABLE_FAIL_CLOSED") expected.add("COMPLETION_UNOBSERVED");
    if (facts.login.error) expected.add("LOGIN_NOT_IN_TERMINAL");

    const declared = descriptor.adapterLimitations.map(item => item.code);
    expect(new Set(declared).size, `${descriptor.id} repeats a limitation`).toBe(declared.length);
    expect([...declared].sort()).toEqual([...expected].sort());
    for (const limitation of descriptor.adapterLimitations) {
      expect(limitation.operation, `${descriptor.id} ${limitation.code}`).toBe(limitationOperation[limitation.code]);
    }
  });

  it.each(runtimeCases)("%s resolves task-history references only for a launcher that uses them", (_id, descriptor) => {
    // The central resume handler has no runtime branches: a registered resolver must feed a
    // launcher that passes the reference in argv or a kept variable (Codex keeps its thread path).
    const facts = factsFor(descriptor);
    if (hasExactNativeTaskResume(descriptor.id)) expect(Boolean(facts.reference || facts.steeredEnv)).toBe(true);
  });

  it("lists the account-profile runtimes exactly where a descriptor names the profile variable", () => {
    expect([...cliAccountProfileRuntimeIds].sort())
      .toEqual(cliRuntimeDescriptors.filter(item => item.accountProfileEnv).map(item => item.id).sort());
  });

});
