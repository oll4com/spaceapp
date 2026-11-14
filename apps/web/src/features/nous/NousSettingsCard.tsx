import { useEffect, useState } from "react";
import {
  NOUS_LOW_SPEND_KINDS, quotaResetCreditsText, NOUS_PROVIDER_NAMES, nousProvider, nousCheaperModel, nousModelLabel, nousSettingsWithProvider, NOUS_TURN_KINDS, nousLowSpendSettingsSchema, nousModelsSettingsSchema, nousPaneBoardSettingsSchema, nousGoalsSettingsSchema, nousStandingOrdersSettingsSchema,
  type NousProvider, type NousProviderOption, type NousProviderModel, type NousAway, type NousAwayGrant, type NousLowSpendSettings, type NousModelChoice, type NousModelsSettings, type NousPaneBoardSettings, type NousSettings, type NousGoalsSettings, type NousStandingOrdersSettings, type NousTurnKind
} from "@space/contracts";
import { api } from "../../api.js";
import { cliResetWhen } from "../cli-accounts/cli-account-availability.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockNotice } from "../dock-kit/DockKit.js";
import { readNousFocusEnabled, writeNousFocusEnabled } from "../nous-focus/nous-focus-events.js";
import { SettingsLabel } from "../settings/SettingsLabel.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { useUiText } from "../ui-language/ui-language.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";

/** Nous's switches, only in Settings → Assistants & AI → Nous (the dock keeps just the On/Off one); the last one is kept on this device. */
export function NousSettingsToggles({ settings, onChange, className }: {
  settings: NousSettings | null; onChange(patch: Partial<NousSettings>): void; className?: string;
}) {
  const [focusEnabled, setFocusEnabled] = useState(readNousFocusEnabled);
  return (
    <>
      <SpaceToggle className={className} label="Work on my behalf" ariaLabel="Nous works on my behalf"
        help="Nous answers panes and copilots in every room, moves the plans on and holds your notifications. Releases, irreversible actions and anything to third parties still come to you."
        checked={Boolean(settings?.enabled)} disabled={!settings} onChange={(enabled) => onChange({ enabled })} />
      <SpaceToggle className={className} label="May promote dev to stable" ariaLabel="Nous may promote dev to stable"
        help="Nous batches finished work and promotes dev to stable without asking you. Hotfixes, npm releases and queue control stay yours."
        checked={Boolean(settings?.mayPromote)} disabled={!settings} onChange={(mayPromote) => onChange({ mayPromote })} />
      <SpaceToggle className={className} label="May approve Warm changes" ariaLabel="Nous may approve Warm changes"
        help="Nous approves changes to the protected Warm code after reading them; the tests and the real-browser performance check stay required."
        checked={Boolean(settings?.mayApproveWarm)} disabled={!settings} onChange={(mayApproveWarm) => onChange({ mayApproveWarm })} />
      <SpaceToggle className={className} label="May approve security hotfixes" ariaLabel="Nous may approve security hotfixes"
        help="The Security Copilot's hotfix for a finding goes to stable without asking you. Other hotfixes, promotes and releases stay yours."
        checked={Boolean(settings?.maySecurityHotfix)} disabled={!settings} onChange={(maySecurityHotfix) => onChange({ maySecurityHotfix })} />
      <SpaceToggle className={className} label="Ask me before changes on my own hosts" ariaLabel="Ask me before changes on my own hosts"
        help="On: the Security and Monitoring Copilots ask you before changing your own hosts. Off: they run upgrades, restarts, config, firewall, container, guest-start and cache changes with a backup and a rollback; reboots, deletes and changes that end your sessions always ask."
        checked={Boolean(settings?.askOwnHostChanges)} disabled={!settings} onChange={(askOwnHostChanges) => onChange({ askOwnHostChanges })} />
      <SpaceToggle className={className} label="Spend Codex reset credits by itself" ariaLabel="Spend Codex reset credits by itself"
        help="When a Codex account has used up its week, its own reset is more than 6 hours away and Codex work is waiting, Space spends one of its weekly reset credits. Never two on one week."
        checked={settings?.autoResetCredits !== false} disabled={!settings} onChange={(autoResetCredits) => onChange({ autoResetCredits })} />
      <SpaceToggle className={className} label="May send to third parties" ariaLabel="Nous may send to third parties"
        help="A send to a third party goes out as soon as Nous asks, without asking you, as long as the files it sends are the ones it named."
        checked={Boolean(settings?.maySend)} disabled={!settings} onChange={(maySend) => onChange({ maySend })} />
      <SpaceToggle className={className} label="May delete what Nous created" ariaLabel="Nous may delete what it created"
        help="Agent Files Nous added itself (a copy kept in its own folder first) and test VMs, containers and snapshots an agent recorded creating go when Nous asks to delete them. Your files, VMs and every other record stay yours."
        checked={Boolean(settings?.mayDeleteOwn)} disabled={!settings} onChange={(mayDeleteOwn) => onChange({ mayDeleteOwn })} />
      <SpaceToggle className={className} label="May publish after a green lab proof" ariaLabel="Nous may publish after a green lab proof"
        help="A release candidate is approved without asking you when its captain recorded a green lab proof for exactly that commit. Hotfixes and promotes stay yours."
        checked={Boolean(settings?.mayPublish)} disabled={!settings} onChange={(mayPublish) => onChange({ mayPublish })} />
      <SpaceToggle className={className} label="May run guarded host restarts" ariaLabel="Nous may run guarded host restarts"
        help="A guarded Browser Host or pane host restart runs without asking you once both merge queues are idle, no browser holds a handoff, a lease or a Vault fence and, for the pane host, no CLI pane is in a turn."
        checked={Boolean(settings?.mayRestartHosts)} disabled={!settings} onChange={(mayRestartHosts) => onChange({ mayRestartHosts })} />
      <SpaceToggle className={className} label="Never refuse my requests" ariaLabel="Nous never refuses my requests"
        help="Nous carries out every task you ask without refusing, narrowing or questioning it. Security is the exception (secrets, the Vault, sign-ins, your hosts, Space's own gates), and releases, deletes and third parties still come to you as decisions."
        checked={Boolean(settings?.neverRefuse)} disabled={!settings} onChange={(neverRefuse) => onChange({ neverRefuse })} />
      <SpaceToggle className={className} label="Shell" ariaLabel="Nous may use a shell"
        help="Nous runs commands itself as your CLI user, like a pane, never with sudo. Off: it asks a pane to run them."
        checked={Boolean(settings?.shell)} disabled={!settings} onChange={(shell) => onChange({ shell })} />
      <SpaceToggle className={className} label="Copilot questions go to Nous first" ariaLabel="Copilot questions go to Nous first"
        help="A copilot's question waits up to an hour for Nous, which answers what it can find itself; the rest comes to you on the pane's card, at once when Nous is off or paused."
        checked={settings?.copilotQuestionsNousFirst ?? true} disabled={!settings} onChange={(copilotQuestionsNousFirst) => onChange({ copilotQuestionsNousFirst })} />
      <SpaceToggle className={className} label="Talk to Nous from Telegram" ariaLabel="Nous takes messages from the paired Telegram chat"
        help="Write to Nous from your paired Telegram chat and get its answer there; its decisions arrive with Approve and Decline buttons. Only the paired chat, with the same rules as the dock."
        checked={Boolean(settings?.telegramInbound)} disabled={!settings} onChange={(telegramInbound) => onChange({ telegramInbound })} />
      <SpaceToggle className={className} label="Offer to take me to panes that need me" ariaLabel="Nous offers to take me to panes that need me"
        help="When a pane needs you, its card shows bottom right and Go to pane maximizes that pane and focuses what needs you; Back returns you. Off: a toast instead; saved on this device."
        checked={focusEnabled} onChange={(enabled) => { writeNousFocusEnabled(enabled); setFocusEnabled(enabled); }} />
    </>
  );
}

