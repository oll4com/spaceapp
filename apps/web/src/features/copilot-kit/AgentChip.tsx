import { useEffect, useRef, useState } from "react";
import type { Pane } from "@space/contracts";
import { cliRuntimePresentation } from "../../cli-runtime-presentation.js";
import { BookmarkPlus, Check, ChevronDown, Terminal } from "../ui-theme/app-icons.js";
import type { CopilotKind } from "./copilot-kind.js";
import { paneModelLabel, type CopilotRuntimeOption } from "./copilot-runtimes.js";

/** The agent chip of a copilot command bar: the pane's CLI with a menu to switch it or save it as the kind's default. */
export function AgentChip({ kind, pane, runtimeOptions, switching, onSwitchRuntime, onSetDefault }: {
  kind: CopilotKind;
  pane: Pick<Pane, "terminalRuntimeId" | "modelId">;
  runtimeOptions: CopilotRuntimeOption[];
  switching: boolean;
  onSwitchRuntime(runtimeId: string): void;
  /** New panes of this copilot open with this pane's agent and account. */
  onSetDefault(): void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const runtimeId = pane.terminalRuntimeId ?? null;
  const current = runtimeOptions.find((option) => option.runtime.id === runtimeId) ?? null;
  const presentation = runtimeId ? cliRuntimePresentation(runtimeId) : null;
  const model = paneModelLabel(pane);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", onPointer); window.removeEventListener("keydown", onKey); };
  }, [menuOpen]);

  return (
    <div className="jc-agent" ref={menuRef}>
      <button type="button" className="jc-agent-chip" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={`Copilot agent: ${current?.runtime.displayName ?? runtimeId ?? "none"}`}
        disabled={switching} onClick={() => setMenuOpen((open) => !open)}>
        {presentation ? <img src={presentation.iconSrc} alt="" aria-hidden="true" /> : <Terminal aria-hidden="true" />}
        <span className="jc-agent-name">{switching ? "Switching…" : current?.runtime.displayName ?? presentation?.displayName ?? "Choose an agent"}</span>
        {model ? <span className="jc-agent-model">{model}</span> : null}
        <ChevronDown aria-hidden="true" />
      </button>
      {menuOpen ? (
        <div className="jc-menu" role="menu" aria-label="Switch copilot agent">
          <p className="jc-menu-hint">Switching restarts this pane's CLI session.</p>
          {runtimeOptions.map(({ runtime, ready, recommended }) => {
            const option = cliRuntimePresentation(runtime.id);
            const active = runtime.id === runtimeId;
            return (
              <button key={runtime.id} type="button" role="menuitemradio" aria-checked={active} className={`jc-menu-item${active ? " selected" : ""}`}
                disabled={!ready || active} title={ready ? undefined : runtime.statusReason}
                onClick={() => { setMenuOpen(false); onSwitchRuntime(runtime.id); }}>
                {option ? <img src={option.iconSrc} alt="" aria-hidden="true" /> : <Terminal aria-hidden="true" />}
                <span className="jc-menu-item-copy">
                  <strong>{runtime.displayName}</strong>
                  <small>{ready ? (recommended ? "Recommended" : "Ready") : runtime.statusReason}</small>
                </span>
                {active ? <Check aria-hidden="true" /> : null}
              </button>
            );
          })}
          <button type="button" role="menuitem" className="jc-menu-item jc-menu-default" disabled={!runtimeId}
            onClick={() => { setMenuOpen(false); onSetDefault(); }}>
            <BookmarkPlus aria-hidden="true" />
            <span className="jc-menu-item-copy">
              <strong>Set as default for new {kind.label} panes</strong>
              <small>New panes open with this agent and account without asking.</small>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
