import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  gatewayPooledRemaining, type GatewayAccount, type GatewayApiKey, type GatewayApiKeyCreatedResponse, type GatewayApiKeyDetail, type GatewayCompressionMode,
  type GatewayLimitType, type GatewayLimitWindow, type GatewayOutputPolicy, type GatewayReasoningEffort, type GatewaySettings, type GatewayTrafficClass
} from "@space/contracts";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { CopyButton } from "./gateway-add-account.js";
import { Donut, LimitBar, RemainingBar, TrendChart } from "./gateway-charts.js";
import { errorText, type SpaceGatewayClient } from "./gateway-client.js";
import { accountName, formatCost, formatCostPrecise, formatDateTime, formatTokens, outputPolicyOptions, trafficClassOptions } from "./space-gateway-model.js";

const efforts: GatewayReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const limitTypes: { value: GatewayLimitType; label: string }[] = [
  { value: "TOTAL_TOKENS", label: "Total tokens" }, { value: "INPUT_TOKENS", label: "Input tokens" }, { value: "OUTPUT_TOKENS", label: "Output tokens" },
  { value: "COST_USD", label: "Cost (USD)" }
];
const limitWindows: { value: GatewayLimitWindow; label: string }[] = [{ value: "DAILY", label: "Per day" }, { value: "WEEKLY", label: "Per week" }, { value: "MONTHLY", label: "Per month" }];

const isExpired = (key: GatewayApiKey, now: number) => Boolean(key.expiresAt && Date.parse(key.expiresAt) <= now);
const keyState = (key: GatewayApiKey, now: number) => (!key.isActive ? "Disabled" : isExpired(key, now) ? "Expired" : "Active");
const formatLimit = (type: GatewayLimitType) => (value: number) => (type === "COST_USD" ? formatCost(value / 1e6) : formatTokens(value));
const limitUsed = (limit: GatewayApiKey["limits"][number], now: number) => (Date.parse(limit.resetAt) <= now ? 0 : limit.currentValue);

interface LimitDraft { type: GatewayLimitType; window: GatewayLimitWindow; max: string; model: string }
interface KeyDraft {
  name: string; trafficClass: GatewayTrafficClass; allowedModels: string; enforcedModel: string; efforts: GatewayReasoningEffort[];
  enforcedEffort: string; accountIds: string[]; limits: LimitDraft[]; expiresAt: string; compression: "" | GatewayCompressionMode;
  outputPolicy: "" | GatewayOutputPolicy;
}

const emptyDraft: KeyDraft = { name: "", trafficClass: "INTERACTIVE", allowedModels: "", enforcedModel: "", efforts: [], enforcedEffort: "", accountIds: [],
  limits: [], expiresAt: "", compression: "", outputPolicy: "" };