const AWAY_GRANTS: Array<{ grant: NousAwayGrant; label: string; help: string }> = [
  { grant: "PROMOTE", label: "While away: may promote dev to stable", help: "Only right after live:verify:dev passes. Hotfixes, npm and GitHub releases stay yours." },
  { grant: "TEST_PANES", label: "While away: may restart or close my test panes", help: "Only the panes you opened for your own tests." }
];

/**
 * Away mode (plan clipboard:B7eTUHTJYg3X): while you are away Nous keeps working, writes to its away log instead of the chat,
 * holds its alerts for one summary and briefs you on return. Publishing, payments, deletes, sends to third parties, Warm code and
 * host restarts always wait for you; the grant only widens here.
 */
function NousAwayToggles({ away, onChange, className }: { away: NousAway | null | undefined; onChange(input: { away: boolean; grant?: NousAwayGrant[] }): void; className?: string }) {
  const t = useUiText();
  const on = Boolean(away);
  const grant = away?.grant ?? [];
  return (
    <>
      <SpaceToggle className={className} label={away ? `Away since ${formatUserTime(away.startedAt)}` : "Away"} ariaLabel="Nous Away mode"
        help="Nous keeps working while you are away: no chat replies, alerts held for one summary, a briefing when you write again. Your next message ends it."
        checked={on} disabled={away === undefined} onChange={(next) => onChange({ away: next })} />
      {on ? AWAY_GRANTS.map((item) => (
        <SpaceToggle key={item.grant} className={className} label={t(item.label)} ariaLabel={`Nous Away grant ${item.grant}`} help={item.help}
          checked={grant.includes(item.grant)}
          onChange={(next) => onChange({ away: true, grant: next ? [...grant, item.grant] : grant.filter((entry) => entry !== item.grant) })} />
      )) : null}
    </>
  );
}

