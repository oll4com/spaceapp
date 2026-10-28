import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode
} from "react";
import {
  Info,
  CheckCircle2,
  CircleAlert,
  Layers,
  Loader2,
  Maximize2,
  Minimize2,
  Search,
  AlertTriangle,
  X,
  type LucideIcon
} from "../ui-theme/app-icons.js";
import "./dock-kit.css";

// One shared look for every dock: toolbar, buttons, search, filter chips,
// loading/empty/error states, notices and an in-app confirmation.

function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

type DockTone = "default" | "primary" | "danger";

export function DockToolbar({ title, summary, children, className }: {
  /** Shown only where the shell header is not visible, e.g. in fullscreen. */
  title?: string;
  summary?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("dock-kit-toolbar", className)}>
      <div className="dock-kit-heading">
        {title ? <h2 className="dock-kit-title">{title}</h2> : null}
        {summary != null ? <p className="dock-kit-summary">{summary}</p> : null}
      </div>
      {children ? <div className="dock-kit-actions">{children}</div> : null}
    </div>
  );
}

export interface DockIconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Used as the accessible name and the tooltip. */
  label: string;
  icon: LucideIcon;
  tone?: DockTone;
  busy?: boolean;
}

export function DockIconButton({ label, icon: Icon, tone = "default", busy = false, className, title, type = "button", ...rest }: DockIconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={title ?? label}
      aria-busy={busy || undefined}
      className={cx("dock-kit-icon-button", tone !== "default" && `is-${tone}`, className)}
    >
      {busy ? <Loader2 className="dock-kit-spin" aria-hidden="true" /> : <Icon aria-hidden="true" />}
    </button>
  );
}

/** Fullscreen toggle with the same labels and active styling in every dock. */
export function DockFullscreenButton({ name, active, onToggle }: {
  /** Lower-case dock name used in the labels, e.g. "tasks". */
  name: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <DockIconButton
      label={active ? `Exit ${name} fullscreen` : `Open ${name} fullscreen`}
      icon={active ? Minimize2 : Maximize2}
      aria-pressed={active}
      className={cx("dock-fullscreen-toggle", active && "is-active")}
      onClick={onToggle}
    />
  );
}

/** Escape leaves fullscreen; a confirmation dialog handles its own Escape first. */
export function useDockFullscreen(): [boolean, (next: boolean | ((current: boolean) => boolean)) => void] {
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFullscreen]);
  return [isFullscreen, setIsFullscreen];
}

export interface DockButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: LucideIcon;
  tone?: DockTone | "ghost";
  busy?: boolean;
}

