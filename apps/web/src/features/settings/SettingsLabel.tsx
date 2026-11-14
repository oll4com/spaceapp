import type { ReactNode } from "react";
import { InfoTip } from "../ui-controls/InfoTip.js";
import { useUiText } from "../ui-language/ui-language.js";

/**
 * A Settings row's label with its ⓘ help (1-2 sentences: what it does, when to change it), both in the interface language.
 * `label` and `help` are English literals with their Greek in the EL table (guard: settings-help.test.ts); `children` is a
 * short live state line (a date, a count) shown under the label, never a description.
 */
export function SettingsLabel({ label, help, children }: { label: string; help: string; children?: ReactNode }) {
  const t = useUiText();
  return (
    <span className="settings-flat-row-copy">
      <strong>{t(label)}<InfoTip text={t(help)} label={t("About {label}", { label: t(label) })} /></strong>
      {children ? <small>{children}</small> : null}
    </span>
  );
}
