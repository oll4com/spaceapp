import { Mic } from "../ui-theme/app-icons.js";

export function VoiceInputButton({
  label,
  active,
  disabled,
  onClick,
  onPrewarm
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  onPrewarm?: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "voice-input-control recording" : "voice-input-control"}
      onClick={onClick}
      disabled={disabled}
      onPointerEnter={() => {
        if (!disabled) onPrewarm?.();
      }}
      onFocus={() => {
        if (!disabled) onPrewarm?.();
      }}
      aria-label={`${active ? "Stop" : "Start"} voice input ${label}`}
      aria-pressed={active}
      title={active ? "Stop voice input" : "Start voice input"}
    >
      <Mic aria-hidden="true" />
    </button>
  );
}