export function DockButton({ icon: Icon, tone = "default", busy = false, className, children, type = "button", ...rest }: DockButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-busy={busy || undefined}
      className={cx("dock-kit-button", tone !== "default" && `is-${tone}`, className)}
    >
      {busy ? <Loader2 className="dock-kit-spin" aria-hidden="true" /> : Icon ? <Icon aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function DockSearch({ value, onChange, label, placeholder, name, className }: {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name, e.g. "Search tasks". */
  label: string;
  placeholder?: string;
  name?: string;
  className?: string;
}) {
  return (
    <div className={cx("dock-kit-search", className)}>
      <Search aria-hidden="true" />
      <input
        type="search"
        name={name}
        aria-label={label}
        placeholder={placeholder ?? `${label}…`}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {value ? (
        <button type="button" className="dock-kit-search-clear" aria-label="Clear search" title="Clear search" onClick={() => onChange("")}>
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export interface DockChipOption<T extends string> {
  id: T;
  label: string;
  count?: number;
  /** An icon before the label; the label then sits in its own span, so a compact bar can show the icon alone (the name stays the button's name and tooltip). */
  icon?: LucideIcon;
}

export function DockChips<T extends string>({ options, value, onChange, label, className }: {
  options: ReadonlyArray<DockChipOption<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div className={cx("dock-kit-chips", className)} role="group" aria-label={label}>
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.id}
            type="button"
            className="dock-kit-chip"
            aria-pressed={option.id === value}
            onClick={() => onChange(option.id)}
            {...(Icon ? { title: option.label } : {})}
          >
            {Icon ? <><Icon className="dock-kit-chip-icon" aria-hidden="true" /><span className="dock-kit-chip-label">{option.label}</span></> : option.label}
            {option.count != null ? <span className="dock-kit-chip-count">{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export interface DockStateAction {
  label: string;
  onClick: () => void;
  icon?: LucideIcon;
}

export function DockState({ kind, icon, title, detail, action, className }: {
  kind: "loading" | "empty" | "error";
  icon?: LucideIcon;
  title: string;
  detail?: ReactNode;
  action?: DockStateAction;
  className?: string;
}) {
  const Icon = kind === "loading" ? Loader2 : icon ?? (kind === "error" ? CircleAlert : Layers);
  return (
    <div className={cx("dock-kit-state", `is-${kind}`, className)} role={kind === "error" ? "alert" : "status"}>
      <span className="dock-kit-state-icon" aria-hidden="true">
        <Icon className={kind === "loading" ? "dock-kit-spin" : undefined} />
      </span>
      <strong className="dock-kit-state-title">{title}</strong>
      {detail ? <p className="dock-kit-state-detail">{detail}</p> : null}
      {action ? (
        <DockButton icon={action.icon} tone={kind === "error" ? "default" : "primary"} onClick={action.onClick}>
          {action.label}
        </DockButton>
      ) : null}
    </div>
  );
}

export function DockNotice({ tone = "error", children, onDismiss, className }: {
  tone?: "error" | "warning" | "success" | "info";
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  const Icon = tone === "error" ? CircleAlert : tone === "warning" ? AlertTriangle : tone === "success" ? CheckCircle2 : Info;
  return (
    <div className={cx("dock-kit-notice", `is-${tone}`, className)} role={tone === "error" ? "alert" : "status"}>
      <Icon aria-hidden="true" />
      <span className="dock-kit-notice-text">{children}</span>
      {onDismiss ? (
        <button type="button" className="dock-kit-notice-dismiss" aria-label="Dismiss message" title="Dismiss message" onClick={onDismiss}>
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export interface DockConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
}

function DockConfirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", tone = "danger", onCancel, onConfirm }: DockConfirmOptions & {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const messageId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    if (dialog && !dialog.open) {
      try {
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      } catch {
        dialog.setAttribute("open", "");
      }
    }
    // Cancel is the safe default focus for a destructive question.
    dialog?.querySelector<HTMLElement>(".dock-kit-confirm-cancel")?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dock-kit-confirm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={message ? messageId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="dock-kit-confirm-body">
        <strong id={titleId} className="dock-kit-confirm-title">{title}</strong>
        {message ? <p id={messageId} className="dock-kit-confirm-message">{message}</p> : null}
        <div className="dock-kit-confirm-actions">
          <DockButton className="dock-kit-confirm-cancel" onClick={onCancel}>{cancelLabel}</DockButton>
          <DockButton tone={tone} className="dock-kit-confirm-accept" onClick={onConfirm}>{confirmLabel}</DockButton>
        </div>
      </div>
    </dialog>
  );
}

/**
 * In-app replacement for window.confirm. Render `confirmDialog` once inside the
 * dock and `await confirm({...})` before a destructive action.
 */
export function useDockConfirm(): {
  confirm: (options: DockConfirmOptions) => Promise<boolean>;
  confirmDialog: ReactNode;
} {
  const [request, setRequest] = useState<DockConfirmOptions | null>(null);
  const resolverRef = useRef<((accepted: boolean) => void) | null>(null);

  const confirm = useCallback((options: DockConfirmOptions) => {
    resolverRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setRequest(options);
    });
  }, []);

  const settle = useCallback((accepted: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setRequest(null);
    resolve?.(accepted);
  }, []);

  useEffect(() => () => {
    resolverRef.current?.(false);
    resolverRef.current = null;
  }, []);

  const confirmDialog = request ? (
    <DockConfirmDialog {...request} onCancel={() => settle(false)} onConfirm={() => settle(true)} />
  ) : null;
  return { confirm, confirmDialog };
}
