import { useCallback, useEffect, useState } from "react";
import type { GatewayAccount, GatewayLanMode, GatewayRoutingStrategy, GatewaySettings, GatewaySettingsUpdateRequest, GatewayStatus, GatewayStreamTransport,
  GatewayWindowChoice } from "@space/contracts";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { errorText, type SpaceGatewayClient } from "./gateway-client.js";
import { accountName, planLabel, routingStrategyOptions } from "./space-gateway-model.js";
import { AnthropicBillingSection } from "./GatewayAnthropicSection.js";

type Message = { tone: "ok" | "error"; text: string } | null;

export function useSettingsSaver(client: SpaceGatewayClient, onSaved: (settings: GatewaySettings) => void) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const save = useCallback(async (patch: GatewaySettingsUpdateRequest, success = "Settings saved."): Promise<boolean> => {
    setSaving(true);
    try { onSaved(await client.updateSettings(patch)); setMessage({ tone: "ok", text: success }); return true; }
    catch (reason) { setMessage({ tone: "error", text: errorText(reason, "Could not save settings.") }); return false; }
    finally { setSaving(false); }
  }, [client, onSaved]);
  return { saving, message, setMessage, save };
}

export function SaveMessage({ message }: { message: Message }) {
  if (!message) return null;
  return <p className={message.tone === "ok" ? "space-gateway-success" : "space-gateway-alert"} role={message.tone === "ok" ? "status" : "alert"}>{message.text}</p>;
}

