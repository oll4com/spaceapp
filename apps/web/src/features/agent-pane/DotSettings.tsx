import { useEffect, useState, type FormEvent } from "react";
import type { DotModelChoices, DotPermissionMode, DotProfile } from "@space/contracts";
import { api } from "../../api.js";
import { announceDotsUpdated } from "./dot-home-events.js";

const permissionLabels: Record<DotPermissionMode, string> = { approve_for_me: "Approve for me", full_access: "Full access" };

/** Model choices grouped by Chat provider, plus the saved choice when Chat no longer serves it. */
export function DotModelSelect({ value, choices, onChange, label, defaultLabel, disabled = false }: {
  value: string; choices: DotModelChoices | null; onChange: (value: string) => void; label: string; defaultLabel: string; disabled?: boolean;
}) {
  const known = choices?.providers.some((provider) => provider.options.some((option) => option.id === value)) ?? false;
  return <select aria-label={label} value={value} disabled={disabled || !choices} onChange={(event) => onChange(event.currentTarget.value)}>
    <option value="">{defaultLabel}</option>
    {value && choices && !known ? <option value={value}>{`${value} (not available now)`}</option> : null}
    {choices?.providers.map((provider) => <optgroup key={provider.providerId} label={provider.statusReason ? `${provider.providerName} (unavailable)` : provider.providerName}>
      {provider.options.map((option) => <option key={option.id} value={option.id}>{option.reasoningLabel ? `${option.displayName} · ${option.reasoningLabel}` : option.displayName}</option>)}
    </optgroup>)}
  </select>;
}

/** One Dot's profile in Settings → Dots: name, how it talks, its model, permissions and work limit. */
export function DotProfileForm({ dot, choices, onSaved, update = api.updateDot }: {
  dot: DotProfile; choices: DotModelChoices | null; onSaved: (dot: DotProfile) => void; update?: typeof api.updateDot;
}) {
  const [name, setName] = useState(dot.name);
  const [style, setStyle] = useState(dot.preferences.communicationStyle ?? "");
  const [language, setLanguage] = useState(dot.preferences.language ?? "");
  const [model, setModel] = useState(dot.preferences.runtime?.modelConfigId ?? "");
  const [permission, setPermission] = useState<DotPermissionMode | "">(dot.preferences.runtime?.permissionMode ?? "");
  const [maxTasks, setMaxTasks] = useState(dot.workLimits.maxConcurrentTasks);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  useEffect(() => {
    setName(dot.name); setStyle(dot.preferences.communicationStyle ?? ""); setLanguage(dot.preferences.language ?? "");
    setModel(dot.preferences.runtime?.modelConfigId ?? ""); setPermission(dot.preferences.runtime?.permissionMode ?? "");
    setMaxTasks(dot.workLimits.maxConcurrentTasks); setNotice(null);
  }, [dot.dotId, dot.updatedAt]);
  const trimmedLanguage = language.trim();
  const valid = name.trim().length >= 1 && name.trim().length <= 80 && style.length <= 2000
    && (trimmedLanguage.length === 0 || (trimmedLanguage.length >= 2 && trimmedLanguage.length <= 80));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || pending) return;
    setPending(true); setNotice(null);
    try {
      // Empty values clear a preference; the server merges preferences field by field.
      const preferences = { communicationStyle: style.trim(), language: trimmedLanguage,
        runtime: { modelConfigId: model || null, permissionMode: permission || null } };
      const { dot: saved } = await update(dot.dotId, { name: name.trim(), preferences, workLimits: { ...dot.workLimits, maxConcurrentTasks: maxTasks } });
      if (saved.dotId !== dot.dotId) throw Error("Dot identity mismatch.");
      onSaved(saved);
      announceDotsUpdated();
      setNotice({ tone: "status", text: `${saved.name} is saved. The model and permissions apply from its next message.` });
    } catch (err) {
      setNotice({ tone: "alert", text: err instanceof Error ? err.message : "The settings could not be saved." });
    } finally { setPending(false); }
  }
  return <form className="dots-settings-form" aria-label={`${dot.name} profile`} onSubmit={(event) => void submit(event)}>
    <label><span>Name</span>
      <input aria-label="Dot name" value={name} maxLength={80} disabled={pending} onChange={(event) => setName(event.currentTarget.value)} /></label>
    <label><span>Communication style (optional)</span>
      <textarea aria-label="Communication style" rows={3} value={style} maxLength={2000} disabled={pending}
        placeholder="For example: brief, direct, with a summary first" onChange={(event) => setStyle(event.currentTarget.value)} /></label>
    <label><span>Reply language (optional)</span>
      <input aria-label="Reply language" value={language} maxLength={80} disabled={pending} placeholder="Same as my messages"
        onChange={(event) => setLanguage(event.currentTarget.value)} /></label>
    <label><span>Model</span>
      <DotModelSelect label="Dot model" value={model} choices={choices} disabled={pending} defaultLabel="Use the Dots default" onChange={setModel} /></label>
    <label><span>Permissions</span>
      <select aria-label="Dot permissions" value={permission} disabled={pending} onChange={(event) => setPermission(event.currentTarget.value as DotPermissionMode | "")}>
        <option value="">Use the Dots default</option>
        {(Object.keys(permissionLabels) as DotPermissionMode[]).map((mode) => <option key={mode} value={mode}>{permissionLabels[mode]}</option>)}
      </select>
      <small>{dot.name} always acts with your own permissions. Approve for me lets a reviewer approve workspace actions; Full access runs without prompts.</small></label>
    <div className="dots-settings-limit" role="group" aria-label="Tasks at once">
      <span>Tasks at once</span>
      <div className="dots-settings-limit-options">
        {[1, 2, 3, 4, 5, 6].map((value) => <button key={value} type="button" aria-pressed={maxTasks === value} disabled={pending}
          onClick={() => setMaxTasks(value)}>{value}</button>)}
      </div>
      <small>Goals and reminders wait for a free slot. Your own messages are never refused.</small>
    </div>
    {trimmedLanguage.length === 1 ? <p role="alert">Use at least two characters for the language.</p> : null}
    {notice ? <p role={notice.tone}>{notice.text}</p> : null}
    <div className="dots-settings-actions"><button type="submit" disabled={pending || !valid}>{pending ? "Saving…" : "Save"}</button></div>
  </form>;
}
