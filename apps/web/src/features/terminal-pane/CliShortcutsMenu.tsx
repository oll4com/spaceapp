import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Zap, Play, Save, ClipboardList, Wrench, Gauge, Rocket, Shield,
  BrainCircuit, History, Activity, Eraser, CircleHelp, Radio, Terminal,
  Archive,
  type LucideIcon
} from "../ui-theme/app-icons.js";
import { OSK_CLI_COMMANDS, OSK_ESC_COMMAND, OSK_ENTER_COMMAND, type OskCliCommand } from "../osk-keyboard/cli-shortcuts.js";

import { CliShortcutUserContext, rankCliShortcuts, recordCliShortcutUse } from "./cli-shortcut-usage.js";

const TRANSCRIPT_COMMAND: OskCliCommand = { id: "transcript", label: "Ctrl+T · Full transcript", text: "\u0014" };

const SHORTCUT_ICONS: Record<string, LucideIcon> = {
  transcript: History, continue: Play, memory: Save, plan: ClipboardList, build: Wrench,
  plan_progress: Gauge, deploy: Rocket, permissions: Shield,
  model: BrainCircuit, resume: History, usage: Activity,
  clear: Eraser, help: CircleHelp, status: Radio, test: Terminal,
  clean_worktree: Archive
};

const SHORTCUT_TITLES: Record<string, string> = {
  continue: "Continue",
  memory: "Save to memory",
  plan: "Plan mode",
  build: "Build mode",
  plan_progress: "Plan completion percentage",
  deploy: "Deploy",
  permissions: "Permissions",
  model: "Model",
  resume: "Restore tasks",
  usage: "Usage",
  clear: "Clear",
  help: "Help",
  status: "Status",
  test: "Test",
  clean_worktree: "Clean worktree"
};

