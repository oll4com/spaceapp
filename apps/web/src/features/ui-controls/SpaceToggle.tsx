import type { ReactNode } from "react";
import "./space-toggle.css";

export type SpaceToggleProps = {
  checked: boolean;
  label: ReactNode;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
  className?: string;
  /** Switch and label only: no "Enabled/Disabled" state text (dense bars). */
  compact?: boolean;
  detail?: ReactNode;
  disabled?: boolean;
  id?: string;
  name?: string;
  required?: boolean;
  title?: string;
};

export function SpaceToggle({
  ariaLabel,
  checked,
  className,
  compact = false,
  detail,
  disabled = false,
  id,
  label,
  name,
  onChange,
  required = false,
  title
}: SpaceToggleProps) {
  const classes = ["space-toggle", compact ? "space-toggle-compact" : null, className].filter(Boolean).join(" ");
  const accessibleLabel = ariaLabel ?? (typeof label === "string" ? label : undefined);

  return (
    <label className={classes} data-disabled={disabled ? "true" : undefined} title={title}>
      <input
        id={id}
        name={name}
        type="checkbox"
        role="switch"
        aria-label={accessibleLabel}
        checked={checked}
        disabled={disabled}
        required={required}
        onChange={(event) => {
          if (!disabled) onChange(event.currentTarget.checked);
        }}
      />
      <span className="space-toggle-copy">
        <span className="space-toggle-label">{label}</span>
        {detail ? <small>{detail}</small> : null}
      </span>
      <span className="space-toggle-control" aria-hidden="true">
        <span className="space-toggle-track"><span className="space-toggle-thumb" /></span>
        {compact ? null : <span className="space-toggle-state">{checked ? "Enabled" : "Disabled"}</span>}
      </span>
    </label>
  );
}
