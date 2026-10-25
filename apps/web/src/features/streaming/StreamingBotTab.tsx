import type {
  StreamingBotPlatform,
  StreamingBotSettings,
  StreamingBotStatus,
  StreamingPlatformAccount
} from "@space/contracts";
import {
  AlertTriangle,
  CheckCircle2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Send,
  Trash2
} from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { SpaceApiError, api } from "../../api.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { DockButton, DockIconButton, DockNotice, DockState } from "../dock-kit/DockKit.js";
import { readableCode } from "./streaming-labels.js";

const PLATFORM_LABEL: Record<StreamingBotPlatform, string> = { YOUTUBE: "YouTube", TWITCH: "Twitch" };

interface BotTabState {
  settings: StreamingBotSettings;
  status: StreamingBotStatus;
  memoryCount: number;
  accounts: StreamingPlatformAccount[];
  models: Array<{ kind: "API" | "CLI"; providerId: string; modelId: string; label: string; available: boolean; reason: string | null }>;
}

export function StreamingBotTab({ active = true, onStatus }: {
  /** Polls the bot status while true (the tab is shown and the dock is visible). */
  active?: boolean;
  onStatus?: (status: StreamingBotStatus) => void;
} = {}) {
  const [state, setState] = useState<BotTabState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState("");
  const [testPlatform, setTestPlatform] = useState<StreamingBotPlatform>("YOUTUBE");
  const [testResult, setTestResult] = useState<{ text: string; model: string | null } | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [dirty, setDirty] = useState(false);
  /** Shows "saved" after a settings save until the next edit. */
  const [justSaved, setJustSaved] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async (message?: string) => {
    setLoading(true);
    try {
      const [settingsResponse, status, catalog, modelCatalog] = await Promise.all([
        api.streamingBotSettings(),
        api.streamingBotStatus(),
        api.streamingCatalog(),
        api.streamingBotModels()
      ]);
      if (!mounted.current) return;
      setState({
        settings: settingsResponse.settings,
        status,
        memoryCount: settingsResponse.memoryCount,
        accounts: catalog.accounts.filter(account => account.status === "ACTIVE"),
        models: modelCatalog.models
      });
      onStatus?.(status);
      setDirty(false);
      setError(null);
      if (message) setNotice(message);
    } catch (loadError) {
      if (!mounted.current) return;
      setError(loadError instanceof Error ? loadError.message : "Streaming bot settings could not be loaded.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [onStatus]);

  /** Refreshes only the status, never the settings draft. */
  const refreshStatus = useCallback(async () => {
    try {
      const status = await api.streamingBotStatus();
      if (!mounted.current) return;
      setState((current) => current ? { ...current, status } : current);
      onStatus?.(status);
    } catch {
      // A failed poll keeps the last status; the next one retries.
    }
  }, [onStatus]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshStatus();
    }, 15_000);
    return () => clearInterval(timer);
  }, [active, refreshStatus]);

  function updateSettings(updater: (settings: StreamingBotSettings) => StreamingBotSettings) {
    setState((current) => current ? { ...current, settings: updater(current.settings) } : current);
    setDirty(true);
    setJustSaved(false);
    setError(null);
    setNotice(null);
  }

  /** Pause/Resume change only `enabled` on the server; the rest of an unsaved draft stays as typed. */
  async function setBotActive(key: "pause" | "resume", action: () => Promise<StreamingBotSettings>, success: string) {
    setPendingAction(key);
    setError(null);
    setNotice(null);
    try {
      const saved = await action();
      setState((current) => current ? {
        ...current,
        settings: dirty ? { ...current.settings, enabled: saved.enabled, version: saved.version } : saved
      } : current);
      await refreshStatus();
      setNotice(success);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Streaming bot action failed.");
    } finally {
      setPendingAction(null);
    }
  }

  async function save() {
    if (!state) return;
    setPendingAction("save");
    setError(null);
    setNotice(null);
    try {
      const saved = await api.updateStreamingBotSettings({
        expectedVersion: state.settings.version,
        enabled: state.settings.enabled,
        persona: state.settings.persona,
        platforms: state.settings.platforms,
        facts: state.settings.facts,
        faq: state.settings.faq,
        instructions: state.settings.instructions,
        guardrails: state.settings.guardrails,
        modelSelection: state.settings.modelSelection,
        fallbackModelSelection: state.settings.fallbackModelSelection,
        memoryEnabled: state.settings.memoryEnabled,
        moderationEnabled: state.settings.moderationEnabled,
        jevEnabled: state.settings.jevEnabled,
        overlayTickerEnabled: state.settings.overlayTickerEnabled
      });
      setState((current) => current ? { ...current, settings: saved } : current);
      setDirty(false);
      setJustSaved(true);
    } catch (saveError) {
      if (saveError instanceof SpaceApiError && saveError.status === 409) {
        await load("A newer bot settings version was loaded. Review it before saving again.");
      } else {
        setError(saveError instanceof Error ? saveError.message : "Streaming bot settings could not be saved.");
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function test() {
    if (!state) return;
    setPendingAction("test");
    setError(null);
    setNotice(null);
    setTestResult(null);
    try {
      const result = await api.testStreamingBot({ platform: testPlatform, message: testMessage });
      setTestResult({
        text: result.errorCode ? `No reply: ${readableCode(result.errorCode)}` : result.reply ?? "No reply needed for this message.",
        model: result.model
      });
      await refreshStatus();
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "The bot test could not run.");
    } finally {
      setPendingAction(null);
    }
  }

  if (loading && !state) {
    return <DockState kind="loading" title="Loading bot settings…" className="streaming-bot-loading" />;
  }

  if (!state) {
    return (
      <DockState
        kind="error"
        title="Bot settings could not be loaded"
        detail={error ?? "Try again in a moment."}
        action={{ label: "Try again", icon: RefreshCw, onClick: () => void load() }}
      />
    );
  }

  const { settings, status } = state;
  // An API from before the setup checklist answers without it while a deploy settles.
  const setup = status.setup ?? [];
  const saving = pendingAction === "save";

  return (
    <div className="streaming-bot-tab">
      <div className="streaming-status-stack">
        {saving ? (
          <DockNotice tone="info" className="streaming-save-status">Saving bot settings…</DockNotice>
        ) : dirty ? (
          <DockNotice tone="warning" className="streaming-save-status">
            <span>Unsaved bot settings</span>
            <DockButton icon={Save} className="streaming-save-now" onClick={() => void save()} disabled={pendingAction !== null}>
              Save now
            </DockButton>
          </DockNotice>
        ) : justSaved ? (
          <DockNotice tone="success" className="streaming-save-status" onDismiss={() => setJustSaved(false)}>Bot settings saved.</DockNotice>
        ) : null}
        {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
        {notice ? <DockNotice tone="info" onDismiss={() => setNotice(null)}>{notice}</DockNotice> : null}
      </div>

      {setup.length > 0 ? (
        <section className="streaming-section" aria-labelledby="streaming-bot-setup-heading">
          <div className="streaming-section-heading">
            <h3 id="streaming-bot-setup-heading" className="dock-kit-section-title">Setup</h3>
            {setup.every((item) => item.ok)
              ? <span className="dock-kit-badge is-success">Ready</span>
              : <span className="dock-kit-badge is-warning">{setup.filter((item) => item.ok).length}/{setup.length} ready</span>}
          </div>
          <ul className="streaming-setup-list">
            {setup.map((item) => (
              <li key={item.id} className={`streaming-setup-item ${item.ok ? "is-ok" : "is-missing"}`}>
                {item.ok ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
                <div>
                  <strong>{item.label}</strong>
                  <span className="streaming-hint">{item.ok ? "Ready" : item.hint}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="streaming-section" aria-labelledby="streaming-bot-overview-heading">
        <div className="streaming-section-heading">
          <h3 id="streaming-bot-overview-heading" className="dock-kit-section-title">Live Q&amp;A bot</h3>
          <span className={`dock-kit-badge ${status.enabled ? "is-success" : "is-warning"}`}>{status.enabled ? "Active" : "Paused"}</span>
        </div>
        <div className="streaming-bot-overview-grid">
          <div className="streaming-bot-overview-card">
            <span className="streaming-bot-card-label">Language model</span>
            <strong>{status.llmConfigured ? (status.model ?? "Configured") : "Not configured"}</strong>
            <small>{status.llmConfigured ? "Through the bot's Space Gateway key" : "Choose a model under Provider & model"}</small>
          </div>
          <div className="streaming-bot-overview-card">
            <span className="streaming-bot-card-label">YouTube quota</span>
            <strong>{status.youtubeQuota.unitsConsumed} / {status.youtubeQuota.budget}</strong>
            <small>Daily reply unit budget · {status.youtubeQuota.day || "today"}</small>
          </div>
          <div className="streaming-bot-overview-card">
            <span className="streaming-bot-card-label">Memory</span>
            <strong>{state.memoryCount} entr{state.memoryCount === 1 ? "y" : "ies"}</strong>
            <small>Separate reviewed Streaming memory</small>
          </div>
        </div>
        <div className="streaming-bot-platform-grid">
          {(["YOUTUBE", "TWITCH"] as const).map((platform) => {
            const platformStatus = status.platforms[platform];
            const platformSettings = settings.platforms[platform];
            return (
              <div className="streaming-bot-platform-card" key={platform} data-platform={platform}>
                <div className="streaming-account-heading">
                  <div><strong>{PLATFORM_LABEL[platform]}</strong><span>{platformSettings.enabled ? "Enabled" : "Disabled"}</span></div>
                  <div className="streaming-inline-actions">
                    <span className={`dock-kit-badge ${platformStatus.connected ? "is-success" : ""}`}>{platformStatus.connected ? "Connected" : "Not connected"}</span>
                    <span className={`dock-kit-badge ${platformStatus.live ? "is-success" : ""}`}>{platformStatus.live ? "Live" : "Offline"}</span>
                  </div>
                </div>
                <SpaceToggle
                  checked={platformSettings.enabled}
                  label={`Answer on ${PLATFORM_LABEL[platform]}`}
                  onChange={(checked) => updateSettings((settings) => ({
                    ...settings,
                    platforms: { ...settings.platforms, [platform]: { ...settings.platforms[platform], enabled: checked } }
                  }))}
                />
                <label className="streaming-bot-field">
                  <span>Connected account</span>
                  <select className="dock-kit-select" aria-label={`${PLATFORM_LABEL[platform]} bot account`} value={platformSettings.accountId ?? ""}
                    onChange={event => updateSettings(settings => ({ ...settings, platforms: {
                      ...settings.platforms, [platform]: { ...settings.platforms[platform], accountId: event.target.value || null }
                    } }))}>
                    <option value="">Select account</option>
                    {state.accounts.filter(account => account.provider === platform).map(account => <option key={account.id} value={account.id}>{account.displayName}</option>)}
                  </select>
                </label>
                {platformStatus.live ? <small className="streaming-hint">Last checked {platformStatus.lastPollAt ? new Date(platformStatus.lastPollAt).toLocaleTimeString() : "never"} · {platformStatus.pendingCount} waiting</small> : null}
              </div>
            );
          })}
        </div>
        <div className="streaming-bot-controls">
          <SpaceToggle
            checked={settings.enabled}
            label="Bot active"
            detail="Reads live chats and replies"
            onChange={(checked) => updateSettings((settings) => ({ ...settings, enabled: checked }))}
          />
          <SpaceToggle
            checked={settings.memoryEnabled}
            label="Bot memory"
            detail="New facts wait for your review"
            onChange={(checked) => updateSettings((settings) => ({ ...settings, memoryEnabled: checked }))}
          />
          <SpaceToggle checked={settings.moderationEnabled} label="Moderation active"
            detail="Separate from bot replies; uses verified platform permissions"
            onChange={(checked) => updateSettings((settings) => ({ ...settings, moderationEnabled: checked }))} />
          <SpaceToggle checked={settings.jevEnabled} label="Fast message screening"
            detail="Optional quick classifier for chat messages; unclear ones go to review"
            onChange={(checked) => updateSettings((settings) => ({ ...settings, jevEnabled: checked }))} />
          <SpaceToggle
            checked={settings.overlayTickerEnabled}
            label="Overlay ticker"
            detail="Show recent questions and answers in the streaming overlay (OBS)"
            onChange={(checked) => updateSettings((settings) => ({ ...settings, overlayTickerEnabled: checked }))}
          />
        </div>
      </section>

      <section className="streaming-section" aria-labelledby="streaming-bot-model-heading">
        <div className="streaming-section-heading"><h3 id="streaming-bot-model-heading" className="dock-kit-section-title">Provider &amp; model</h3></div>
        <p className="streaming-hint">Claude or OpenAI API through Space Gateway, on the bot's own key with a daily limit. The fallback answers when the primary fails.</p>
        <input className="dock-kit-field" aria-label="Search streaming models" maxLength={120} value={modelQuery} onChange={event => setModelQuery(event.target.value)} placeholder="Search providers and models…" />
        <div className="streaming-bot-field-row">
          <label className="streaming-bot-field"><span>Primary model</span>
            <select className="dock-kit-select" aria-label="Streaming primary model" value={settings.modelSelection ? `${settings.modelSelection.kind}|${settings.modelSelection.providerId}|${settings.modelSelection.modelId}` : ""}
              onChange={event => updateSettings(settings => ({ ...settings, modelSelection: event.target.value ? (() => {
                const [kind, providerId, modelId] = event.target.value.split("|");
                return { kind: kind as "API" | "CLI", providerId: providerId!, modelId: modelId! };
              })() : null }))}>
              <option value="">Select model</option>
              {state.models.filter(model => model.label.toLowerCase().includes(modelQuery.toLowerCase()) || settings.modelSelection?.modelId === model.modelId)
                .map(model => <option key={`${model.kind}|${model.providerId}|${model.modelId}`} value={`${model.kind}|${model.providerId}|${model.modelId}`} disabled={!model.available}>
                  {model.label}{model.available ? "" : " · unavailable"}
                </option>)}
            </select>
          </label>
          <label className="streaming-bot-field"><span>Fallback model (optional)</span>
            <select className="dock-kit-select" aria-label="Streaming fallback model" value={settings.fallbackModelSelection ? `${settings.fallbackModelSelection.kind}|${settings.fallbackModelSelection.providerId}|${settings.fallbackModelSelection.modelId}` : ""}
              onChange={event => updateSettings(settings => ({ ...settings, fallbackModelSelection: event.target.value ? (() => {
                const [kind, providerId, modelId] = event.target.value.split("|");
                return { kind: kind as "API" | "CLI", providerId: providerId!, modelId: modelId! };
              })() : null }))}>
              <option value="">No fallback</option>
              {state.models.filter(model => model.label.toLowerCase().includes(modelQuery.toLowerCase()) || settings.fallbackModelSelection?.modelId === model.modelId)
                .map(model => <option key={`${model.kind}|${model.providerId}|${model.modelId}`} value={`${model.kind}|${model.providerId}|${model.modelId}`} disabled={!model.available}>
                  {model.label}{model.available ? "" : " · unavailable"}
                </option>)}
            </select>
          </label>
        </div>
        {state.models.filter(model => !model.available && model.label.toLowerCase().includes(modelQuery.toLowerCase())).slice(0, 3)
          .map(model => <small className="streaming-hint" key={`${model.kind}|${model.providerId}|${model.modelId}`}>{model.label}: {model.reason}</small>)}
      </section>

      <section className="streaming-section" aria-labelledby="streaming-bot-persona-heading">
        <div className="streaming-section-heading"><h3 id="streaming-bot-persona-heading" className="dock-kit-section-title">Persona</h3></div>
        <div className="streaming-bot-field-row">
          <label className="streaming-bot-field">
            <span>Name</span>
            <input
              className="dock-kit-field"
              aria-label="Bot name"
              maxLength={40}
              value={settings.persona.name}
              onChange={(event) => updateSettings((settings) => ({ ...settings, persona: { ...settings.persona, name: event.target.value } }))}
            />
          </label>
          <label className="streaming-bot-field">
            <span>Tone (English only)</span>
            <input
              className="dock-kit-field"
              aria-label="Bot tone"
              maxLength={200}
              value={settings.persona.tone}
              onChange={(event) => updateSettings((settings) => ({ ...settings, persona: { ...settings.persona, tone: event.target.value } }))}
            />
          </label>
        </div>
      </section>

      <section className="streaming-section" aria-labelledby="streaming-bot-facts-heading">
        <div className="streaming-section-heading">
          <h3 id="streaming-bot-facts-heading" className="dock-kit-section-title">Facts</h3>
          <DockButton icon={Plus} onClick={() => updateSettings((settings) => ({ ...settings, facts: [...settings.facts, { key: "", value: "" }] }))}>Add fact</DockButton>
        </div>
        {settings.facts.length === 0 ? <p className="streaming-hint">No facts yet. Add short facts the bot can answer with, such as the stream schedule.</p> : (
          <ul className="streaming-bot-pair-list">
            {settings.facts.map((fact, index) => (
              <li key={`fact:${index}`} className="streaming-bot-pair">
                <input className="dock-kit-field" aria-label={`Fact key ${index + 1}`} maxLength={80} placeholder="Topic" value={fact.key} onChange={(event) => updateSettings((settings) => ({
                  ...settings,
                  facts: settings.facts.map((entry, entryIndex) => entryIndex === index ? { ...entry, key: event.target.value } : entry)
                }))} />
                <input className="dock-kit-field" aria-label={`Fact value ${index + 1}`} maxLength={500} placeholder="Answer" value={fact.value} onChange={(event) => updateSettings((settings) => ({
                  ...settings,
                  facts: settings.facts.map((entry, entryIndex) => entryIndex === index ? { ...entry, value: event.target.value } : entry)
                }))} />
                <DockIconButton tone="danger" icon={Trash2} label={`Remove fact ${index + 1}`} onClick={() => updateSettings((settings) => ({ ...settings, facts: settings.facts.filter((_, entryIndex) => entryIndex !== index) }))} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="streaming-section" aria-labelledby="streaming-bot-faq-heading">
        <div className="streaming-section-heading">
          <h3 id="streaming-bot-faq-heading" className="dock-kit-section-title">FAQ</h3>
          <DockButton icon={Plus} onClick={() => updateSettings((settings) => ({ ...settings, faq: [...settings.faq, { question: "", answer: "" }] }))}>Add FAQ</DockButton>
        </div>
        {settings.faq.length === 0 ? <p className="streaming-hint">No questions yet. Add common viewer questions and their answers.</p> : (
          <ul className="streaming-bot-pair-list">
            {settings.faq.map((entry, index) => (
              <li key={`faq:${index}`} className="streaming-bot-pair">
                <input className="dock-kit-field" aria-label={`FAQ question ${index + 1}`} maxLength={200} placeholder="Question" value={entry.question} onChange={(event) => updateSettings((settings) => ({
                  ...settings,
                  faq: settings.faq.map((faqEntry, entryIndex) => entryIndex === index ? { ...faqEntry, question: event.target.value } : faqEntry)
                }))} />
                <input className="dock-kit-field" aria-label={`FAQ answer ${index + 1}`} maxLength={1000} placeholder="Answer" value={entry.answer} onChange={(event) => updateSettings((settings) => ({
                  ...settings,
                  faq: settings.faq.map((faqEntry, entryIndex) => entryIndex === index ? { ...faqEntry, answer: event.target.value } : faqEntry)
                }))} />
                <DockIconButton tone="danger" icon={Trash2} label={`Remove FAQ ${index + 1}`} onClick={() => updateSettings((settings) => ({ ...settings, faq: settings.faq.filter((_, entryIndex) => entryIndex !== index) }))} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="streaming-section" aria-labelledby="streaming-bot-guardrails-heading">
        <div className="streaming-section-heading"><h3 id="streaming-bot-guardrails-heading" className="dock-kit-section-title">Guardrails</h3></div>
        <div className="streaming-bot-field-row">
          <label className="streaming-bot-field">
            <span>Cooldown (seconds)</span>
            <input
              className="dock-kit-field"
              aria-label="Reply cooldown seconds"
              type="number" min={0} max={300}
              value={settings.guardrails.cooldownSeconds}
              onChange={(event) => updateSettings((settings) => ({ ...settings, guardrails: { ...settings.guardrails, cooldownSeconds: Number(event.target.value) } }))}
            />
          </label>
          <label className="streaming-bot-field">
            <span>Max replies per minute</span>
            <input
              className="dock-kit-field"
              aria-label="Max replies per minute"
              type="number" min={1} max={60}
              value={settings.guardrails.maxRepliesPerMinute}
              onChange={(event) => updateSettings((settings) => ({ ...settings, guardrails: { ...settings.guardrails, maxRepliesPerMinute: Number(event.target.value) } }))}
            />
          </label>
        </div>
        <SpaceToggle
          checked={settings.guardrails.replyToQuestionsOnly}
          label="Questions only"
          detail="Never reply to messages that are not questions"
          onChange={(checked) => updateSettings((settings) => ({ ...settings, guardrails: { ...settings.guardrails, replyToQuestionsOnly: checked } }))}
        />
      </section>

      <section className="streaming-section" aria-labelledby="streaming-bot-instructions-heading">
        <div className="streaming-section-heading"><h3 id="streaming-bot-instructions-heading" className="dock-kit-section-title">Instructions</h3></div>
        <textarea
          className="dock-kit-field"
          aria-label="Streaming bot instructions"
          rows={4} maxLength={4000}
          value={settings.instructions}
          onChange={(event) => updateSettings((settings) => ({ ...settings, instructions: event.target.value }))}
          placeholder="Optional free-text rules the bot must follow (English only)."
        />
        <small className="dock-kit-counter">{settings.instructions.length}/4000</small>
      </section>

      <section className="streaming-section" aria-labelledby="streaming-bot-test-heading">
        <div className="streaming-section-heading"><h3 id="streaming-bot-test-heading" className="dock-kit-section-title">Test reply</h3></div>
        <div className="streaming-bot-test-row">
          <select className="dock-kit-select" aria-label="Test platform" value={testPlatform} onChange={(event) => setTestPlatform(event.target.value as StreamingBotPlatform)}>
            <option value="YOUTUBE">YouTube</option>
            <option value="TWITCH">Twitch</option>
          </select>
          <input
            className="dock-kit-field"
            aria-label="Test message"
            maxLength={500}
            value={testMessage}
            onChange={(event) => setTestMessage(event.target.value)}
            placeholder="Ask the bot something…"
          />
          <DockButton icon={Send} busy={pendingAction === "test"} onClick={() => void test()} disabled={pendingAction !== null || !testMessage.trim()}>
            Test
          </DockButton>
        </div>
        <small className="streaming-hint">Tests use the saved settings and post nothing to chat.</small>
        {testResult ? (
          <p className="streaming-bot-test-reply" role="status">
            {testResult.text}
            {testResult.model ? <small className="dock-kit-meta-text"> · {testResult.model}</small> : null}
          </p>
        ) : null}
      </section>

      <div className="streaming-bot-actions">
        <DockButton tone="primary" icon={Save} busy={saving} className="streaming-save-button" onClick={() => void save()} disabled={pendingAction !== null || !dirty}>
          Save settings
        </DockButton>
        {status.enabled ? (
          <DockButton icon={Pause} busy={pendingAction === "pause"} onClick={() => void setBotActive("pause", () => api.pauseStreamingBot(), "Bot paused.")} disabled={pendingAction !== null}>
            Pause
          </DockButton>
        ) : (
          <DockButton icon={Play} busy={pendingAction === "resume"} onClick={() => void setBotActive("resume", () => api.resumeStreamingBot(), "Bot resumed.")} disabled={pendingAction !== null}>
            Resume
          </DockButton>
        )}
      </div>
    </div>
  );
}
