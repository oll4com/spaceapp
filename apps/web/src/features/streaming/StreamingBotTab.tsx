import type {
  StreamingBotActivity,
  StreamingBotPlatform,
  StreamingBotSettings,
  StreamingBotStatus
} from "@space/contracts";
import {
  Bot,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Save,
  Search,
  Send,
  Trash2
} from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { SpaceApiError, api } from "../../api.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";

const PLATFORM_LABEL: Record<StreamingBotPlatform, string> = { YOUTUBE: "YouTube", TWITCH: "Twitch" };

interface BotTabState {
  settings: StreamingBotSettings;
  status: StreamingBotStatus;
  memoryCount: number;
  activity: StreamingBotActivity[];
}

function emptyState(): BotTabState {
  return {
    settings: {
      version: 1,
      enabled: false,
      persona: { name: "Live Assistant", tone: "Friendly, concise and helpful. Answer only questions about the stream." },
      platforms: { YOUTUBE: { enabled: false, accountId: null }, TWITCH: { enabled: false, accountId: null } },
      facts: [],
      faq: [],
      instructions: "",
      guardrails: { cooldownSeconds: 15, maxRepliesPerMinute: 5, replyToQuestionsOnly: true },
      memoryEnabled: true,
      overlayTickerEnabled: false,
      updatedAt: "",
      updatedBy: null
    },
    status: {
      enabled: false,
      paused: true,
      llmConfigured: false,
      model: null,
      youtubeQuota: { day: "", unitsConsumed: 0, budget: 8000 },
      platforms: {
        YOUTUBE: { connected: false, live: false, chatId: null, lastPollAt: null, lastReplyAt: null, pendingCount: 0 },
        TWITCH: { connected: false, live: false, chatId: null, lastPollAt: null, lastReplyAt: null, pendingCount: 0 }
      }
    },
    memoryCount: 0,
    activity: []
  };
}