function Segmented<T extends string>({ legend, value, options, onChange, name }: {
  legend: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; name: string;
}) {
  return (
    <fieldset className="space-gateway-segmented">
      <legend>{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className={value === option.value ? "active" : undefined}>
          <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

const windowOptions: { value: GatewayWindowChoice; label: string }[] = [{ value: "PRIMARY", label: "5h" }, { value: "SECONDARY", label: "Weekly" }, { value: "BOTH", label: "Both" }];

function DisplaySection({ settings, client, onSaved }: { settings: GatewaySettings; client: SpaceGatewayClient; onSaved: (settings: GatewaySettings) => void }) {
  const [timeFormat, setTimeFormat] = useState(settings.displayTimeFormat);
  const [windows, setWindows] = useState(settings.displayAccountWindows);
  const [burn, setBurn] = useState(settings.displayBurnProjection);
  const { saving, message, save } = useSettingsSaver(client, onSaved);
  return (
    <form className="gw-card" aria-label="Display" onSubmit={(event) => { event.preventDefault(); void save({ displayTimeFormat: timeFormat, displayAccountWindows: windows, displayBurnProjection: burn }); }}>
      <header><h3>Display</h3></header>
      <Segmented legend="Time format" name="time-format" value={timeFormat} onChange={setTimeFormat} options={[{ value: "12H", label: "12-hour" }, { value: "24H", label: "24-hour" }]} />
      <Segmented legend="Account usage rows" name="account-windows" value={windows} onChange={setWindows} options={windowOptions} />
      <SpaceToggle checked={burn} label="Account burn projection" detail="Show how many accounts the current pace uses per 5h and per week." onChange={setBurn} />
      <SaveMessage message={message} />
      <button type="submit" className="space-gateway-button primary" disabled={saving}>Save display</button>
    </form>
  );
}

function WarmupSection({ settings, client, onSaved }: { settings: GatewaySettings; client: SpaceGatewayClient; onSaved: (settings: GatewaySettings) => void }) {
  const [enabled, setEnabled] = useState(settings.warmupEnabled);
  const [windows, setWindows] = useState(settings.warmupWindows);
  const [model, setModel] = useState(settings.warmupModel);
  const [prompt, setPrompt] = useState(settings.warmupPrompt);
  const [cooldown, setCooldown] = useState(String(Math.round(settings.warmupCooldownSeconds / 60)));
  const [available, setAvailable] = useState(String(settings.warmupMinAvailablePercent));
  const [accounts, setAccounts] = useState<GatewayAccount[] | null>(null);
  const [accountMessage, setAccountMessage] = useState<Message>(null);
  const { saving, message, setMessage, save } = useSettingsSaver(client, onSaved);
  useEffect(() => { client.accounts().then((result) => setAccounts(result.data.filter((account) => account.provider === "CODEX")), () => setAccounts([])); }, [client]);
  return (
    <form className="gw-card" aria-label="Limit warm-up" onSubmit={(event) => {
      event.preventDefault();
      const minutes = Number(cooldown);
      const percent = Number(available);
      if (!Number.isInteger(minutes) || minutes < 1) { setMessage({ tone: "error", text: "The cooldown must be a whole number of minutes." }); return; }
      if (!(percent > 0 && percent <= 100)) { setMessage({ tone: "error", text: "The free share must be above 0 and at most 100." }); return; }
      void save({ warmupEnabled: enabled, warmupWindows: windows, warmupModel: model.trim() || "auto", warmupPrompt: prompt.trim() || "Say OK.",
        warmupCooldownSeconds: minutes * 60, warmupMinAvailablePercent: percent });
    }}>
      <header><h3>Limit warm-up</h3></header>
      <p className="space-gateway-note">A Codex usage window starts counting with the first request after it resets. Right after a confirmed reset, Space Gateway sends one tiny request with each opted-in account so the next window starts, and resets, sooner. Warm-up requests are left out of every statistic.</p>
      <SpaceToggle checked={enabled} label="Limit warm-up" onChange={setEnabled} />
      <Segmented legend="Windows" name="warmup-windows" value={windows} onChange={setWindows} options={windowOptions} />
      <div className="space-gateway-field-row">
        <label className="space-gateway-field">Model<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="auto" />
          <span>"auto" uses the cheapest model the account's plan offers.</span></label>
        <label className="space-gateway-field">Prompt<input value={prompt} maxLength={512} onChange={(event) => setPrompt(event.target.value)} /></label>
        <label className="space-gateway-field">Cooldown per account (minutes)<input type="number" min={1} value={cooldown} onChange={(event) => setCooldown(event.target.value)} /></label>
        <label className="space-gateway-field">Free share that confirms a reset (%)<input type="number" min={1} max={100} value={available} onChange={(event) => setAvailable(event.target.value)} /></label>
      </div>
      <SaveMessage message={message} />
      <button type="submit" className="space-gateway-button primary" disabled={saving}>Save warm-up</button>
      <h4>Accounts</h4>
      {accounts === null ? <p className="space-gateway-empty">Loading accounts…</p> : accounts.length === 0 ? <p className="space-gateway-empty">No ChatGPT (Codex) accounts yet.</p> : (
        <ul className="gw-optin-list">
          {accounts.map((account) => (
            <li key={account.id}>
              <SpaceToggle checked={account.warmupEnabled} label={accountName(account)} detail={planLabel(account.planType)}
                onChange={(checked) => {
                  client.updateAccount(account.id, { warmupEnabled: checked }).then((updated) => {
                    setAccounts((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? null);
                    setAccountMessage(null);
                  }, (reason) => setAccountMessage({ tone: "error", text: errorText(reason, "Could not change warm-up.") }));
                }} />
            </li>
          ))}
        </ul>
      )}
      <SaveMessage message={accountMessage} />
    </form>
  );
}

const transportOptions: { value: GatewayStreamTransport; label: string; description: string }[] = [
  { value: "DEFAULT", label: "Default", description: "HTTP requests stay on HTTP; Codex clients that connect over WebSocket keep a WebSocket to ChatGPT." },
  { value: "HTTP", label: "HTTP", description: "Everything goes over HTTP; Codex clients that try WebSocket are told to use HTTP." },
  { value: "WEBSOCKET", label: "WebSocket", description: "HTTP requests are carried over a WebSocket to ChatGPT as well. After a failed WebSocket open, HTTP is used for 60 seconds." }
];

function PoliciesSection({ settings, client, onSaved }: { settings: GatewaySettings; client: SpaceGatewayClient; onSaved: (settings: GatewaySettings) => void }) {
  const [transport, setTransport] = useState<GatewayStreamTransport>(settings.upstreamStreamTransport);
  const [ttl, setTtl] = useState(String(Math.round(settings.promptCacheTtlSeconds / 60)));
  const [withoutOverwrite, setWithoutOverwrite] = useState(settings.importWithoutOverwrite);
  const { saving, message, setMessage, save } = useSettingsSaver(client, onSaved);
  return (
    <form className="gw-card" aria-label="Policies" onSubmit={(event) => {
      event.preventDefault();
      const minutes = Number(ttl);
      if (!Number.isInteger(minutes) || minutes < 1) { setMessage({ tone: "error", text: "The affinity time must be a whole number of minutes." }); return; }
      void save({ promptCacheTtlSeconds: minutes * 60, importWithoutOverwrite: withoutOverwrite,
        upstreamStreamTransport: transport });
    }}>
      <header><h3>Policies</h3></header>
      <div className="space-gateway-field-row">
        <label className="space-gateway-field">Prompt-cache affinity (minutes)
          <input type="number" min={1} max={10080} value={ttl} onChange={(event) => setTtl(event.target.value)} />
          <span>How long a conversation stays on the account that served it after its last request, so its prompt cache is reused.</span>
        </label>
        <label className="space-gateway-field">Codex upstream transport
          <select value={transport} onChange={(event) => setTransport(event.target.value as GatewayStreamTransport)}>
            {transportOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <span>{transportOptions.find((option) => option.value === transport)?.description}</span>
        </label>
      </div>
      <SpaceToggle checked={withoutOverwrite} label="Import without overwrite"
        detail={withoutOverwrite ? "An imported sign-in never replaces an account with the same email; a different upstream account is added beside it."
          : "An imported sign-in replaces the account with the same email; its alias, settings and history stay."}
        onChange={setWithoutOverwrite} />
      <SaveMessage message={message} />
      <button type="submit" className="space-gateway-button primary" disabled={saving}>Save policies</button>
    </form>
  );
}

function LanSection({ settings, status, client, onSaved }: { settings: GatewaySettings; status: GatewayStatus | null; client: SpaceGatewayClient; onSaved: (settings: GatewaySettings) => void }) {
  const [mode, setMode] = useState<GatewayLanMode>(settings.lanMode);
  const [host, setHost] = useState(settings.lanHost ?? "");
  const [port, setPort] = useState(settings.lanPort ? String(settings.lanPort) : "4925");
  const [sources, setSources] = useState(settings.lanAllowedSources.join(", "));
  const { saving, message, setMessage, save } = useSettingsSaver(client, onSaved);
  const listen = status?.service.listen ?? null;
  return (
    <form className="gw-card" aria-label="LAN access" onSubmit={(event) => {
      event.preventDefault();
      const patch: GatewaySettingsUpdateRequest = mode === "ON"
        ? { lanMode: mode, lanHost: host.trim() || null, lanPort: Number(port) || null, lanAllowedSources: sources.split(",").map((item) => item.trim()).filter(Boolean) }
        : { lanMode: mode };
      void save(patch).then(async (saved) => {
        if (!saved) return;
        try {
          await client.reload();
          setMessage({ tone: "ok", text: "Saved. A new gateway worker is taking over with these settings; open streams finish on the previous one." });
        } catch (reason) {
          setMessage({ tone: "error", text: `Saved, but the gateway did not reload: ${errorText(reason, "unknown error")}` });
        }
      });
    }}>
      <header><h3>LAN access</h3><span className="space-gateway-note">Now: {listen ?? "unknown"}</span></header>
      <p className="space-gateway-note">Other internal machines reach Space Gateway on a second listener on the LAN address. Only private ranges are accepted, only the proxy routes answer there, and every request still needs a gateway key.</p>
      <Segmented legend="Source" name="lan-mode" value={mode} onChange={setMode}
        options={[{ value: "ENV", label: "Server file (.env)" }, { value: "OFF", label: "Off" }, { value: "ON", label: "On" }]} />
      {mode === "ON" ? (
        <div className="space-gateway-field-row">
          <label className="space-gateway-field">LAN address<input value={host} placeholder="192.0.2.207" onChange={(event) => setHost(event.target.value)} /></label>
          <label className="space-gateway-field">Port<input type="number" min={1024} max={65535} value={port} onChange={(event) => setPort(event.target.value)} /></label>
          <label className="space-gateway-field">Allowed ranges<input value={sources} placeholder="192.0.2.0/24" onChange={(event) => setSources(event.target.value)} />
            <span>Comma-separated private IPv4 ranges.</span></label>
        </div>
      ) : <p className="space-gateway-note">{mode === "ENV" ? "SPACE_GATEWAY_LAN_* in /opt/spaceapp/.env decide; a reload applies changes to that file." : "The LAN listener stays off; loopback clients keep working."}</p>}
      <SaveMessage message={message} />
      <button type="submit" className="space-gateway-button primary" disabled={saving}>Save and reload</button>
    </form>
  );
}

export function GatewaySettingsTab({ settings, status, client, onSaved }: {
  settings: GatewaySettings; status: GatewayStatus | null; client: SpaceGatewayClient; onSaved: (settings: GatewaySettings) => void;
}) {
  return (
    <div className="space-gateway-panel">
      <DisplaySection settings={settings} client={client} onSaved={onSaved} />
      <WarmupSection settings={settings} client={client} onSaved={onSaved} />
      <PoliciesSection settings={settings} client={client} onSaved={onSaved} />
      <LanSection settings={settings} status={status} client={client} onSaved={onSaved} />
      <AnthropicBillingSection settings={settings} client={client} onSaved={onSaved} />
      <section className="gw-card" aria-label="Sign-in">
        <header><h3>Sign-in</h3></header>
        <p className="space-gateway-note">Space sign-in replaces a separate dashboard password, session lifetime and TOTP: only Space administrators can open Space Gateway, their sessions follow Space's sign-in rules, and every change here is recorded in the audit log.</p>
      </section>
    </div>
  );
}

const knownPlans = ["plus", "prolite", "pro", "team", "business", "enterprise", "edu", "free"];

function PlanPriorityEditor({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const [adding, setAdding] = useState("");
  const move = (index: number, delta: number) => {
    const next = [...value];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    onChange(next);
  };
  const available = knownPlans.filter((plan) => !value.includes(plan));
  return (
    <div className="gw-priority" role="group" aria-label="Plan priority">
      <span className="gw-priority-title">Plan priority</span>
      <span className="space-gateway-note">Plans are used in this order: the first plan with an eligible account wins, and plans not listed come last.</span>
      {value.length === 0 ? <p className="space-gateway-empty">No order: every plan is treated alike.</p> : (
        <ol className="gw-priority-list">
          {value.map((plan, index) => (
            <li key={plan}>
              <span className="gw-priority-rank">{index + 1}</span>
              <span className="gw-priority-name">{planLabel(plan)}<small>{plan}</small></span>
              <button type="button" className="space-gateway-button" aria-label={`Move ${planLabel(plan)} up`} disabled={index === 0} onClick={() => move(index, -1)}>Up</button>
              <button type="button" className="space-gateway-button" aria-label={`Move ${planLabel(plan)} down`} disabled={index === value.length - 1} onClick={() => move(index, 1)}>Down</button>
              <button type="button" className="space-gateway-button" aria-label={`Remove ${planLabel(plan)}`} onClick={() => onChange(value.filter((item) => item !== plan))}>Remove</button>
            </li>
          ))}
        </ol>
      )}
      <div className="space-gateway-toolbar">
        <select className="gw-select" aria-label="Plan to add" value={adding} onChange={(event) => setAdding(event.target.value)}>
          <option value="">Choose a plan…</option>
          {available.map((plan) => <option key={plan} value={plan}>{planLabel(plan)}</option>)}
        </select>
        <button type="button" className="space-gateway-button" disabled={!adding} onClick={() => { onChange([...value, adding]); setAdding(""); }}>Add plan</button>
      </div>
    </div>
  );
}

export function GatewayRoutingTab({ settings, client, onSaved, onAddClaudeApiKey }: {
  settings: GatewaySettings; client: SpaceGatewayClient; onSaved: (settings: GatewaySettings) => void;
  /** Jumps to Accounts › Add account › Claude › API key. */
  onAddClaudeApiKey?: () => void;
}) {
  const [strategy, setStrategy] = useState<GatewayRoutingStrategy>(settings.routingStrategy);
  const [sticky, setSticky] = useState(settings.stickyThreadsEnabled);
  const [earlierReset, setEarlierReset] = useState(settings.preferEarlierReset);
  const [apiKeyFallback, setApiKeyFallback] = useState(settings.claudeApiKeyFallback);
  const [planPriority, setPlanPriority] = useState<string[]>(settings.planPriority);
  const [floor, setFloor] = useState(String(settings.exhaustionFloorPercent));
  const [threshold, setThreshold] = useState(String(settings.stickyReallocationBudgetThresholdPercent));
  const { saving, message, save } = useSettingsSaver(client, onSaved);
  const selected = routingStrategyOptions.find((option) => option.value === strategy);

  return (
    <form className="space-gateway-panel" onSubmit={(event) => {
      event.preventDefault();
      void save({
        routingStrategy: strategy, stickyThreadsEnabled: sticky, preferEarlierReset: earlierReset, claudeApiKeyFallback: apiKeyFallback, planPriority,
        exhaustionFloorPercent: Number(floor), stickyReallocationBudgetThresholdPercent: Number(threshold)
      });
    }}>
      <label className="space-gateway-field">Routing strategy
        <select value={strategy} onChange={(event) => setStrategy(event.target.value as GatewayRoutingStrategy)}>
          {routingStrategyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <span>{selected?.description}</span>
      </label>
      <SpaceToggle checked={sticky} label="Sticky threads" detail="Keep a conversation on the same account to reuse its prompt cache." onChange={setSticky} />
      <SpaceToggle checked={earlierReset} label="Prefer earlier reset" detail="Among eligible accounts, use the one whose quota resets soonest." onChange={setEarlierReset} />
      <SpaceToggle checked={apiKeyFallback} label="Claude API key fallback"
        detail="When every Claude account is out of quota, send Claude requests from clients other than Claude Code through the Claude API key (paid per token); Claude Code never uses it. The accounts take over again at their next reset. The key must be in Accounts as a Claude API key account."
        onChange={setApiKeyFallback} />
      {onAddClaudeApiKey ? (
        <div className="space-gateway-toolbar">
          <button type="button" className="space-gateway-button" onClick={onAddClaudeApiKey}>Add Claude API key</button>
          <span className="space-gateway-note">Opens Accounts › Add account › Claude › API key (this server's key, or one you paste).</span>
        </div>
      ) : null}
      <PlanPriorityEditor value={planPriority} onChange={setPlanPriority} />
      <div className="space-gateway-field-row">
        <label className="space-gateway-field">Exhaustion floor (%)
          <input type="number" min={0} max={50} step={0.5} value={floor} onChange={(event) => setFloor(event.target.value)} />
        </label>
        <label className="space-gateway-field">Sticky move threshold (%)
          <input type="number" min={0} max={100} step={1} value={threshold} onChange={(event) => setThreshold(event.target.value)} />
        </label>
      </div>
      <SaveMessage message={message} />
      <button type="submit" className="space-gateway-button primary" disabled={saving}>Save routing</button>
    </form>
  );
}
