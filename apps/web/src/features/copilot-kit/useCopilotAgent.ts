import { useCallback, useEffect, useState } from "react";
import type { Pane } from "@space/contracts";
import { api } from "../../api.js";
import { loadDefaultAccountProfileId } from "./AgentAccountField.js";
import type { CopilotKind } from "./copilot-kind.js";
import { copilotAccountFor, copilotAgentLabel, loadPaneAccountProfileId, saveCopilotLaunch, type CopilotRuntimeOption } from "./copilot-runtimes.js";

/**
 * Switching a copilot pane's agent (CLI, account or both) and saving it as the kind's default.
 * Switch: PATCH the runtime, restart the CLI on that account (the session keeps it), then bump `terminalKey`
 * so the terminal element remounts on the new session. Without an account the CLI starts on the user's default
 * account for it, else on that CLI's default pane account. The pane's current account is its CLI session's.
 */
export function useCopilotAgent({ kind, pane, runtimeOptions, onSwitched, onNotice }: {
  kind: CopilotKind;
  pane: Pick<Pane, "id" | "terminalRuntimeId">;
  runtimeOptions: CopilotRuntimeOption[];
  onSwitched?(): void;
  onNotice(notice: string | null): void;
}) {
  const [switching, setSwitching] = useState(false);
  const [terminalKey, setTerminalKey] = useState(0);
  const [accountRevision, setAccountRevision] = useState(0);
  // Setup → Agent reloads the pane's account after every switch.
  useEffect(() => { if (!switching) setAccountRevision((revision) => revision + 1); }, [switching]);

  const switchAgent = useCallback(async (runtimeId: string, accountProfileId?: string) => {
    const sameRuntime = runtimeId === pane.terminalRuntimeId;
    if (switching || (sameRuntime && accountProfileId === undefined)) return;
    if (sameRuntime && accountProfileId === await loadPaneAccountProfileId(pane.id, runtimeId)) return;
    setSwitching(true);
    onNotice(null);
    try {
      const remembered = accountProfileId === undefined ? kind.remembered((await api.userSettings().catch(() => null)) ?? {}) : null;
      const account = copilotAccountFor(runtimeId, accountProfileId
        ?? (remembered?.runtimeId === runtimeId && remembered.accountProfileId ? remembered.accountProfileId : await loadDefaultAccountProfileId(runtimeId)));
      if (!sameRuntime) await api.updatePane(pane.id, { terminalRuntimeId: runtimeId });
      await api.createCliSession(pane.id, { runtimeId, forceRestart: true, includeTranscript: false, ...(account ? { accountProfileId: account } : {}) });
      setTerminalKey((key) => key + 1);
      onSwitched?.();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "The copilot agent could not be switched.");
    } finally {
      setSwitching(false);
    }
  }, [kind, onNotice, onSwitched, pane.id, pane.terminalRuntimeId, switching]);

  /** New panes of this copilot open with this pane's agent and the account its CLI runs on, without asking. */
  const setAsDefault = useCallback(async () => {
    const runtimeId = pane.terminalRuntimeId;
    if (!runtimeId) return;
    try {
      // The account the pane's CLI runs on now (the terminal's account menu may have changed it).
      const accountProfileId = await loadPaneAccountProfileId(pane.id, runtimeId);
      await saveCopilotLaunch(kind, { runtimeId, accountProfileId, askOnLaunch: false });
      const option = runtimeOptions.find((entry) => entry.runtime.id === runtimeId);
      onNotice(`New ${kind.label} panes open with ${copilotAgentLabel(runtimeId, option?.runtime)}${accountProfileId ? ` (${accountProfileId} account)` : ""} from now on.`);
    } catch (error) {
      onNotice(error instanceof Error ? `The default agent could not be saved: ${error.message}` : "The default agent could not be saved.");
    }
  }, [kind, onNotice, pane.id, pane.terminalRuntimeId, runtimeOptions]);

  return { switching, terminalKey, accountRevision, switchAgent, setAsDefault };
}