export function CliShortcutsMenu({
  disabled,
  active,
  onCommand,
  commands = OSK_CLI_COMMANDS,
  showTranscript = false,
  showKeys = commands === OSK_CLI_COMMANDS
}: {
  commands?: readonly OskCliCommand[];
  disabled: boolean;
  active: boolean;
  onCommand: (command: OskCliCommand) => void;
  showKeys?: boolean;
  showTranscript?: boolean;
}) {
  const id = useId();
  const userId = useContext(CliShortcutUserContext);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ right: number; bottom: number; maxHeight: number } | null>(null);
  const [themeContext, setThemeContext] = useState<{
    uiTheme?: string;
    interfaceTheme?: string;
    roomTheme?: string;
    colorMode?: string;
  }>({});
  const open = Boolean(position && active && !disabled);
  // Read fresh counts when opening; keep the order stable while the menu is open.
  const rankedCommands = useMemo(() => rankCliShortcuts(
    showTranscript ? [...commands, TRANSCRIPT_COMMAND] : commands, userId
  ), [commands, showTranscript, userId, open]);

  function selectCommand(command: OskCliCommand) {
    setPosition(null);
    recordCliShortcutUse(userId, command.id);
    onCommand(command);
  }

  useEffect(() => {
    if (!active || disabled) setPosition(null);
  }, [active, disabled]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target)) setPosition(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setPosition(null);
      buttonRef.current?.focus();
    };
    const close = () => setPosition(null);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    if (rect.left < 8) {
      const overflow = 8 - rect.left;
      setPosition((current) => {
        if (!current) return current;
        return {
          ...current,
          right: Math.max(8, current.right - overflow)
        };
      });
    }
  }, [open]);

  const host = buttonRef.current?.closest<HTMLElement>("[data-shell-mode], .space-shell, [data-room-theme], [data-ui-theme]");
  const currentUiTheme = themeContext.uiTheme ?? host?.dataset.uiTheme ?? (typeof document !== "undefined" ? document.body.dataset.uiTheme : undefined);
  const currentInterfaceTheme = themeContext.interfaceTheme ?? host?.dataset.interfaceTheme ?? (typeof document !== "undefined" ? document.documentElement.dataset.interfaceTheme : undefined);
  const currentRoomTheme = themeContext.roomTheme ?? host?.dataset.roomTheme ?? (typeof document !== "undefined" ? document.body.dataset.roomTheme : undefined);
  const currentColorMode = themeContext.colorMode ?? host?.dataset.colorMode ?? (typeof document !== "undefined" ? document.body.dataset.colorMode : undefined);

  return <>
    <button
      ref={buttonRef}
      type="button"
      className="terminal-shortcuts-button"
      aria-label="CLI shortcuts"
      title="CLI shortcuts"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      disabled={disabled}
      onClick={() => {
        if (open) { setPosition(null); return; }
        const box = buttonRef.current!.getBoundingClientRect();
        const container = buttonRef.current?.closest(".terminal-floating-controls, .codex-composer-toolbar") ?? buttonRef.current;
        const anchorBox = container ? container.getBoundingClientRect() : box;
        const rootFontSize = typeof window !== "undefined"
          ? (Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16)
          : 16;
        const popoverWidth = Math.min(21 * rootFontSize, window.innerWidth - 16);
        const maxRight = Math.max(8, window.innerWidth - popoverWidth - 8);
        const targetHost = buttonRef.current?.closest<HTMLElement>("[data-shell-mode], .space-shell, [data-room-theme], [data-ui-theme]");
        setThemeContext({
          uiTheme: targetHost?.dataset.uiTheme || (typeof document !== "undefined" ? document.body.dataset.uiTheme : undefined),
          interfaceTheme: targetHost?.dataset.interfaceTheme || (typeof document !== "undefined" ? document.documentElement.dataset.interfaceTheme : undefined),
          roomTheme: targetHost?.dataset.roomTheme || (typeof document !== "undefined" ? document.body.dataset.roomTheme : undefined),
          colorMode: targetHost?.dataset.colorMode || (typeof document !== "undefined" ? document.body.dataset.colorMode : undefined)
        });
        setPosition({
          right: Math.min(Math.max(8, window.innerWidth - anchorBox.right), maxRight),
          bottom: Math.max(8, window.innerHeight - box.top + 8),
          maxHeight: Math.max(60, box.top - 16)
        });
      }}
    ><Zap aria-hidden="true" /></button>
    {open && position ? createPortal(
      <div
        ref={panelRef}
        id={id}
        className="terminal-shortcuts-popover"
        role="dialog"
        aria-label="CLI shortcuts"
        data-ui-theme={currentUiTheme}
        data-interface-theme={currentInterfaceTheme}
        data-room-theme={currentRoomTheme}
        data-color-mode={currentColorMode}
        style={position}
        onBlur={(event) => {
          if (event.relatedTarget !== buttonRef.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) setPosition(null);
        }}>
        {rankedCommands.map((command) => {
          const Icon = SHORTCUT_ICONS[command.id];
          const displayLabel = SHORTCUT_TITLES[command.id] ?? command.label;
          return <button
            key={command.id}
            type="button"
            data-shortcut={command.id}
            title={displayLabel}
            aria-label={command.label}
            onClick={() => selectCommand(command)}
          >
            <span className="terminal-shortcut-label">
              {Icon ? <Icon aria-hidden="true" /> : null}
              <span>{displayLabel}</span>
            </span>
            {command.enter ? <kbd aria-label="Enter">↵</kbd> : null}
          </button>;
        })}
        {showKeys ? (
          <div className="terminal-shortcuts-key-group">
            <button
              type="button"
              className="terminal-shortcut-key"
              data-shortcut="esc"
              title="Esc"
              aria-label="Esc"
              onClick={() => {
                setPosition(null);
                onCommand(OSK_ESC_COMMAND);
              }}
            >
              <span>Esc</span>
            </button>
            <button
              type="button"
              className="terminal-shortcut-key"
              data-shortcut="enter"
              title="Enter"
              aria-label="Enter"
              onClick={() => {
                setPosition(null);
                onCommand(OSK_ENTER_COMMAND);
              }}
            >
              <span>Enter</span>
            </button>
          </div>
        ) : null}
      </div>, document.body
    ) : null}
  </>;
}