/** A datetime-local value in the browser's time zone. */
function toLocalInput(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function draftOf(key: GatewayApiKey): KeyDraft {
  return {
    name: key.name, trafficClass: key.trafficClass, allowedModels: key.allowedModels.join(", "), enforcedModel: key.enforcedModel ?? "",
    efforts: [...key.allowedReasoningEfforts], enforcedEffort: key.enforcedReasoningEffort ?? "", accountIds: [...key.accountIds],
    limits: key.limits.map((limit) => ({ type: limit.limitType, window: limit.limitWindow, max: String(limit.limitType === "COST_USD" ? limit.maxValue / 1e6 : limit.maxValue),
      model: limit.modelFilter ?? "" })),
    expiresAt: toLocalInput(key.expiresAt), compression: key.compressionOverride ?? "", outputPolicy: key.outputPolicyOverride ?? ""
  };
}

/** The request body for a draft, or an error message. */
function payloadOf(draft: KeyDraft): { error: string } | { body: {
  name: string; trafficClass: GatewayTrafficClass; allowedModels: string[]; enforcedModel: string | null; allowedReasoningEfforts: GatewayReasoningEffort[];
  enforcedReasoningEffort: GatewayReasoningEffort | null; accountIds: string[]; compressionOverride: GatewayCompressionMode | null;
  outputPolicyOverride: GatewayOutputPolicy | null; expiresAt: string | null;
  limits: { limitType: GatewayLimitType; limitWindow: GatewayLimitWindow; maxValue: number; modelFilter: string | null }[];
} } {
  if (!draft.name.trim()) return { error: "Give the key a name." };
  const allowedModels = draft.allowedModels.split(",").map((model) => model.trim()).filter(Boolean);
  const enforcedModel = draft.enforcedModel.trim() || null;
  if (enforcedModel && allowedModels.length > 0 && !allowedModels.includes(enforcedModel)) return { error: "The enforced model must be one of the allowed models." };
  const enforcedEffort = (draft.enforcedEffort || null) as GatewayReasoningEffort | null;
  if (enforcedEffort && draft.efforts.length > 0 && !draft.efforts.includes(enforcedEffort)) return { error: "The enforced reasoning effort must be one of the allowed efforts." };
  const limits = [];
  for (const limit of draft.limits) {
    const value = Number(limit.max);
    const maxValue = limit.type === "COST_USD" ? Math.round(value * 1e6) : value;
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(maxValue)) {
      return { error: limit.type === "COST_USD" ? "A cost limit must be an amount above zero." : "A token limit must be a whole number above zero." };
    }
    limits.push({ limitType: limit.type, limitWindow: limit.window, maxValue, modelFilter: limit.model.trim() || null });
  }
  const expiresAt = draft.expiresAt ? new Date(draft.expiresAt).toISOString() : null;
  return { body: { name: draft.name.trim(), trafficClass: draft.trafficClass, allowedModels, enforcedModel, allowedReasoningEfforts: draft.efforts,
    enforcedReasoningEffort: enforcedEffort, accountIds: draft.accountIds, compressionOverride: draft.compression || null,
    outputPolicyOverride: draft.outputPolicy || null, expiresAt, limits } };
}

