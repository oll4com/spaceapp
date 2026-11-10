import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentRuntimeRegistry, CopilotLaunchSettings } from "@space/contracts";
import { api } from "../../api.js";
import { cliRuntimePresentation } from "../../cli-runtime-presentation.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import { Bot, Check, Terminal, X } from "../ui-theme/app-icons.js";
import { defaultAccountProfileId, useCopilotAccounts } from "./AgentAccountField.js";
import type { CopilotKind } from "./copilot-kind.js";
import { copilotAccountFor, copilotAgentLabel, copilotRuntimeOptions, defaultCopilotRuntimeId, saveCopilotLaunch, type CopilotAgentChoice } from "./copilot-runtimes.js";
import "./copilot-pane.css";

export type CopilotLaunchChoice = CopilotAgentChoice;

/**
 * Runtime chooser shown before the first pane of a copilot opens (ready CLIs in catalog order, the kind's CLI
 * recommended). There is no account choice: the pane starts on the CLI's default account, the Space Gateway pool while
 * it is ready (operator decision 2026-10-19). "Remember" saves the choice in the user's settings; later panes open with it without asking.
 */
export function CopilotLaunchDialog({ kind, preselect = null, notice = null, onClose, onCreate }: {
  kind: CopilotKind;
  /** The saved default when the operator asked to be asked every time: the dialog starts on it. */
  preselect?: CopilotLaunchSettings | null;
  /** Why the dialog opened although a default is saved (that CLI is not ready). */
  notice?: string | null;
  onClose(): void;
  onCreate(choice: CopilotLaunchChoice): Promise<void>;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const languageRef = useRef(language);
  languageRef.current = language; // read at error time, so a language change never refetches
  const [registry, setRegistry] = useState<AgentRuntimeRegistry | null>(() => api.cliRuntimesSnapshot());
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const [remember, setRemember] = useState(() => !preselect?.askOnLaunch);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(() => copilotRuntimeOptions(registry, kind), [kind, registry]);
  const preselectReady = options.some((option) => option.ready && option.runtime.id === preselect?.runtimeId);
  const selectedId = runtimeId ?? (preselectReady ? preselect!.runtimeId : defaultCopilotRuntimeId(options));
  const selected = options.find((option) => option.runtime.id === selectedId) ?? null;
  const selectedLabel = selected ? copilotAgentLabel(selected.runtime.id, selected.runtime) : "…";
  // Loaded before Open so the pane gets the default account explicitly, not an account saved earlier.
  const accounts = useCopilotAccounts(selectedId);

  useEffect(() => {
    let cancelled = false;
    api.cliRuntimes().then((next) => { if (!cancelled) setRegistry(next); }).catch((caught: unknown) => {
      if (!cancelled && !registry) setError(caught instanceof Error ? caught.message : uiText(languageRef.current, "CLI runtimes could not be loaded."));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function create() {
    if (!selected || !selected.ready || !accounts || pending) return;
    setPending(true);
    setError(null);
    const id = selected.runtime.id;
    const accountProfileId = copilotAccountFor(id, defaultAccountProfileId(id, accounts));
    try {
      // Server-side, so every device opens later panes the same way; not remembering keeps asking, starting here.
      await saveCopilotLaunch(kind, { runtimeId: id, accountProfileId, askOnLaunch: !remember }).catch(() => undefined);
      await onCreate({ terminalRuntimeId: id, accountProfileId });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("The {kind} pane could not be created.", { kind: kind.label }));
      setPending(false);
    }
  }

  return (
    <div className="attachment-modal jc-launch-modal" onClick={onClose}>
      <section className="attachment-modal-body jc-launch" role="dialog" aria-modal="true" aria-label={t("New {kind}", { kind: kind.label })} onClick={(event) => event.stopPropagation()}>
        <button type="button" className="terminal-upload-modal-close jc-launch-close" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        <header className="jc-launch-head">
          <span className="jc-launch-eyebrow"><Bot aria-hidden="true" /> {kind.label}</span>
          <strong>{t(kind.launchHeading)}</strong>
          <small>{t(kind.launchDescription)}</small>
        </header>
        {notice ? <p className="jc-launch-state warn" role="status">{notice}</p> : null}
        {options.length === 0 ? (
          <p className="jc-launch-state" role="status">{error ?? t("Loading CLI runtimes…")}</p>
        ) : (
          <div className="jc-launch-options" role="radiogroup" aria-label={t("Copilot agent")}>
            {options.map(({ runtime, ready, recommended }) => {
              const presentation = cliRuntimePresentation(runtime.id);
              const active = runtime.id === selectedId;
              return (
                <button key={runtime.id} type="button" role="radio" aria-checked={active} className={`jc-launch-option${active ? " selected" : ""}`} data-runtime-id={runtime.id}
                  disabled={!ready || pending} title={ready ? undefined : runtime.statusReason} onClick={() => setRuntimeId(runtime.id)}>
                  {presentation ? <img src={presentation.iconSrc} alt="" aria-hidden="true" /> : <Terminal aria-hidden="true" />}
                  <span className="jc-launch-option-copy">
                    <strong>{runtime.displayName}</strong>
                    <small>{ready ? (recommended ? t(kind.recommendedReason) : t("Ready")) : runtime.statusReason}</small>
                  </span>
                  {recommended && ready ? <span className="jc-tag accent">{t("Recommended")}</span> : null}
                  {active ? <Check className="jc-launch-check" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        )}
        {error && options.length > 0 ? <p className="jc-launch-state error" role="alert">{error}</p> : null}
        <SpaceToggle className="jc-launch-remember" label={t("Remember as my default")} checked={remember} disabled={pending} onChange={setRemember}
          detail={remember ? t("New {kind} panes open with this agent without asking. Change it in {place}.", { kind: kind.label, place: t(kind.settingsPlace) }) : t("The next {kind} pane asks again.", { kind: kind.label })} />
        <footer className="jc-launch-actions">
          <button type="button" className="jc-button" onClick={onClose} disabled={pending}>{t("Cancel")}</button>
          <button type="button" className="jc-button primary" onClick={() => void create()} disabled={!selected?.ready || !accounts || pending}>
            {pending ? t("Opening…") : t("Open with {agent}", { agent: selectedLabel })}
          </button>
        </footer>
      </section>
    </div>
  );
}
