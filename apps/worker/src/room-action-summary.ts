import type { SpaceAgentRoomActionRequest } from "@space/contracts";
import { redactMemoryText } from "@space/runtime";

// Describe the requested operation, never its prompt, command arguments or raw
// tool output. The caller adds the actual execution state separately.
export function roomActionSummary(request: SpaceAgentRoomActionRequest, evidence: Record<string, unknown> = {}): string {
  const a = request.action;
  const paneId = "paneId" in a ? a.paneId : undefined;
  const target = typeof evidence.paneTitle === "string"
    ? `“${evidence.paneTitle}” (${paneId ?? evidence.paneId})` : paneId ?? "room";
  let summary: string;
  switch (a.type) {
    case "control": summary = `Use Space control: ${a.tool}`; break;
    case "inspect": summary = "Inspect room and pane activity"; break;
    case "catalog": summary = `Check ${a.section.toLowerCase()} for ${target}`; break;
    case "find": summary = "Find matching panes in this room"; break;
    case "layout": {
      const changes = [
        a.paneLayoutColumns === undefined ? null : a.paneLayoutColumns === 0 ? "automatic columns" : `${a.paneLayoutColumns} columns`,
        a.paneIds ? `reorder ${a.paneIds.length} panes` : null,
        a.columnSpan === undefined ? null : `${target}: span ${a.columnSpan} columns`,
        a.isMaximized === undefined ? null : `${a.isMaximized ? "maximize" : "restore size of"} ${target}`,
        a.isMinimized === undefined ? null : `${a.isMinimized ? "minimize" : "show"} ${target}`,
        a.focus ? `focus ${target}` : null
      ].filter(Boolean);
      summary = `Layout — ${changes.join("; ") || "keep current arrangement"}`;
      break;
    }
    case "open_types": summary = `Open ${a.kinds.join(" and ").toLowerCase()} panes${a.runtimeIds?.length ? `: ${a.runtimeIds.map(id => id.replace(/^cli:/, "")).join(", ")}` : " for available runtimes"}${a.input ? "; submit requested message" : ""}`; break;
    case "create_pane": summary = `Create ${a.mode.toLowerCase()} pane “${a.title}”${a.terminalRuntimeId ? ` (${a.terminalRuntimeId.replace(/^cli:/, "")})` : ""}`; break;
    case "close_pane": summary = `Close pane ${target}`; break;
    case "reopen_pane": summary = `Reopen pane ${target}`; break;
    case "send": summary = `Send requested message to ${target}`; break;
    case "interrupt": summary = `Stop active turn in ${target}`; break;
    case "restart": summary = `Restart pane ${target}`; break;
    case "start": summary = `Start pane ${target}`; break;
    case "resume": summary = `Resume ${a.taskId ? `task ${a.taskId} in ` : "pane "}${target}`; break;
    case "configure_pane": summary = `Configure ${target}: ${[
      a.modelId ?? a.selectedModelConfigId, a.reasoningEffort ? `reasoning ${a.reasoningEffort}` : null,
      a.nativeMode ? `mode ${a.nativeMode}` : null
    ].filter(Boolean).join("; ")}${a.when === "AFTER_TURN" ? " after the active turn" : " now"}`; break;
    case "cli_command": summary = `Use CLI ${a.key ? `key ${a.key}` : a.command ? `command ${a.command.split(" ")[0]}` : "menu selection"} in ${target}${a.when === "AFTER_TURN" ? " after the active turn" : " now"}`; break;
    case "orchestrate": summary = `Run ${a.steps.length} tasks across ${new Set(a.steps.map(step => step.paneId ?? step.paneKey)).size} panes; prepare ${a.preparePanes.length} panes`; break;
  }
  return redactMemoryText(summary).replace(/[\r\n]+/g, " ").slice(0, 700);
}