function KeyForm({ initial, accounts, submitLabel, busy, onSubmit, onCancel }: {
  initial: KeyDraft; accounts: GatewayAccount[]; submitLabel: string; busy: boolean;
  onSubmit: (draft: KeyDraft) => void; onCancel?: () => void;
}) {
  const [draft, setDraft] = useState<KeyDraft>(initial);
  const set = <K extends keyof KeyDraft>(field: K, value: KeyDraft[K]) => setDraft((current) => ({ ...current, [field]: value }));
  const setLimit = (index: number, patch: Partial<LimitDraft>) => set("limits", draft.limits.map((limit, position) => (position === index ? { ...limit, ...patch } : limit)));
  return (
    <form className="gw-key-form" aria-label={submitLabel} onSubmit={(event: FormEvent) => { event.preventDefault(); onSubmit(draft); }}>
      <div className="space-gateway-form">
        <label>Name<input value={draft.name} maxLength={120} required placeholder="Codex CLI" onChange={(event) => set("name", event.target.value)} /></label>
        <label>Traffic class
          <select value={draft.trafficClass} onChange={(event) => set("trafficClass", event.target.value as GatewayTrafficClass)}>
            {trafficClassOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>Allowed models<input value={draft.allowedModels} placeholder="All models" onChange={(event) => set("allowedModels", event.target.value)} /></label>
        <label>Enforced model<input value={draft.enforcedModel} placeholder="As requested" onChange={(event) => set("enforcedModel", event.target.value)} /></label>
        <label>Enforced reasoning effort
          <select value={draft.enforcedEffort} onChange={(event) => set("enforcedEffort", event.target.value)}>
            <option value="">As requested</option>
            {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
          </select>
        </label>
        <label>Compression
          <select value={draft.compression} onChange={(event) => set("compression", event.target.value as KeyDraft["compression"])}>
            <option value="">Use the global setting</option><option value="OFF">Off</option><option value="ON">On</option>
          </select>
        </label>
        <label>Output policy
          <select value={draft.outputPolicy} onChange={(event) => set("outputPolicy", event.target.value as KeyDraft["outputPolicy"])}>
            <option value="">Follow the provider</option>
            {outputPolicyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>Expires<input type="datetime-local" value={draft.expiresAt} onChange={(event) => set("expiresAt", event.target.value)} /></label>
      </div>
      <fieldset className="gw-checks">
        <legend>Allowed reasoning efforts <span className="space-gateway-note">(none selected: all)</span></legend>
        {efforts.map((effort) => (
          <SpaceToggle key={effort} compact label={effort} checked={draft.efforts.includes(effort)}
            onChange={(checked) => set("efforts", checked ? [...draft.efforts, effort] : draft.efforts.filter((item) => item !== effort))} />
        ))}
      </fieldset>
      <fieldset className="gw-checks">
        <legend>Accounts <span className="space-gateway-note">(none selected: every account)</span></legend>
        {accounts.length === 0 ? <span className="space-gateway-note">No accounts yet.</span> : accounts.map((account) => (
          <SpaceToggle key={account.id} compact label={accountName(account)} checked={draft.accountIds.includes(account.id)}
            onChange={(checked) => set("accountIds", checked ? [...draft.accountIds, account.id] : draft.accountIds.filter((item) => item !== account.id))} />
        ))}
      </fieldset>
      <fieldset className="gw-limits">
        <legend>Limits</legend>
        {draft.limits.map((limit, index) => (
          <div key={index} className="gw-limit-row">
            <select aria-label={`Limit ${index + 1} type`} value={limit.type} onChange={(event) => setLimit(index, { type: event.target.value as GatewayLimitType })}>
              {limitTypes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <select aria-label={`Limit ${index + 1} window`} value={limit.window} onChange={(event) => setLimit(index, { window: event.target.value as GatewayLimitWindow })}>
              {limitWindows.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <input aria-label={`Limit ${index + 1} maximum`} inputMode="decimal" value={limit.max} placeholder={limit.type === "COST_USD" ? "Dollars" : "Tokens"}
              onChange={(event) => setLimit(index, { max: event.target.value })} />
            <input aria-label={`Limit ${index + 1} model`} value={limit.model} placeholder="All models" onChange={(event) => setLimit(index, { model: event.target.value })} />
            <button type="button" className="space-gateway-button" aria-label={`Remove limit ${index + 1}`} onClick={() => set("limits", draft.limits.filter((_, position) => position !== index))}>Remove</button>
          </div>
        ))}
        <button type="button" className="space-gateway-button" onClick={() => set("limits", [...draft.limits, { type: "TOTAL_TOKENS", window: "DAILY", max: "", model: "" }])}>Add limit</button>
      </fieldset>
      <div className="space-gateway-toolbar">
        <button type="submit" className="space-gateway-button primary" disabled={busy || !draft.name.trim()}>{submitLabel}</button>
        {onCancel ? <button type="button" className="space-gateway-button" disabled={busy} onClick={onCancel}>Cancel</button> : null}
      </div>
    </form>
  );
}

function ShownOnce({ created, onDone }: { created: GatewayApiKeyCreatedResponse; onDone: () => void }) {
  return (
    <div className="space-gateway-created" role="status">
      <strong>Copy this key now. It is shown only once.</strong>
      <code>{created.plainKey}</code>
      <div className="space-gateway-toolbar">
        <CopyButton text={created.plainKey} label="Copy key" />
        <button type="button" className="space-gateway-button" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

function KeyDetail({ apiKey, accounts, client, settings, now, onChanged }: {
  apiKey: GatewayApiKey; accounts: GatewayAccount[]; client: SpaceGatewayClient; settings: GatewaySettings | null; now: number;
  onChanged: (message?: string) => void;
}) {
  const [detail, setDetail] = useState<GatewayApiKeyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "regenerate" | null>(null);
  const [regenerated, setRegenerated] = useState<GatewayApiKeyCreatedResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [measure, setMeasure] = useState<"tokens" | "cost">("tokens");
  const [accumulated, setAccumulated] = useState(false);
  const timeFormat = settings?.displayTimeFormat ?? "24H";
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  const loadDetail = useCallback(async () => {
    try { setDetail(await client.keyDetail(apiKey.id)); setError(null); }
    catch (reason) { setError(errorText(reason, "Could not load key details.")); }
  }, [client, apiKey.id]);
  useEffect(() => { void loadDetail(); }, [loadDetail]);

  async function run(action: () => Promise<void>, failure: string) {
    setBusy(true);
    try { await action(); setError(null); setConfirm(null); void loadDetail(); }
    catch (reason) { setError(errorText(reason, failure)); }
    finally { setBusy(false); }
  }

  const trendPoints = useMemo(() => {
    let total = 0;
    return (detail?.trend ?? []).map((point) => {
      const value = measure === "tokens" ? point.tokens : point.costUsd;
      total += value;
      return { t: point.t, value: accumulated ? total : value };
    });
  }, [detail, measure, accumulated]);

  if (editing) {
    return (
      <section className="gw-detail" aria-label={`Edit ${apiKey.name}`}>
        <h3>Edit {apiKey.name}</h3>
        {error ? <p className="space-gateway-alert" role="alert">{error}</p> : null}
        <KeyForm initial={draftOf(apiKey)} accounts={accounts} submitLabel="Save key" busy={busy} onCancel={() => setEditing(false)}
          onSubmit={(draft) => {
            const result = payloadOf(draft);
            if ("error" in result) { setError(result.error); return; }
            void run(async () => { await client.updateKey(apiKey.id, result.body); setEditing(false); onChanged(`${result.body.name} saved.`); }, "Could not save the key.");
          }} />
      </section>
    );
  }

  return (
    <section className="gw-detail" aria-label={`${apiKey.name} details`}>
      <header className="gw-detail-head">
        <div><h3>{apiKey.name}</h3><span className="space-gateway-note"><code>{apiKey.keyPrefix}…</code> · created {formatDateTime(apiKey.createdAt, timeFormat)}</span></div>
        <span className={`space-gateway-chip tone-${keyState(apiKey, now) === "Active" ? "ok" : "warn"}`}>{keyState(apiKey, now)}</span>
      </header>
      {regenerated ? <ShownOnce created={regenerated} onDone={() => setRegenerated(null)} /> : null}
      {error ? <p className="space-gateway-alert" role="alert">{error}</p> : null}
      <dl className="gw-facts" aria-label="Key settings">
        <dt>Traffic class</dt><dd>{trafficClassOptions.find((option) => option.value === apiKey.trafficClass)?.label}</dd>
        <dt>Models</dt><dd>{apiKey.allowedModels.length ? apiKey.allowedModels.join(", ") : "All models"}{apiKey.enforcedModel ? ` · always ${apiKey.enforcedModel}` : ""}</dd>
        <dt>Reasoning effort</dt><dd>{apiKey.allowedReasoningEfforts.length ? apiKey.allowedReasoningEfforts.join(", ") : "Any"}{apiKey.enforcedReasoningEffort ? ` · always ${apiKey.enforcedReasoningEffort}` : ""}</dd>
        <dt>Accounts</dt><dd>{apiKey.accountScopeEnabled ? apiKey.accountIds.map((id) => { const account = accountById.get(id); return account ? accountName(account) : "Removed account"; }).join(", ") : "Every account"}</dd>
        <dt>Compression</dt><dd>{apiKey.compressionOverride ? { OFF: "Off", ON: "On" }[apiKey.compressionOverride] : "Global setting"}</dd>
        <dt>Output policy</dt><dd>{apiKey.outputPolicyOverride ? outputPolicyOptions.find((option) => option.value === apiKey.outputPolicyOverride)?.label : "Follows the provider"}</dd>
        <dt>Expires</dt><dd>{apiKey.expiresAt ? formatDateTime(apiKey.expiresAt, timeFormat) : "Never"}</dd>
        <dt>Last used</dt><dd>{formatDateTime(apiKey.lastUsedAt, timeFormat)}</dd>
      </dl>
      {apiKey.limits.length > 0 ? (
        <div className="gw-detail-block"><h4>Limits</h4>
          {apiKey.limits.map((limit, index) => (
            <LimitBar key={index} label={`${limitTypes.find((type) => type.value === limit.limitType)?.label} ${limitWindows.find((window) => window.value === limit.limitWindow)?.label.toLowerCase()}${limit.modelFilter ? ` · ${limit.modelFilter}` : ""}`}
              used={limitUsed(limit, now)} max={limit.maxValue} format={formatLimit(limit.limitType)} />
          ))}
        </div>
      ) : null}
      {detail ? (
        <>
          <div className="gw-detail-block"><h4>Pooled capacity of its accounts</h4>
            <RemainingBar label="5h" remaining={detail.pooled.primaryRemainingPercent} />
            <RemainingBar label="Weekly" remaining={detail.pooled.secondaryRemainingPercent} />
          </div>
          <dl className="space-gateway-stats gw-compact-stats" aria-label="Key usage">
            <div className="space-gateway-stat"><dt>Requests (all time)</dt><dd>{formatTokens(detail.lifetime.requests)}</dd><span>{formatTokens(detail.last7d.requests)} in 7 days</span></div>
            <div className="space-gateway-stat"><dt>Tokens (all time)</dt><dd>{formatTokens(detail.lifetime.inputTokens + detail.lifetime.outputTokens)}</dd><span>{formatTokens(detail.lifetime.cachedInputTokens)} cached input</span></div>
            <div className="space-gateway-stat"><dt>Cost (all time)</dt><dd>{formatCostPrecise(detail.lifetime.costUsd)}</dd><span>{formatCostPrecise(detail.last7d.costUsd)} in 7 days</span></div>
          </dl>
          <div className="gw-detail-block">
            <h4>Cost by account (7 days)</h4>
            <Donut label="Cost by account over 7 days" formatValue={formatCostPrecise} centerValue={formatCostPrecise(detail.last7d.costUsd)} centerDetail="7 days"
              slices={detail.costByAccount.map((row) => ({ key: row.accountId, label: row.deleted ? `${row.label} (removed)` : row.label, value: row.costUsd,
                detail: `${row.requests.toLocaleString("en-US")} requests` }))} />
          </div>
          <div className="gw-detail-block">
            <div className="space-gateway-toolbar">
              <h4>Usage (7 days, hourly)</h4>
              <div className="filter-tabs" role="tablist" aria-label="Usage measure">
                {(["tokens", "cost"] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={measure === item}
                  className={`filter-tab${measure === item ? " active" : ""}`} onClick={() => setMeasure(item)}>{item === "tokens" ? "Tokens" : "Cost"}</button>)}
              </div>
              <SpaceToggle compact label="Accumulated" checked={accumulated} onChange={setAccumulated} />
            </div>
            <TrendChart label={`${apiKey.name} ${measure} per hour`} timeFormat={timeFormat}
              formatValue={(value) => (measure === "tokens" ? formatTokens(Math.round(value)) : formatCostPrecise(value))}
              series={[{ id: measure, label: measure === "tokens" ? "Tokens" : "Cost", points: trendPoints }]} />
          </div>
        </>
      ) : error ? null : <p className="space-gateway-empty">Loading usage…</p>}
      <div className="space-gateway-toolbar">
        <button type="button" className="space-gateway-button" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
        <button type="button" className="space-gateway-button" disabled={busy}
          onClick={() => void run(async () => { await client.updateKey(apiKey.id, { isActive: !apiKey.isActive }); onChanged(); }, "Could not update the API key.")}>
          {apiKey.isActive ? "Disable" : "Enable"}
        </button>
        {confirm === "regenerate"
          ? <button type="button" className="space-gateway-button danger" disabled={busy}
            onClick={() => void run(async () => { setRegenerated(await client.regenerateKey(apiKey.id)); onChanged(); }, "Could not regenerate the key.")}>Confirm regenerate</button>
          : <button type="button" className="space-gateway-button" disabled={busy} title="Issue a new secret; the current one stops working at once"
            onClick={() => setConfirm("regenerate")}>Regenerate</button>}
        {confirm === "delete"
          ? <button type="button" className="space-gateway-button danger" disabled={busy}
            onClick={() => void run(async () => { await client.deleteKey(apiKey.id); onChanged(`${apiKey.name} deleted.`); }, "Could not delete the API key.")}>Confirm delete</button>
          : <button type="button" className="space-gateway-button" disabled={busy} onClick={() => setConfirm("delete")}>Delete</button>}
      </div>
      {confirm === "regenerate" ? <p className="space-gateway-note" role="status">Clients using the current secret stop working until they get the new one.</p> : null}
    </section>
  );
}

export function GatewayKeysTab({ client, settings, onChanged }: { client: SpaceGatewayClient; settings: GatewaySettings | null; onChanged: () => void }) {
  const [keys, setKeys] = useState<GatewayApiKey[] | null>(null);
  const [accounts, setAccounts] = useState<GatewayAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<GatewayApiKeyCreatedResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("ALL");
  const [scopeFilter, setScopeFilter] = useState("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const [nextKeys, nextAccounts] = await Promise.all([client.keys(), client.accounts().catch(() => ({ data: [] as GatewayAccount[] }))]);
      setKeys(nextKeys.data);
      setAccounts(nextAccounts.data);
      setError(null);
    } catch (reason) { setError(errorText(reason, "Could not load API keys.")); }
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (keys ?? []).filter((key) => (stateFilter === "ALL" || keyState(key, now).toUpperCase() === stateFilter)
      && (scopeFilter === "ALL" || (scopeFilter === "SCOPED") === key.accountScopeEnabled)
      && (!needle || key.name.toLowerCase().includes(needle) || key.keyPrefix.toLowerCase().includes(needle)));
  }, [keys, query, stateFilter, scopeFilter, now]);
  const selected = visible.find((key) => key.id === selectedId) ?? visible[0] ?? null;

  return (
    <div className="space-gateway-panel">
      <div className="space-gateway-toolbar">
        <input className="gw-search" type="search" value={query} aria-label="Search API keys" placeholder="Search name or prefix" onChange={(event) => setQuery(event.target.value)} />
        <select className="gw-select" aria-label="Key status" value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
          <option value="ALL">All keys</option><option value="ACTIVE">Active</option><option value="DISABLED">Disabled</option><option value="EXPIRED">Expired</option>
        </select>
        <select className="gw-select" aria-label="Account assignment" value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value)}>
          <option value="ALL">Any assignment</option><option value="SCOPED">Assigned accounts</option><option value="POOL">Every account</option>
        </select>
        <button type="button" className="space-gateway-button primary" aria-expanded={creating} onClick={() => setCreating(!creating)}>{creating ? "Close" : "New key"}</button>
      </div>
      {creating ? (
        <KeyForm key={created?.key.id ?? "new"} initial={emptyDraft} accounts={accounts} submitLabel="Create key" busy={busy}
          onSubmit={(draft) => {
            const result = payloadOf(draft);
            if ("error" in result) { setError(result.error); return; }
            setBusy(true);
            client.createKey(result.body).then(async (response) => {
              setCreated(response); setCreating(false); setSelectedId(response.key.id); setError(null);
              await load(); onChanged();
            }, (reason) => setError(errorText(reason, "Could not create the API key."))).finally(() => setBusy(false));
          }} />
      ) : null}
      {created ? <ShownOnce created={created} onDone={() => setCreated(null)} /> : null}
      {error ? <p className="space-gateway-alert" role="alert">{error}</p> : null}
      {notice ? <p className="space-gateway-success" role="status">{notice}</p> : null}
      {!keys ? <p className="space-gateway-empty">Loading API keys…</p> : keys.length === 0
        ? <p className="space-gateway-empty">No API keys yet. Every client that uses Space Gateway needs its own key.</p>
        : (
          <div className="gw-split">
            <ul className="gw-list" aria-label="API keys">
              {visible.length === 0 ? <li className="space-gateway-empty">No key matches.</li> : visible.map((key) => {
                const pooled = gatewayPooledRemaining(accounts, key, now);
                const tightest = key.limits.map((limit) => ({ limit, share: limit.maxValue > 0 ? limitUsed(limit, now) / limit.maxValue : 0 }))
                  .sort((a, b) => b.share - a.share)[0];
                return (
                  <li key={key.id}>
                    <button type="button" className={`gw-list-item${selected?.id === key.id ? " is-selected" : ""}`} aria-pressed={selected?.id === key.id}
                      onClick={() => setSelectedId(key.id)}>
                      <span className="gw-list-title"><strong>{key.name}</strong>
                        <span className={`space-gateway-chip tone-${keyState(key, now) === "Active" ? "ok" : "warn"}`}>{keyState(key, now)}</span></span>
                      <span className="space-gateway-note"><code>{key.keyPrefix}…</code> · {key.accountScopeEnabled ? `${key.accountIds.length} account${key.accountIds.length === 1 ? "" : "s"}` : "Every account"}
                        {" · "}used {formatDateTime(key.lastUsedAt, settings?.displayTimeFormat ?? "24H")}</span>
                      {pooled.primaryRemainingPercent !== null ? <RemainingBar compact label="5h" remaining={pooled.primaryRemainingPercent} /> : null}
                      <RemainingBar compact label="Weekly" remaining={pooled.secondaryRemainingPercent} />
                      {tightest ? <LimitBar label="Limit" used={limitUsed(tightest.limit, now)} max={tightest.limit.maxValue} format={formatLimit(tightest.limit.limitType)} /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {selected ? <KeyDetail key={selected.id} apiKey={selected} accounts={accounts} client={client} settings={settings} now={now}
              onChanged={(message) => { setNotice(message ?? null); void load(); onChanged(); }} /> : null}
          </div>
        )}
    </div>
  );
}