export function StreamingBotTab() {
  const [state, setState] = useState<BotTabState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState("");
  const [testPlatform, setTestPlatform] = useState<StreamingBotPlatform>("YOUTUBE");
  const [testReply, setTestReply] = useState<string | null>(null);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryResults, setMemoryResults] = useState<Array<{ id: string; title: string; body: string; createdAt: string }>>([]);
  const [dirty, setDirty] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async (message?: string) => {
    setLoading(true);
    try {
      const [settingsResponse, status, activity] = await Promise.all([
        api.streamingBotSettings(),
        api.streamingBotStatus(),
        api.streamingBotActivity(50)
      ]);
      if (!mounted.current) return;
      setState({
        settings: settingsResponse.settings,
        status,
        memoryCount: settingsResponse.memoryCount,
        activity: activity.data
      });
      setError(null);
      if (message) setNotice(message);
    } catch (loadError) {
      if (!mounted.current) return;
      setError(loadError instanceof Error ? loadError.message : "Streaming bot settings could not be loaded.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  function updateSettings(updater: (settings: StreamingBotSettings) => StreamingBotSettings) {
    setState((current) => current ? { ...current, settings: updater(current.settings) } : current);
    setDirty(true);
    setError(null);
    setNotice(null);
  }

  async function runAction(key: string, action: () => Promise<unknown>, success: string) {
    setPendingAction(key);
    setError(null);
    setNotice(null);
    try {
      await action();
      await load(success);
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
        memoryEnabled: state.settings.memoryEnabled,
        overlayTickerEnabled: state.settings.overlayTickerEnabled
      });
      setState((current) => current ? { ...current, settings: saved } : current);
      setDirty(false);
      setNotice("Streaming bot settings were saved.");
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
    setTestReply(null);
    try {
      const result = await api.testStreamingBot({ platform: testPlatform, message: testMessage });
      setTestReply(result.errorCode ? `No reply (${result.errorCode})` : result.reply);
      await load();
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "The bot test could not run.");
    } finally {
      setPendingAction(null);
    }
  }

  async function clearMemory() {
    await runAction("clear-memory", () => api.clearStreamingBotMemory(), "Streaming bot memory was cleared.");
    setMemoryResults([]);
    setMemoryQuery("");
  }

  async function searchMemory() {
    if (!memoryQuery.trim()) return;
    setPendingAction("search-memory");
    setError(null);
    try {
      const result = await api.searchStreamingBotMemory(memoryQuery.trim(), 20);
      setMemoryResults(result.entries);
      setNotice(`${result.entries.length} memory entr${result.entries.length === 1 ? "y" : "ies"} found.`);
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Memory search failed.");
    } finally {
      setPendingAction(null);
    }
  }

  if (loading && !state) {
    return <div className="streaming-bot-loading" role="status"><Loader2 className="spin" aria-hidden="true" /> Loading bot settings…</div>;
  }

  if (!state) {
    return (
      <div className="streaming-bot-loading">
        {error ? <div className="streaming-message error" role="alert">{error}</div> : null}
        <button type="button" onClick={() => void load()}><RefreshCw aria-hidden="true" /> Retry</button>
      </div>
    );
  }

  const { settings, status } = state;

  return (
    <div className="streaming-bot-tab">
      <section className="streaming-section" aria-labelledby="streaming-bot-overview-heading">
        <div className="streaming-section-heading">
          <div><span className="streaming-eyebrow">Live Q&A</span><h3 id="streaming-bot-overview-heading"><Bot aria-hidden="true" /> Bot</h3></div>
          <span className={`streaming-bot-enabled status-${status.enabled ? "ready" : "error"}`}>{status.enabled ? "Active" : "Paused"}</span>
        </div>
        <div className="streaming-bot-overview-grid">
          <div className="streaming-bot-overview-card">
            <span className="streaming-eyebrow">Language model</span>
            <strong>{status.llmConfigured ? (status.model ?? "Configured") : "Not configured"}</strong>
            <small>{status.llmConfigured ? "DeepSeek V4 Flash via Codex-LB" : "Set SPACE_STREAMING_BOT_* environment variables"}</small>
          </div>
          <div className="streaming-bot-overview-card">
            <span className="streaming-eyebrow">YouTube quota</span>
            <strong>{status.youtubeQuota.unitsConsumed} / {status.youtubeQuota.budget}</strong>
            <small>Daily reply unit budget · {status.youtubeQuota.day || "today"}</small>
          </div>
          <div className="streaming-bot-overview-card">
            <span className="streaming-eyebrow">Memory</span>
            <strong>{state.memoryCount} entr{state.memoryCount === 1 ? "y" : "ies"}</strong>
            <small>Private room · streaming-bot</small>
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
                    <span className={`streaming-bot-badge ${platformStatus.connected ? "ok" : ""}`}>{platformStatus.connected ? "Connected" : "Not connected"}</span>
                    <span className={`streaming-bot-badge ${platformStatus.live ? "ok" : ""}`}>{platformStatus.live ? "Live" : "Offline"}</span>
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
                {platformStatus.live ? <small className="streaming-bot-last-poll">Last polled {platformStatus.lastPollAt ? new Date(platformStatus.lastPollAt).toLocaleTimeString() : "never"} · {platformStatus.pendingCount} pending</small> : null}
              </div>
            );
          })}
        </div>
        <div className="streaming-bot-controls">
          <SpaceToggle
            checked={settings.enabled}
            label="Bot active"
            detail="Worker polls live chats and replies"
            onChange={(checked) => updateSettings((settings) => ({ ...settings, enabled: checked }))}
          />
          <SpaceToggle
            checked={settings.memoryEnabled}
            label="Bot memory"
            detail="Facts learned are kept in a private room"
            onChange={(checked) => updateSettings((settings) => ({ ...settings, memoryEnabled: checked }))}
          />
          <SpaceToggle
            checked={settings.overlayTickerEnabled}
            label="Overlay ticker"
            detail="Show recent Q&A in the streaming overlay (OBS)"
            onChange={(checked) => updateSettings((settings) => ({ ...settings, overlayTickerEnabled: checked }))}
          />
        </div>
      </section>

      {error ? <div className="streaming-message error" role="alert">{error}</div> : null}
      {notice ? <div className="streaming-message notice" role="status">{notice}</div> : null}

      <section className="streaming-section" aria-labelledby="streaming-bot-persona-heading">
        <div className="streaming-section-heading"><div><span className="streaming-eyebrow">Identity</span><h3 id="streaming-bot-persona-heading">Persona</h3></div></div>
        <div className="streaming-bot-field-row">
          <label className="streaming-bot-field">
            <span>Name</span>
            <input
              aria-label="Bot name"
              maxLength={40}
              value={settings.persona.name}
              onChange={(event) => updateSettings((settings) => ({ ...settings, persona: { ...settings.persona, name: event.target.value } }))}
            />
          </label>
          <label className="streaming-bot-field">
            <span>Tone (English only)</span>
            <input
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
          <div><span className="streaming-eyebrow">What the bot knows</span><h3 id="streaming-bot-facts-heading">Facts</h3></div>
          <button type="button" onClick={() => updateSettings((settings) => ({ ...settings, facts: [...settings.facts, { key: "", value: "" }] }))}>Add fact</button>
        </div>
        {settings.facts.length === 0 ? <p className="streaming-empty">No facts yet. Add key-value pairs the bot can answer with.</p> : (
          <ul className="streaming-bot-pair-list">
            {settings.facts.map((fact, index) => (
              <li key={`${fact.key}:${index}`} className="streaming-bot-pair">
                <input aria-label={`Fact key ${index + 1}`} maxLength={80} placeholder="key" value={fact.key} onChange={(event) => updateSettings((settings) => ({
                  ...settings,
                  facts: settings.facts.map((entry, entryIndex) => entryIndex === index ? { ...entry, key: event.target.value } : entry)
                }))} />
                <input aria-label={`Fact value ${index + 1}`} maxLength={500} placeholder="value" value={fact.value} onChange={(event) => updateSettings((settings) => ({
                  ...settings,
                  facts: settings.facts.map((entry, entryIndex) => entryIndex === index ? { ...entry, value: event.target.value } : entry)
                }))} />
                <button type="button" className="danger" aria-label={`Remove fact ${index + 1}`} onClick={() => updateSettings((settings) => ({ ...settings, facts: settings.facts.filter((_, entryIndex) => entryIndex !== index) }))}><Trash2 aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="streaming-section" aria-labelledby="streaming-bot-faq-heading">
        <div className="streaming-section-heading">
          <div><span className="streaming-eyebrow">Common questions</span><h3 id="streaming-bot-faq-heading">FAQ</h3></div>
          <button type="button" onClick={() => updateSettings((settings) => ({ ...settings, faq: [...settings.faq, { question: "", answer: "" }] }))}>Add FAQ</button>
        </div>
        {settings.faq.length === 0 ? <p className="streaming-empty">No FAQ pairs yet.</p> : (
          <ul className="streaming-bot-pair-list">
            {settings.faq.map((entry, index) => (
              <li key={`${entry.question}:${index}`} className="streaming-bot-pair">
                <input aria-label={`FAQ question ${index + 1}`} maxLength={200} placeholder="Question" value={entry.question} onChange={(event) => updateSettings((settings) => ({
                  ...settings,
                  faq: settings.faq.map((faqEntry, entryIndex) => entryIndex === index ? { ...faqEntry, question: event.target.value } : faqEntry)
                }))} />
                <input aria-label={`FAQ answer ${index + 1}`} maxLength={1000} placeholder="Answer" value={entry.answer} onChange={(event) => updateSettings((settings) => ({
                  ...settings,
                  faq: settings.faq.map((faqEntry, entryIndex) => entryIndex === index ? { ...faqEntry, answer: event.target.value } : faqEntry)
                }))} />
                <button type="button" className="danger" aria-label={`Remove FAQ ${index + 1}`} onClick={() => updateSettings((settings) => ({ ...settings, faq: settings.faq.filter((_, entryIndex) => entryIndex !== index) }))}><Trash2 aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="streaming-section" aria-labelledby="streaming-bot-guardrails-heading">
        <div className="streaming-section-heading"><div><span className="streaming-eyebrow">Safety</span><h3 id="streaming-bot-guardrails-heading">Guardrails</h3></div></div>
        <div className="streaming-bot-field-row">
          <label className="streaming-bot-field">
            <span>Cooldown (seconds)</span>
            <input
              aria-label="Reply cooldown seconds"
              type="number" min={0} max={300}
              value={settings.guardrails.cooldownSeconds}
              onChange={(event) => updateSettings((settings) => ({ ...settings, guardrails: { ...settings.guardrails, cooldownSeconds: Number(event.target.value) } }))}
            />
          </label>
          <label className="streaming-bot-field">
            <span>Max replies per minute</span>
            <input
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
        <div className="streaming-section-heading"><div><span className="streaming-eyebrow">Policy</span><h3 id="streaming-bot-instructions-heading">Instructions</h3></div></div>
        <textarea
          aria-label="Streaming bot instructions"
          rows={4} maxLength={4000}
          value={settings.instructions}
          onChange={(event) => updateSettings((settings) => ({ ...settings, instructions: event.target.value }))}
          placeholder="Optional free-text rules the bot must follow (English only)."
        />
        <small>{settings.instructions.length}/4000</small>
      </section>

      <section className="streaming-section" aria-labelledby="streaming-bot-test-heading">
        <div className="streaming-section-heading"><div><span className="streaming-eyebrow">Try it</span><h3 id="streaming-bot-test-heading">Test reply</h3></div></div>
        <div className="streaming-bot-test-row">
          <select aria-label="Test platform" value={testPlatform} onChange={(event) => setTestPlatform(event.target.value as StreamingBotPlatform)}>
            <option value="YOUTUBE">YouTube</option>
            <option value="TWITCH">Twitch</option>
          </select>
          <input
            aria-label="Test message"
            maxLength={500}
            value={testMessage}
            onChange={(event) => setTestMessage(event.target.value)}
            placeholder="Ask the bot something…"
          />
          <button type="button" onClick={() => void test()} disabled={pendingAction !== null || !testMessage.trim()}>
            {pendingAction === "test" ? <Loader2 className="spin" aria-hidden="true" /> : <Send aria-hidden="true" />} Test
          </button>
        </div>
        {testReply ? <p className="streaming-bot-test-reply" role="status">{testReply}</p> : null}
      </section>

      <section className="streaming-section" aria-labelledby="streaming-bot-memory-heading">
        <div className="streaming-section-heading">
          <div><span className="streaming-eyebrow">Private memory</span><h3 id="streaming-bot-memory-heading">Memory</h3></div>
          <button type="button" className="danger" onClick={() => void clearMemory()} disabled={pendingAction !== null}>
            {pendingAction === "clear-memory" ? <Loader2 className="spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />} Clear
          </button>
        </div>
        <div className="streaming-bot-test-row">
          <input
            aria-label="Memory search"
            maxLength={200}
            value={memoryQuery}
            onChange={(event) => setMemoryQuery(event.target.value)}
            placeholder="Search learned facts…"
            onKeyDown={(event) => { if (event.key === "Enter") void searchMemory(); }}
          />
          <button type="button" onClick={() => void searchMemory()} disabled={pendingAction !== null || !memoryQuery.trim()}>
            {pendingAction === "search-memory" ? <Loader2 className="spin" aria-hidden="true" /> : <Search aria-hidden="true" />} Search
          </button>
        </div>
        {memoryResults.length > 0 ? (
          <ul className="streaming-bot-memory-results">
            {memoryResults.map((entry) => (
              <li key={entry.id}><strong>{entry.title}</strong><p>{entry.body}</p></li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="streaming-section" aria-labelledby="streaming-bot-activity-heading">
        <div className="streaming-section-heading">
          <div><span className="streaming-eyebrow">Recent events</span><h3 id="streaming-bot-activity-heading">Activity</h3></div>
          <button type="button" className="icon-button" aria-label="Refresh activity" title="Refresh" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? "spin" : undefined} aria-hidden="true" />
          </button>
        </div>
        {state.activity.length === 0 ? <p className="streaming-empty">No activity yet. The bot logs replies and skipped messages here.</p> : (
          <ul className="streaming-bot-activity">
            {state.activity.map((record) => (
              <li key={record.id} data-direction={record.direction} data-status={record.status}>
                <span className="streaming-bot-activity-heading">
                  <strong>{record.direction === "IN" ? "Viewer" : "Bot"} · {PLATFORM_LABEL[record.platform]}</strong>
                  <time>{new Date(record.createdAt).toLocaleTimeString()}</time>
                  <span className={`streaming-bot-badge ${record.status === "REPLIED" ? "ok" : ""}`}>{record.status}</span>
                </span>
                <p>{record.message}</p>
                {record.reply ? <p className="streaming-bot-activity-reply">→ {record.reply}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="streaming-bot-actions">
        <button type="button" className="streaming-save-button" onClick={() => void save()} disabled={pendingAction !== null || !dirty}>
          {pendingAction === "save" ? <Loader2 className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />} Save settings
        </button>
        {settings.enabled ? (
          <button type="button" className="danger" onClick={() => void runAction("pause", () => api.pauseStreamingBot(), "Bot paused.")} disabled={pendingAction !== null}>
            <Pause aria-hidden="true" /> Pause
          </button>
        ) : (
          <button type="button" onClick={() => void runAction("resume", () => api.resumeStreamingBot(), "Bot resumed.")} disabled={pendingAction !== null}>
            <Play aria-hidden="true" /> Resume
          </button>
        )}
      </div>
    </div>
  );
}