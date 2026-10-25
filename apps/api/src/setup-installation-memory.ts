import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SETUP_CATALOG, type SetupExecutionState, type SetupPlan, type SetupTask } from "@space/contracts";
import type { InstallationNotes } from "./installation-handoff.js";

/** Only server-validated identifiers enter assistant memory; credentials and raw output never do. */
export function projectSetupInstallationMemory(
  state: SetupExecutionState, plan: SetupPlan, task: SetupTask, modelId: string,
  proof: { source: "INSTALLER" | "UPGRADE"; notes?: InstallationNotes } = { source: "INSTALLER" }
): string | null {
  const { source, notes } = proof;
  const draft = state.draft;
  if (!draft || draft.id !== plan.draftId || draft.revision !== plan.draftRevision ||
      draft.ownerId !== plan.ownerId || state.ownerId !== plan.ownerId ||
      !/^opencode\/[a-z0-9][a-z0-9._-]{0,100}$/.test(modelId) ||
      !/^plan:[a-zA-Z0-9._:-]{3,123}$/.test(plan.id) ||
      !["everyday", "creator", "developer"].includes(draft.persona) ||
      !["minimal", "balanced", "full"].includes(draft.level)) return null;
  const chosen = draft.connectionChoices.find((choice) => choice.featureId === "agent:opencode");
  if (chosen?.modelId && modelId !== `opencode/${chosen.modelId}`) return null;
  const ids = new Set(SETUP_CATALOG.map((feature) => feature.id));
  if (plan.effectiveFeatureIds.some((id) => !ids.has(id))) return null;
  const run = state.runs.find((item) => item.id === task.runId && item.planId === plan.id);
  if (!run || !["RUNNING", "READY"].includes(run.status)) return null;
  const checked = plan.actions.filter((action) => action.actionId !== "WRITE_INSTALLATION_MEMORY");
  if (!checked.length || checked.some((action) => !state.tasks.some((item) =>
    item.runId === run.id && item.actionId === action.actionId && item.featureId === action.featureId && item.status === "READY"
  ))) return null;
  return [
    "# SpaceApp installation memory", "", "Schema: 2",
    // An upgraded installation never ran the pre-Docker check; its memory says so (review 2026-10-21 #7).
    source === "INSTALLER" ? "Installer handoff: authenticated account-free assistant check."
      : "Installer handoff: none (no pre-Docker check on this installation); authenticated account-free assistant check by setup.",
    // The installer's facts stay next to setup's (review 2026-10-21 #10): the hardware profile sizes the containers, the
    // setup level picks the tools shown; they are separate choices.
    ...(notes ? [`Platform: ${notes.platform}`, `Hardware profile: ${notes.hardwareProfile}`,
      ...(notes.completedActions.length ? [`Completed installer assistant actions: ${notes.completedActions.join(", ")}`] : [])] : []),
    `Verified free model: ${modelId}`, `Setup plan: ${plan.id}`,
    `Selection revision: ${draft.revision}`, `Setup persona: ${draft.persona}`, `Setup level: ${draft.level}`,
    "Hardware profile and setup level are separate: the hardware profile sizes the containers, the setup level picks the tools shown.",
    `Selected tools: ${plan.effectiveFeatureIds.join(", ")}`,
    `Verified setup actions: ${checked.length}`,
    "Workspace checks: verified. Final completion is confirmed separately by the setup server.",
    "Next action: return to the setup wizard to review its current completion status.", ""
  ].join("\n");
}

export async function setupInstallationMemoryMatches(root: string, expected: string): Promise<boolean> {
  try {
    const handle = await open(join(root, "INSTALLATION_MEMORY.md"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      return info.isFile() && info.size <= 16_384 && await handle.readFile("utf8") === expected;
    } finally { await handle.close(); }
  } catch { return false; }
}

export async function writeSetupInstallationMemory(root: string, content: string): Promise<void> {
  const target = join(root, "INSTALLATION_MEMORY.md");
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}