const PANE_BOARD_MODELS: Array<{ id: NousPaneBoardSettings["model"]; label: string }> = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" }, { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }
];

/** A whole number saved when the field is left (or Enter), clamped to its range. */
function PaneBoardNumber({ label, help, value, min, max, onSave }: { label: string; help: string; value: number; min: number; max: number; onSave(value: number): void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Math.round(Number(draft));
    const next = Number.isFinite(parsed) && draft.trim() ? Math.min(max, Math.max(min, parsed)) : value;
    setDraft(String(next));
    if (next !== value) onSave(next);
  };
  return (
    <label className="settings-flat-row">
      <SettingsLabel label={label} help={help} />
      <input type="number" inputMode="numeric" min={min} max={max} step={1} value={draft} aria-label={label}
        onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); }} />
    </label>
  );
}

/**
 * Pane board (plan clipboard:Y9cgKVHFaHrr): the cheap Claude model that writes each pane's line, how often Nous refreshes them,
 * its batch and daily limits, the lines' language and which panes the board lists. The labels stay English.
 */
function NousPaneBoardSettingsRows({ settings, onChange, className }: { settings: NousSettings | null; onChange(patch: Partial<NousSettings>): void; className: string }) {
  const board = settings?.paneBoard ?? nousPaneBoardSettingsSchema.parse({});
  const save = (patch: Partial<NousPaneBoardSettings>) => onChange({ paneBoard: { ...board, ...patch } });
  const disabled = !settings;
  return (
    <>
      <div className="settings-flat-subheading"><SettingsLabel label="Pane board" help="Nous's Panes view: one line per pane by room. Nous refreshes a pane's line only when something changed in it." /></div>
      <SpaceToggle className={className} label="Pane board summaries" ariaLabel="Nous pane board summaries"
        help="A cheap Claude model writes each changed pane's line. Off: the board shows Space's own line from the newest report."
        checked={board.enabled} disabled={disabled} onChange={(enabled) => save({ enabled })} />
      <label className="settings-flat-row">
        <SettingsLabel label="Summary model" help="The Claude model that writes the pane lines: one headless Claude Code run per refresh, with no tools." />
        <select aria-label="Pane board summary model" value={board.model} disabled={disabled} onChange={(event) => save({ model: event.target.value as NousPaneBoardSettings["model"] })}>
          {PANE_BOARD_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </label>
      <PaneBoardNumber label="Refresh interval (minutes)" help="How often Nous looks for changed panes; at most one new line per pane in that time." value={board.intervalMinutes} min={2} max={60}
        onSave={(intervalMinutes) => save({ intervalMinutes })} />
      <PaneBoardNumber label="Panes per summary call" help="Changed panes beyond this wait for the next refresh." value={board.maxPanesPerCall} min={1} max={20}
        onSave={(maxPanesPerCall) => save({ maxPanesPerCall })} />
      <PaneBoardNumber label="Summary calls per day" help="After this many calls the board shows Space's own lines until tomorrow (UTC)." value={board.dailyCap} min={10} max={2_000}
        onSave={(dailyCap) => save({ dailyCap })} />
      <label className="settings-flat-row">
        <SettingsLabel label="Summary language" help="The language of the pane lines; the board's labels stay English." />
        <select aria-label="Pane board summary language" value={board.language} disabled={disabled} onChange={(event) => save({ language: event.target.value as NousPaneBoardSettings["language"] })}>
          <option value="el">Greek</option>
          <option value="en">English</option>
        </select>
      </label>
      <SpaceToggle className={className} label="Show finished panes" ariaLabel="Pane board shows finished panes" help="Panes whose turn has ended stay on the board."
        checked={board.showFinished} disabled={disabled} onChange={(showFinished) => save({ showFinished })} />
      <SpaceToggle className={className} label="Show closed panes" ariaLabel="Pane board shows closed panes" help="Closed panes of your rooms appear too, without a reply box."
        checked={board.showClosed} disabled={disabled} onChange={(showClosed) => save({ showClosed })} />
    </>
  );
}

/**
 * Standing orders (operator orders 2026-10-21): Space itself brings Nous the finished panes (to save to memory and close) and the
 * stalled plans every tick, in a turn of their own, until each one is handled.
 */
function NousStandingOrdersRows({ settings, onChange, className }: { settings: NousSettings | null; onChange(patch: Partial<NousSettings>): void; className: string }) {
  const orders = settings?.standingOrders ?? nousStandingOrdersSettingsSchema.parse({});
  const save = (patch: Partial<NousStandingOrdersSettings>) => onChange({ standingOrders: { ...orders, ...patch } });
  return (
    <>
      <div className="settings-flat-subheading"><SettingsLabel label="Standing orders" help="Space repeats them in code, 24/7: finished panes are asked to save to memory and then closed by Nous; stalled plans get one action each." /></div>
      <SpaceToggle className={className} label="Close finished panes after their memory save" ariaLabel="Nous closes finished panes after their memory save"
        help="Nous asks each finished CLI pane to save to memory, Space verifies the save, Nous closes the pane. A pane bound to a scheduled task stays open."
        checked={orders.closeFinishedPanes} disabled={!settings} onChange={(closeFinishedPanes) => save({ closeFinishedPanes })} />
      <SpaceToggle className={className} label="Close your own panes too" ariaLabel="Nous closes your own panes after their memory save"
        help="Panes you work in yourself (your test panes) are saved to memory and closed like any finished pane once their task is done. Off: Nous never closes them."
        checked={orders.closeOperatorPanes} disabled={!settings} onChange={(closeOperatorPanes) => save({ closeOperatorPanes })} />
      <PaneBoardNumber label="Finished after (minutes)" help="A pane that reports done or failed, or ends its turn idle at its prompt, counts as finished at once; one idle this long with no such report counts too. Nothing may wait on it." value={orders.finishedAfterMinutes} min={5} max={720}
        onSave={(finishedAfterMinutes) => save({ finishedAfterMinutes })} />
      <PaneBoardNumber label="Stalled after (hours)" help="A plan that has not moved this long (or has no pane) is stalled; Nous nudges it once per window." value={orders.stalledAfterHours} min={1} max={72}
        onSave={(stalledAfterHours) => save({ stalledAfterHours })} />
      <PaneBoardNumber label="Check every (minutes)" help="How often Space looks for finished panes and stalled plans." value={orders.tickMinutes} min={2} max={60}
        onSave={(tickMinutes) => save({ tickMinutes })} />
      <SpaceToggle className={className} label="Daily self-review" ariaLabel="Nous reviews its own day"
        help="Once a day Space brings Nous its own turns, failures and corrections of the last 24 hours in a turn of its own; Nous turns the repeated causes into lessons and saves the review to Space Memory."
        checked={orders.dailyReview} disabled={!settings} onChange={(dailyReview) => save({ dailyReview })} />
      <PaneBoardNumber label="Self-review at (hour)" help="The hour of the day, in your time zone, the daily self-review starts (0-23)." value={orders.dailyReviewHour} min={0} max={23}
        onSave={(dailyReviewHour) => save({ dailyReviewHour })} />
    </>
  );
}

const TURN_KIND_LABELS: Record<NousTurnKind, { label: string; help: string }> = {
  operator: { label: "Answering you", help: "Turns your messages start." },
  decision: { label: "Acting on your answers", help: "Turns your decision answers start." },
  inbox: { label: "Reading news from the rooms", help: "Inbox turns: pane events, reports and notifications." },
  standing: { label: "Standing orders", help: "Finished panes and stalled plans every tick, the Away round and the daily self-review." },
  helper: { label: "Helpers", help: "The helper turns of space_subagents." },
  goal: { label: "Working on your goals", help: "The goal loop's turns: Auto runs the balanced model (an explicit model is kept), never downgraded further in low-spend mode." }
};

/**
 * Goals (operator request 2026-10-27, plan clipboard:DR51jZJEB0j1): the goal loop that works the operator's goals in turns of its own.
 */
function NousGoalsRows({ settings, onChange, className }: { settings: NousSettings | null; onChange(patch: Partial<NousSettings>): void; className: string }) {
  const goals = settings?.goals ?? nousGoalsSettingsSchema.parse({});
  const save = (patch: Partial<NousGoalsSettings>) => onChange({ goals: { ...goals, ...patch } });
  return (
    <>
      <div className="settings-flat-subheading"><SettingsLabel label="Goals" help="Your standing objectives (/goal in the Nous dock). While one is active, Nous works it in goal turns of its own and backs off only while nothing moves or the goal waits on you, a third party or a date." /></div>
      <SpaceToggle className={className} label="Goal loop" ariaLabel="Nous goal loop"
        help="A goal turn shortly after the previous one while a goal is active. Off: goals stay listed and Nous still serves them in its other turns."
        checked={goals.loop} disabled={!settings} onChange={(loop) => save({ loop })} />
      <PaneBoardNumber label="Gap between goal turns (seconds)" help="How long after a goal turn ends the next one may start." value={goals.gapSeconds} min={10} max={3_600}
        onSave={(gapSeconds) => save({ gapSeconds })} />
      <PaneBoardNumber label="Back off (minutes)" help="The first pause when a goal did not move or waits on someone; it doubles while nothing changes." value={goals.backoffMinutes} min={1} max={180}
        onSave={(backoffMinutes) => save({ backoffMinutes, backoffMaxMinutes: Math.max(backoffMinutes, goals.backoffMaxMinutes) })} />
      <PaneBoardNumber label="Back off at most (minutes)" help="The longest pause between goal turns of a goal that does not move, and the pause of a goal whose wait stayed the same." value={goals.backoffMaxMinutes} min={goals.backoffMinutes} max={720}
        onSave={(backoffMaxMinutes) => save({ backoffMaxMinutes: Math.max(goals.backoffMinutes, backoffMaxMinutes) })} />
      <PaneBoardNumber label="Unchanged turns before backing off" help="Goal turns in a row that leave a goal unchanged before it backs off." value={goals.unchangedTurns} min={1} max={20}
        onSave={(unchangedTurns) => save({ unchangedTurns })} />
    </>
  );
}

function pickCatalogModel(models: NousProviderModel[], preferred: NousModelChoice, critical = false): NousModelChoice {
  const options = critical ? models.filter((model) => model.efforts.some((effort) => ["none", "low", "medium"].includes(effort))) : models;
  const model = options.find((model) => model.id === preferred.model) ?? options[0];
  if (!model) return preferred;
  const efforts = critical ? model.efforts.filter((effort) => ["none", "low", "medium"].includes(effort)) : model.efforts;
  return { model: model.id, effort: (efforts.includes(preferred.effort) ? preferred.effort : efforts[0] ?? "none") as NousModelChoice["effort"] };
}

function NousModelFields({ choice, models, label, disabled, critical = false, loading = false, onChange }: {
  choice: NousModelChoice; models: NousProviderModel[]; label: string; disabled: boolean; critical?: boolean; loading?: boolean; onChange(choice: NousModelChoice): void;
}) {
  const choices = critical ? models.filter((model) => model.efforts.some((effort) => ["none", "low", "medium"].includes(effort))) : models;
  const selected = choices.find((model) => model.id === choice.model);
  const efforts = (selected?.efforts ?? [choice.effort]).filter((effort) => !critical || ["none", "low", "medium"].includes(effort));
  return <>
    <select aria-label={label} value={choice.model} disabled={disabled || !choices.length}
      onChange={(event) => onChange(pickCatalogModel(choices, { ...choice, model: event.target.value }, critical))}>
      {!selected && <option value={choice.model}>{nousModelLabel(choice.model)}{loading ? "" : " (unavailable)"}</option>}
      {choices.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
    </select>
    <select aria-label={label.replace("model for", "effort for")} value={choice.effort} disabled={disabled || !selected || (selected.efforts.length === 1 && selected.efforts[0] === "none")}
      onChange={(event) => onChange({ ...choice, effort: event.target.value as NousModelChoice["effort"] })}>
      {!efforts.includes(choice.effort) && <option value={choice.effort}>{choice.effort}{loading ? "" : " (unavailable)"}</option>}
      {efforts.map((effort) => <option key={effort} value={effort}>{effort === "auto" ? "Auto" : effort}</option>)}
    </select>
  </>;
}

function NousModelsRows({ settings, providers, loading, pending, onChange, className }: {
  settings: NousSettings | null; providers: NousProviderOption[]; loading: boolean; pending: boolean; onChange(patch: Partial<NousSettings>): void; className: string;
}) {
  // Subscription pools lead with the pickers' figure, "54% free at Tue 10:00" (operator 31/10 16:59 BKK); API keys keep their balance.
  const providerRoomText = (item: NousProviderOption) => item.atReset === undefined ? (item.room ? ` · ${item.room}` : "")
    : ` · ${item.atReset ? `${item.atReset.percent}% free ${cliResetWhen(item.atReset.resetAt, Date.now())}${item.atReset.resetCredits ? ` · ${quotaResetCreditsText(item.atReset.resetCredits)}` : ""}` : "Unknown free at reset (no current weekly window)"}`;
  const models = settings?.models ?? nousModelsSettingsSchema.parse({});
  const provider = nousProvider(settings ?? {});
  const selected = providers.find((item) => item.id === provider);
  const catalog = selected?.models ?? [];
  const changeProvider = (id: string, effort: NousModelChoice["effort"] = "high") => {
    const next = providers.find((item) => item.id === id);
    if (!settings || !next?.available || !next.models.length) return;
    const provider = id as NousProvider;
    const preferred: Record<NousProvider, string> = { space: "auto", codex: "gpt-6-astra", claude: "claude-opus-5-5", gemini: "gemini-3.8-flash-high" };
    const normal = pickCatalogModel(next.models, { model: preferred[provider] ?? "auto", effort });
    const low = pickCatalogModel(next.models, nousCheaperModel(provider));
    const critical = pickCatalogModel(next.models, nousCheaperModel(provider, true), true);
    onChange({ provider, models: Object.fromEntries(NOUS_TURN_KINDS.map((kind) => [kind, normal])) as NousModelsSettings, fallbackModel: "none",
      lowSpend: { ...settings.lowSpend,
        models: Object.fromEntries(NOUS_LOW_SPEND_KINDS.map((kind) => [kind, low])) as NousLowSpendSettings["models"],
        criticalModels: Object.fromEntries(NOUS_LOW_SPEND_KINDS.map((kind) => [kind, critical])) as NousLowSpendSettings["criticalModels"] } });
  };
  return <>
    <div className="settings-flat-subheading"><SettingsLabel label="Provider and models" help="Choose a connected provider, then the model and effort for each kind of turn. Your saved choices are used for every new turn." /></div>
    <div className={className}>
      <SettingsLabel label="Provider" help="The Space Gateway provider Nous's turns run on. Changing it selects compatible models for normal and low-spend turns.">{loading ? "Checking the providers connected to Space Gateway…" : selected?.reason}</SettingsLabel>
      <select aria-label="Nous provider" value={provider} disabled={!settings || pending || !providers.length} onChange={(event) => changeProvider(event.target.value)}>
        {/* Until the catalog answers (seconds when cold), the saved provider is named, not called unavailable (stable 29/10 showed "codex (unavailable)"). */}
        {!selected && <option value={provider}>{NOUS_PROVIDER_NAMES[provider] ?? provider}{loading ? " (checking…)" : " (unavailable)"}</option>}
        {/* A disabled option cannot be selected to read its reason, so the reason is part of its text. */}
        {providers.map((item) => <option key={item.id} value={item.id} disabled={!item.available} title={item.room}>{item.name}{item.available ? providerRoomText(item) : ` (unavailable: ${item.reason ?? "not connected"})`}</option>)}
      </select>
    </div>
    {/* Operator 8/11: one click for Auto model and Auto reasoning on every turn kind; the per-kind choices below stay. */}
    <div className={className}>
      <SettingsLabel label="All automatic" help="Space provider, Auto model and Auto reasoning for every kind of turn; low-spend turns use the Auto balanced and light models. You can still change any of them below." />
      <DockButton aria-label="Set Nous to Auto model and Auto reasoning" disabled={!settings || pending || !providers.find((item) => item.id === "space")?.available}
        onClick={() => changeProvider("space", "auto")}>Auto</DockButton>
    </div>
    {provider === "space" && selected?.routes && <div className={className}>
      <SettingsLabel label="Space routes" help="Auto models try these in order (Space Gateway → Settings → Routing) and each turn names the route that served it. A model with a route in its name runs only there." />
      <ol className="nous-space-routes" aria-label="Space provider routes">
        {selected.routes.map((route) => <li key={route.route} data-route={route.route}>
          <strong>{route.name}</strong> <small>{route.runtime}{!route.enabled ? " · off in the order" : route.available ? " · ready" : ` · ${route.reason ?? "unavailable"}`}{route.resetAt ? ` · back ${cliResetWhen(route.resetAt, Date.now())}` : ""}</small>
        </li>)}
      </ol>
    </div>}
    {NOUS_TURN_KINDS.map((kind) => <div key={kind} className={className}>
      <SettingsLabel label={TURN_KIND_LABELS[kind].label} help={TURN_KIND_LABELS[kind].help} />
      <NousModelFields choice={models[kind]} models={catalog} label={`Nous model for ${kind} turns`} disabled={!settings || pending || !selected?.available} loading={loading}
        onChange={(choice) => onChange({ models: { ...models, [kind]: choice } })} />
    </div>)}
    {provider === "claude" && <div className={className}>
      <SettingsLabel label="Fallback model" help="Claude Code uses this model when the selected model is unavailable. Off pauses Nous instead." />
      <select aria-label="Nous fallback model" value={settings?.fallbackModel ?? "none"} disabled={!settings || pending} onChange={(event) => onChange({ fallbackModel: event.target.value })}>
        <option value="none">Off</option>
        {catalog.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
      </select>
    </div>}
  </>;
}

const LOAD_TARGET_INTRO = "How much of the server's capacity and token pools Nous fills with parallel work, for each token state. 0 never pushes for more work.";
const LOAD_TARGET_DETAIL = {
  NORMAL: "While Nous's token pools have room.",
  LOW: "While Nous's own pool runs ahead of its pace.",
  CRITICAL: "While no account of Nous's pool has room."
} as const;

function NousLowSpendRows({ settings, providers, loading, pending, onChange }: { settings: NousSettings | null; providers: NousProviderOption[]; loading: boolean; pending: boolean; onChange(patch: Partial<NousSettings>): void }) {
  const low = settings?.lowSpend ?? nousLowSpendSettingsSchema.parse({});
  const catalog = providers.find((item) => item.id === nousProvider(settings ?? {}))?.models ?? [];
  const save = (patch: Partial<NousLowSpendSettings>) => { if (settings) onChange({ lowSpend: { ...low, ...patch } }); };
  const model = (kind: typeof NOUS_LOW_SPEND_KINDS[number], patch: Partial<NousModelChoice>) => save({ models: { ...low.models, [kind]: { ...low.models[kind], ...patch } } });
  const criticalModel = (kind: typeof NOUS_LOW_SPEND_KINDS[number], patch: Partial<NousLowSpendSettings["criticalModels"]["inbox"]>) =>
    save({ criticalModels: { ...low.criticalModels, [kind]: { ...low.criticalModels[kind], ...patch } } });
  const language = useUiLanguage();
  return (
    <>
      <div className="settings-flat-subheading"><SettingsLabel label="Low-spend mode" help="Keeps quota available on your selected provider for the work that needs it. While conserving, the inbox batches more slowly, helpers are limited to one (none in CRITICAL) and stalled-plan nudges wait." /></div>
      <div className="settings-flat-row">
        <SettingsLabel label="Low-spend mode" help="Auto watches cached quotas and returns to normal after resets. Always on keeps spending low; Off keeps your normal turn settings." />
        <select aria-label="Nous low-spend mode" disabled={!settings} value={low.mode} onChange={(event) => save({ mode: event.target.value as NousLowSpendSettings["mode"] })}>
          <option value="AUTO">Auto</option><option value="ON">Always on</option><option value="OFF">Off</option>
        </select>
      </div>
      <SpaceToggle className="settings-flat-row" label="Cheaper model in low-spend mode" ariaLabel="Cheaper model in low-spend mode"
        help="Automatic turns use the models below on the same provider; your messages and decisions keep their model, with effort at most high. Normal models return after recovery."
        checked={low.cheaperModel} disabled={!settings} onChange={(cheaperModel) => save({ cheaperModel })} />
      <PaneBoardNumber label="Accounts needed for normal spending" help="Auto conserves when fewer accounts of the selected provider have quota available." value={low.minMaxAccountsWithRoom} min={1} max={100} onSave={(minMaxAccountsWithRoom) => save({ minMaxAccountsWithRoom })} />
      <PaneBoardNumber label="Quota left to count as room (%)" help="An account needs at least this percentage left in its reported quota windows. No account with room means CRITICAL. Providers without quota windows stay in normal mode on Auto." value={low.roomRemainingPercent} min={1} max={100} onSave={(roomRemainingPercent) => save({ roomRemainingPercent })} />
      <PaneBoardNumber label="Inbox turns per hour while conserving" help="An upper limit in LOW and CRITICAL only (your accounts' quota); normal mode has none." value={low.maxTurnsPerHour} min={1} max={120} onSave={(maxTurnsPerHour) => save({ maxTurnsPerHour })} />
      {NOUS_LOW_SPEND_KINDS.map((kind) => (
        <div className="settings-flat-row" key={kind}>
          <SettingsLabel label={`${TURN_KIND_LABELS[kind].label} in LOW`} help="The model for these turns while Nous conserves quota on this provider." />
          <NousModelFields choice={low.models[kind]} models={catalog} label={`Nous low-spend model for ${kind} turns`} disabled={!settings || pending || !low.cheaperModel} loading={loading}
            onChange={(choice) => model(kind, choice)} />
        </div>
      ))}
      {NOUS_LOW_SPEND_KINDS.map((kind) => (
        <div className="settings-flat-row" key={`critical-${kind}`}>
          <SettingsLabel label={`${TURN_KIND_LABELS[kind].label} in CRITICAL`} help={kind === "helper" ? "Helpers remain disabled in CRITICAL." : "The model for these turns when quota is nearly exhausted."} />
          <NousModelFields choice={low.criticalModels[kind]} models={catalog} label={`Nous critical model for ${kind} turns`} disabled={!settings || pending || !low.cheaperModel} critical loading={loading}
            onChange={(choice) => criticalModel(kind, { model: choice.model, effort: choice.effort as "none" | "low" | "medium" })} />
        </div>
      ))}
      <div className="settings-flat-subheading"><SettingsLabel label="Load target" help={LOAD_TARGET_INTRO} /></div>
      {(["NORMAL", "LOW", "CRITICAL"] as const).map((mode) => (
        <PaneBoardNumber key={`load-${mode}`} label={uiText(language, "Load target in {mode} (%)", { mode })} help={LOAD_TARGET_DETAIL[mode]}
          value={low.loadTargets[mode]} min={0} max={100} onSave={(percent) => save({ loadTargets: { ...low.loadTargets, [mode]: percent } })} />
      ))}
    </>
  );
}

/** Settings → Assistants & AI → Nous: every Nous switch, saved to the signed-in operator's Nous settings. */
export function NousSettingsCard({ sharedMemoryAdmin = false }: { sharedMemoryAdmin?: boolean }) {
  const [settings, setSettings] = useState<NousSettings | null>(null);
  const [providers, setProviders] = useState<NousProviderOption[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [away, setAway] = useState<NousAway | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // Goal 7365014c-c: how often each Always-approve kind ran by itself in 14 days (a read only; the list stays the settings' own).
  const [spared, setSpared] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void api.nousAlwaysApprove().then(({ rules }) => { if (!cancelled) setSpared(new Map(rules.map((rule) => [rule.key, rule.count]))); }).catch(() => undefined);
    void api.nousProviders().then(({ providers }) => { if (!cancelled) setProviders(providers ?? []); })
      .catch(() => { if (!cancelled) setError("Providers could not be loaded. Reopen settings to try again."); })
      .finally(() => { if (!cancelled) setProvidersLoaded(true); });
    api.nous().then(({ state }) => { if (!cancelled) { setSettings(nousSettingsWithProvider(state.settings)); setAway(state.away ?? null); } })
      .catch((caught: unknown) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "Nous settings could not be loaded."); });
    return () => { cancelled = true; };
  }, []);

  const save = (patch: Partial<NousSettings>) => {
    setError(null);
    setPending(true);
    void api.updateNousSettings(patch).then((result) => setSettings(nousSettingsWithProvider(result.settings)))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "The setting could not be saved."))
      .finally(() => setPending(false));
  };

  // The kept list is the one saved now: a rule approved in the dock after this card loaded stays (Record Retention Invariant).
  const askAgain = (key: string) => {
    setError(null);
    void api.nous().then(({ state }) => save({ alwaysApprove: (state.settings.alwaysApprove ?? []).filter((kept) => kept.key !== key) }))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "The setting could not be saved."));
  };

  const saveAway = (input: { away: boolean; grant?: NousAwayGrant[] }) => {
    setError(null);
    void api.setNousAway(input).then((result) => setAway(result.away))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Away mode could not be changed."));
  };

  return (
    <section className="agent-settings-card settings-flat-card" aria-label="Nous settings" aria-busy={!settings && !error}>
      <NousModelsRows providers={providers} loading={!providersLoaded} pending={pending} settings={settings} onChange={save} className="settings-flat-row" />
      <NousLowSpendRows providers={providers} loading={!providersLoaded} pending={pending} settings={settings} onChange={save} />
      <NousSettingsToggles settings={settings} onChange={save} className="settings-flat-row settings-flat-toggle-row" />
      <div role="group" aria-label="Dock tabs">
        <div className="settings-flat-subheading"><SettingsLabel label="Dock tabs" help="Choose which tabs appear in Nous on every device. Conversation always stays on." /></div>
        {([["needs", "Needs you"], ["done", "Done"], ["updates", "Updates"], ["requests", "Requests"], ["shared", "Shared"], ["decisions", "Decisions"], ["overview", "Overview"],
          ["panes", "Panes"], ["plans", "Plans"], ["goals", "Goals"], ["startup", "Startup programs"], ["affiliate", "Affiliate"], ["jobs", "Job applications"], ["crypto", "Crypto"], ["marketing", "Marketing"], ["quotas", "Quotas"], ["load", "Load"], ["score", "Score"],
          ["taskRuns", "Task runs"]] as const).map(([id, label]) => (
          <SpaceToggle key={id} className="settings-flat-row settings-flat-toggle-row" label={label} ariaLabel={`Show ${label} tab`} help="Shows this tab in the Nous dock on every device."
            checked={settings?.dockTabs?.[id] !== false} disabled={!settings || pending}
            onChange={(enabled) => save({ dockTabs: { ...settings?.dockTabs, [id]: enabled } })} />
        ))}
      </div>
      <NousAwayToggles away={away} onChange={saveAway} className="settings-flat-row settings-flat-toggle-row" />
      <NousPaneBoardSettingsRows settings={settings} onChange={save} className="settings-flat-row settings-flat-toggle-row" />
      <NousStandingOrdersRows settings={settings} onChange={save} className="settings-flat-row settings-flat-toggle-row" />
      <NousGoalsRows settings={settings} onChange={save} className="settings-flat-row settings-flat-toggle-row" />
      {/* The kinds approved with "Always approve" in the Nous dock (operator request 2026-10-18); removing one makes Nous ask again. */}
      {settings?.alwaysApprove?.map((rule) => (
        <div key={rule.key} className="settings-flat-row">
          <SettingsLabel label="Always approved" help="A kind of decision you approved with Always approve in the Nous dock; it runs without asking you. Ask me again makes Nous ask you again.">
            {rule.label} · since {formatUserTime(rule.at)}{spared.has(rule.key) ? ` · ran ${spared.get(rule.key)} time${spared.get(rule.key) === 1 ? "" : "s"} for you in 14 days` : ""}
          </SettingsLabel>
          <DockButton aria-label={`Ask me again: ${rule.label}`}
            onClick={() => askAgain(rule.key)}>Ask me again</DockButton>
        </div>
      ))}
      {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
      {sharedMemoryAdmin ? <><NousServerOperations /><NousSharedMemory /></> : null}
    </section>
  );
}
import { NousServerOperations } from "./NousServerOperations.js";
import { NousSharedMemory } from "./NousSharedMemory.js";
