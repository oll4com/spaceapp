import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Zap } from "../ui-theme/app-icons.js";
import { OSK_CLI_COMMANDS, type OskCliCommand } from "../osk-keyboard/cli-shortcuts.js";

export function CliShortcutsMenu({ disabled, active, onCommand, commands = OSK_CLI_COMMANDS }: {
  commands?: readonly OskCliCommand[];
  disabled: boolean;
  active: boolean;
  onCommand: (command: OskCliCommand) => void;
}) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);
  const open = Boolean(position && active && !disabled);

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
        const width = Math.min(18 * parseFloat(getComputedStyle(document.documentElement).fontSize), window.innerWidth - 16);
        setPosition({
          left: Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8)),
          bottom: Math.max(8, window.innerHeight - box.top + 8),
          maxHeight: Math.max(60, box.top - 16)
        });
      }}
    ><Zap aria-hidden="true" /></button>
    {open && position ? createPortal(
      <div ref={panelRef} id={id} className="terminal-shortcuts-popover" role="dialog" aria-label="CLI shortcuts" style={position}
        onBlur={(event) => {
          if (event.relatedTarget !== buttonRef.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) setPosition(null);
        }}>
        {commands.map((command) => <button
          key={command.id}
          type="button"
          data-shortcut={command.id}
          title={command.action ? `Change ${command.label.toLowerCase()}` : command.enter ? `Run "${command.text}"` : `Insert ${command.text}`}
          onClick={() => { setPosition(null); onCommand(command); }}
        >
          <span>{command.id === "memory" ? "Save to memory" : command.label}</span>
          {command.enter ? <kbd aria-label="Enter">↵</kbd> : null}
        </button>)}
      </div>, document.body
    ) : null}
  </>;
}
