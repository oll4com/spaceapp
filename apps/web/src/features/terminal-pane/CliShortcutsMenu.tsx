import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  Zap, Play, Save, ClipboardList, Wrench, Gauge, Rocket, Shield,
  BrainCircuit, History, Activity, Eraser, CircleHelp, Radio, Terminal,
  Archive, ArrowUpToLine, ArrowDownToLine, ArrowUpCircle,
  type LucideIcon
} from "../ui-theme/app-icons.js";
import { OSK_CLI_COMMANDS, OSK_ESC_COMMAND, OSK_ENTER_COMMAND, orderVisibleCliShortcuts, type OskCliCommand } from "../osk-keyboard/cli-shortcuts.js";
import { useOptionalVoiceInput } from "../voice-input/VoiceInputProvider.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { shouldPreserveForSnipTool } from "../snip-tool/snip-guard.js";

const TRANSCRIPT_COMMAND: OskCliCommand = { id: "transcript", label: "Ctrl+T · Full transcript", text: "\u0014" };
const CLAUDE_TRANSCRIPT_COMMAND: OskCliCommand = { id: "transcript", label: "Ctrl+O · Verbose transcript", text: "\u000f" };

// Usage counts used to reorder the menu; the order is fixed now, so the app drops them on start.
const LEGACY_USAGE_KEY_PREFIX = "space.cliShortcutUsage.v1.";
export function clearLegacyCliShortcutUsage(): void {
  try {
    const storage = getSpaceRuntime().platform.localStorage;
    const stale: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(LEGACY_USAGE_KEY_PREFIX)) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
  } catch { /* Storage availability must not block the app. */ }
}

// Codex opens its full transcript on Ctrl+T; Claude Code uses Ctrl+O and reserves Ctrl+T for its task list.
export function cliTranscriptCommand(runtimeId: string | null | undefined): OskCliCommand | null {
  if (runtimeId === "cli:codex") return TRANSCRIPT_COMMAND;
  if (runtimeId === "cli:claude") return CLAUDE_TRANSCRIPT_COMMAND;
  return null;
}

export const SHORTCUT_ICONS: Record<string, LucideIcon> = {
  transcript: History, continue: Play, memory: Save, plan: ClipboardList, build: Wrench,
  plan_progress: Gauge, deploy: Rocket, promote: ArrowUpCircle, permissions: Shield,
  model: BrainCircuit, resume: History, usage: Activity,
  clear: Eraser, help: CircleHelp, status: Radio, test: Terminal,
  clean_worktree: Archive,
  scroll_top: ArrowUpToLine,
  scroll_bottom: ArrowDownToLine
};

export const SHORTCUT_TITLES: Record<string, string> = {
  continue: "Continue",
  memory: "Save to memory",
  plan: "Plan mode",
  build: "Build mode",
  plan_progress: "Plan completion percentage",
  deploy: "Deploy",
  promote: "Promote",
  permissions: "Permissions",
  model: "Model",
  resume: "Restore tasks",
  usage: "Usage",
  clear: "Clear",
  help: "Help",
  status: "Status",
  test: "Test",
  clean_worktree: "Clean worktree",
  scroll_top: "Scroll to top",
  scroll_bottom: "Scroll to bottom"
};

// Destructive commands need a second click while the menu shows "Confirm …".
const CONFIRM_COMMAND_IDS = new Set(["clear"]);
const CONFIRM_WINDOW_MS = 4_000;
const MENU_COLUMNS = 2;

// The tooltip says exactly what a shortcut sends, so nothing reaches the CLI by surprise.
export function cliShortcutTitle(command: OskCliCommand, displayLabel: string): string {
  if (command.action) return displayLabel;
  if (command.id === "transcript") return `${displayLabel} — sends ${command.label.split(" · ")[0]}`;
  const text = command.text.length > 90 ? `${command.text.slice(0, 87)}…` : command.text;
  return `${displayLabel} — sends "${text}"${command.enter ? " and Enter" : ""}`;
}

export function CliShortcutsMenu({
  disabled,
  active,
  onCommand,
  commands = OSK_CLI_COMMANDS,
  showTranscript = false,
  transcriptCommand,
  showKeys = commands === OSK_CLI_COMMANDS
}: {
  commands?: readonly OskCliCommand[];
  disabled: boolean;
  active: boolean;
  onCommand: (command: OskCliCommand) => void;
  showKeys?: boolean;
  showTranscript?: boolean;
  transcriptCommand?: OskCliCommand | null;
}) {
  const id = useId();
  const hiddenIds = useOptionalVoiceInput()?.settings.terminalHiddenShortcuts;
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
  const transcript = transcriptCommand ?? (showTranscript ? TRANSCRIPT_COMMAND : null);
  const visibleCommands = useMemo(() => orderVisibleCliShortcuts(
    transcript ? [...commands, transcript] : commands, hiddenIds
  ), [commands, transcript, hiddenIds]);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmTimerRef = useRef<number | null>(null);
  const clearConfirm = () => {
    if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = null;
    setConfirmingId(null);
  };
  useEffect(() => {
    if (!open) clearConfirm();
  }, [open]);
  useEffect(() => () => {
    if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
  }, []);

  function selectCommand(command: OskCliCommand) {
    if (CONFIRM_COMMAND_IDS.has(command.id) && confirmingId !== command.id) {
      clearConfirm();
      setConfirmingId(command.id);
      confirmTimerRef.current = window.setTimeout(() => {
        confirmTimerRef.current = null;
        setConfirmingId(null);
      }, CONFIRM_WINDOW_MS);
      return;
    }
    clearConfirm();
    setPosition(null);
    onCommand(command);
  }

  // Arrow keys move through the two-column grid; Home/End jump to the first/last shortcut.
  function moveFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    const steps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: MENU_COLUMNS, ArrowUp: -MENU_COLUMNS };
    if (!(event.key in steps) && event.key !== "Home" && event.key !== "End") return;
    const buttons = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : Math.min(buttons.length - 1, Math.max(0, (index < 0 ? 0 : index) + steps[event.key]!));
    buttons[next]?.focus();
  }

  useEffect(() => {
    if (!active || disabled) setPosition(null);
  }, [active, disabled]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (shouldPreserveForSnipTool(event)) return;
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
        onKeyDown={moveFocus}
        onBlur={(event) => {
          if (shouldPreserveForSnipTool(event)) return;
          // Clicks on the gaps between shortcuts move focus nowhere; outside clicks close through pointerdown.
          const next = event.relatedTarget as Node | null;
          if (next && next !== buttonRef.current && !event.currentTarget.contains(next)) setPosition(null);
        }}>
        {visibleCommands.map((command) => {
          const Icon = SHORTCUT_ICONS[command.id];
          const displayLabel = SHORTCUT_TITLES[command.id] ?? command.label;
          const confirming = confirmingId === command.id;
          return <button
            key={command.id}
            type="button"
            data-shortcut={command.id}
            data-confirming={confirming ? "true" : undefined}
            title={confirming ? `Click again to send ${command.label}` : cliShortcutTitle(command, displayLabel)}
            aria-label={confirming ? `Confirm ${command.label}` : command.label}
            onClick={() => selectCommand(command)}
          >
            <span className="terminal-shortcut-label">
              {Icon ? <Icon aria-hidden="true" /> : null}
              <span>{confirming ? `Confirm ${displayLabel.toLowerCase()}` : displayLabel}</span>
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
