import { useCallback, useEffect, useState } from "react";
import { GATEWAY_PROGRAM_PROVIDERS, NOUS_PROGRAM_TAGS, nousProgramCategories, nousProgramGmailUrl, type GatewayPoolModels, type NousProgram, type NousProgramBenefit, type NousProgramPage, type NousProgramStatus, type NousProgramTag,
  type NousProgramTier } from "@space/contracts";
import { api } from "../../api.js";
import { formatAppDate, formatAppDateTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockChips, DockSearch, DockState } from "../dock-kit/DockKit.js";
import { PoolModels } from "../space-gateway/PoolModels.js";
import { ChevronDown, ChevronRight, ExternalLink, Handshake, Rocket, RotateCcw } from "../ui-theme/app-icons.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";

/**
 * Startup programs (operator 3/11 20:09 BKK, plan clipboard:17yLAnH5ZpyF): every program, one line each under its
 * parent (or project), with counts on top. A line opens its details and mail timeline only when clicked (operator rule 3/11: information
 * opens when he chooses; nothing opens or moves by itself).
 */
const POLL_MS = 60_000;
type Filter = "all" | "approved" | "progress" | "waiting" | "rejected" | "reapply" | "other";
const STATUS_LABELS: Record<NousProgramStatus, string> = { APPROVED: "Approved", REJECTED: "Rejected", IN_PROGRESS: "In progress", APPLIED: "Waiting for a reply",
  DRAFT: "Draft", NOT_APPLIED: "Not applied", EXPIRED: "Expired", CANCELLED: "Cancelled" };
const FILTERS: Array<[Filter, string, (program: NousProgram) => boolean]> = [
  ["all", "All", () => true], ["approved", "Approved", (p) => p.status === "APPROVED"], ["progress", "In progress", (p) => p.status === "IN_PROGRESS"],
  ["waiting", "Waiting", (p) => p.status === "APPLIED"], ["rejected", "Rejected", (p) => p.status === "REJECTED"],
  ["reapply", "To re-apply", (p) => Boolean(p.reapply?.needed)],
  ["other", "Other", (p) => ["DRAFT", "NOT_APPLIED", "EXPIRED", "CANCELLED"].includes(p.status)]
];
// Grouped tags (operator 6/11 21:42 BKK, nous_msg:f0287998) as type chips and a badge on each line; 7/11 (nous_msg:02ad746e): these five
// only, each program's categories by nousProgramCategories.
const TAG_LABELS: Record<NousProgramTag, string> = { "cash-grants": "Cash", "ai-tokens": "AI tokens", "server-access": "Servers/Cloud", "dev-tools": "Dev tools", perks: "Perks" };
export const programTags = nousProgramCategories;
const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const day = (value: string | null | undefined) => value ? formatAppDate(value) : null;
const money = (value: number, currency: string, cents = 0) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: cents }).format(value); } catch { return `${value.toLocaleString()} ${currency}`; }
};

const BENEFIT_LABELS: Record<NousProgramBenefit["status"], string> = { ACTIVE: "Active", PENDING: "Pending", USED_UP: "Used up", EXPIRED: "Expired", NOT_VERIFIED: "Not verified" };
const TIER_LABELS: Record<NousProgramTier["status"], string> = { REACHED: "Reached", PENDING: "Under review", NEXT: "Next if approved", LATER: "After that" };
type Amount = NousProgramBenefit["total"];
const sumByCurrency = (amounts: Amount[], cents = 0): string | null => {
  const sums = new Map<string, number>();
  // A number without a currency is a count (NVIDIA DLI's "20 course codes"), not dollars.
  for (const amount of amounts) if (typeof amount?.value === "number" && amount.currency) {
    const currency = amount.currency.toUpperCase();
    sums.set(currency, (sums.get(currency) ?? 0) + amount.value);
  }
  return sums.size ? [...sums].map(([currency, value]) => money(value, currency, cents)).join(" · ") : null;
};
/** The active benefits' monthly value summed per currency ("$1,200 · €40"); lines without a number are left out. */
export const monthlyTotal = (benefits: NousProgramBenefit[]) => sumByCurrency(benefits.filter((line) => line.status === "ACTIVE").map((line) => line.perMonth));
/** How much of a benefit is used, when both numbers are in the same currency. */
export function usedPercent(line: NousProgramBenefit): number | null {
  const total = line.total?.value, used = line.used?.value ?? (typeof total === "number" && typeof line.remaining?.value === "number" ? total - line.remaining.value : null);
  if (typeof total !== "number" || total <= 0 || typeof used !== "number") return null;
  return Math.round(Math.min(100, Math.max(0, (used / total) * 100)));
}

/** How much of the approved amounts is used, per currency ("3.9% ($499.60)"): the used values of approved programs' lines whose used and
 * total share the currency, against the approved amounts in it. */
export function approvedUsed(programs: NousProgram[]): string | null {
  const approved = new Map<string, number>(), used = new Map<string, number>();
  for (const program of programs.filter((entry) => entry.status === "APPROVED")) {
    if (typeof program.amount?.value === "number") {
      const currency = (program.amount.currency ?? "USD").toUpperCase();
      approved.set(currency, (approved.get(currency) ?? 0) + program.amount.value);
    }
    for (const line of program.benefits) {
      const currency = line.used?.currency?.toUpperCase();
      if (typeof line.used?.value === "number" && currency && line.total?.currency?.toUpperCase() === currency) used.set(currency, (used.get(currency) ?? 0) + line.used.value);
    }
  }
  const parts = [...used].filter(([currency]) => approved.get(currency)).map(([currency, value]) => {
    const exact = new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
    return `${(Math.round((value / approved.get(currency)!) * 1000) / 10).toLocaleString()}% (${exact})`;
  });
  return parts.length ? parts.join(" · ") : null;
}

const MONTH_MS = 30.44 * 86_400_000;
/** What an approved program is worth: its amount, else its benefit lines (a total, or a monthly value × the months it runs; a year when no end is known). */
function worth(program: NousProgram): Amount[] {
  if (typeof program.amount?.value === "number") return [program.amount];
  return program.benefits.map((line) => {
    if (typeof line.total?.value === "number" || typeof line.perMonth?.value !== "number") return line.total;
    const end = line.validUntil ?? program.validUntil, start = program.decidedAt;
    const months = end && start ? Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / MONTH_MS)) : 12;
    return { ...line.perMonth, value: line.perMonth.value * months };
  });
}
/** The approved totals per currency in two lines (operator 7/11 14:26 BKK, nous_msg:02ad746e): cash paid into our account, and credits and perks,
 * which are not cash. Every APPROVED entry counts, activation steps open or not, cents kept (they match the registry's sums); amounts without a number are left out. */
export function approvedTotals(programs: NousProgram[]): { cash: string | null; credits: string | null; creditPrograms: NousProgram[] } {
  const approved = programs.filter((program) => program.status === "APPROVED");
  const isCash = (program: NousProgram) => nousProgramCategories(program).includes("cash-grants");
  const creditPrograms = approved.filter((program) => !isCash(program));
  return { cash: sumByCurrency(approved.filter(isCash).flatMap(worth), 2), credits: sumByCurrency(creditPrograms.flatMap(worth), 2), creditPrograms };
}

/** The soonest date still ahead (a reply due, a re-apply date, an expiry), or a reply already overdue. */
export function nextDate(program: NousProgram, now = Date.now()): { label: string; at: string; overdue?: boolean } | null {
  const today = new Date(now).setHours(0, 0, 0, 0);
  const ahead = ([["Reply by", program.status === "APPLIED" || program.status === "IN_PROGRESS" ? program.expectedReplyBy : null],
    ["Re-apply", program.reapply?.needed ? program.reapply.when : null], ["Valid until", program.validUntil]] as Array<[string, string | null | undefined]>)
    .filter((entry): entry is [string, string] => Boolean(entry[1]) && Date.parse(entry[1]!) >= today).sort((a, b) => a[1].localeCompare(b[1]))[0];
  if (ahead) return { label: ahead[0], at: ahead[1] };
  return program.status === "APPLIED" && program.expectedReplyBy ? { label: "Reply overdue since", at: program.expectedReplyBy, overdue: true } : null;
}

export function NousPrograms({ page, active }: { page: NousProgramPage; active: boolean }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [programs, setPrograms] = useState<NousProgram[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [tag, setTag] = useState<NousProgramTag | null>(null);
  const [query, setQuery] = useState("");
  const [groupBy, setGroupBy] = useState<"parent" | "project">("parent");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [pools, setPools] = useState<GatewayPoolModels | null>(null);
  const load = useCallback(async () => {
    // The gateway pools' supported models for the AI-token rows (cached by the API; ADMIN only, so anyone else sees none).
    if (page === "startup") void api.gatewayPoolModels().then(setPools).catch(() => undefined);
    try { setPrograms((await api.nousPrograms(page)).programs); setError(null); } catch (failure) { setError(messageOf(failure, "The programs could not be loaded.")); }
  }, [page]);
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = (programs ?? []).filter((program) => words.every((word) => [program.parent, program.program, program.project, program.account,
    program.statusReason, program.notes, program.nextAction, program.whatItIs, program.howWeUse, ...program.contacts].some((field) => field?.toLowerCase().includes(word))));
  // A type chip (6/11) and a status chip combine; the status counts follow the type, the type counts the status (operator 7/11, nous_msg:e7255379).
  const tagged = (list: NousProgram[]) => tag ? list.filter((program) => programTags(program).includes(tag)) : list;
  const inScope = tagged(matching);
  const inStatus = matching.filter(FILTERS.find(([id]) => id === filter)![2]);
  const shown = tagged(inStatus);
  const groups = new Map<string, NousProgram[]>();
  for (const program of shown) {
    const key = (groupBy === "parent" ? program.parent : program.project) ?? t("No project");
    groups.set(key, [...groups.get(key) ?? [], program]);
  }
  const totals = programs ? approvedTotals(tagged(programs)) : null;
  // Used stays on the credits line: cash is not spent through a provider.
  const used = totals ? approvedUsed(totals.creditPrograms) : null;
  const toggle = (id: string) => setOpen((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const Icon = page === "startup" ? Rocket : Handshake;

  return (
    <div className="nous-decisions nous-programs" data-sensitive-masked="manual">
      {error ? <div><p role="alert">{t(error)}</p><DockButton onClick={() => void load()}>{t("Retry")}</DockButton></div> : null}
      {programs === null && !error ? <DockState kind="loading" title={t("Loading the programs")} /> : null}
      {programs?.length === 0 ? <DockState kind="empty" icon={Icon} title={t("No programs yet")}
        detail={t("Nous fills this list from the programs registry (space_programs) and the data panes' files.")} /> : null}
      {programs?.length ? <>
        <DockChips label={t("Show programs")} value={filter} onChange={setFilter}
          options={FILTERS.map(([id, label, test]) => ({ id, label: t(label), count: inScope.filter(test).length, ...(id === "reapply" ? { tone: "attention" as const } : {}) }))} />
        <div className="dock-kit-chips nous-programs-tags" role="group" aria-label={t("Program types")}>
          {NOUS_PROGRAM_TAGS.map((id) => {
            const count = inStatus.filter((program) => programTags(program).includes(id)).length;
            return (
              <button key={id} type="button" className="dock-kit-chip" aria-pressed={tag === id} disabled={count === 0 && tag !== id} onClick={() => setTag((on) => on === id ? null : id)}
                {...(id === "cash-grants" ? { title: t("Only money paid into our account: grants, prizes, bounties paid, investment") } : {})}>
                {t(TAG_LABELS[id])}<span className="dock-kit-chip-count">{count}</span>
              </button>
            );
          })}
        </div>
        {totals?.cash || totals?.credits ? <div className="nous-programs-total">
          <span>{t("Approved in total")}</span>
          <p>{t("Cash")}: <strong>{totals.cash ?? money(0, "USD")}</strong></p>
          <p>{t("Credits & perks (not cash)")}: <strong>{totals.credits ?? money(0, "USD")}</strong>{used ? <> · {t("Used")} <strong>{used}</strong></> : null}</p>
        </div> : null}
        <div className="nous-programs-tools">
          <DockSearch value={query} onChange={setQuery} label={t("Search programs")} />
          <DockChips label={t("Group programs")} value={groupBy} onChange={setGroupBy} options={[{ id: "parent", label: t("By parent") }, { id: "project", label: t("By project") }]} />
        </div>
        {shown.length === 0 ? <p className="nous-programs-none">{t("No program matches.")}</p> : null}
        {[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, rows]) => (
          <section key={name} className="nous-programs-group" aria-label={name}>
            <h3>{name} <span>{rows.length}</span></h3>
            <ul>
              {rows.map((program) => <ProgramRow key={program.id} program={program} other={groupBy === "parent" ? program.project : program.parent}
                pool={pools?.data.find((entry) => entry.provider === GATEWAY_PROGRAM_PROVIDERS[program.id])}
                expanded={open.has(program.id)} onToggle={() => toggle(program.id)} t={t} />)}
            </ul>
          </section>
        ))}
      </> : null}
    </div>
  );
}

function ProgramRow({ program, other, pool, expanded, onToggle, t }: { program: NousProgram; other: string | null;
  pool: GatewayPoolModels["data"][number] | undefined; expanded: boolean; onToggle(): void;
  t(text: string, vars?: Record<string, string | number>): string }) {
  const next = nextDate(program);
  // Operator 7/11 16:19 BKK (nous_msg:8cb6b284): every approved entry shows what the whole grant is worth, the same worth() as the totals.
  const value = program.status === "APPROVED" ? sumByCurrency(worth(program)) : null;
  const bodyId = `nous-program-${program.id}`;
  const fact = (label: string, value: string | null | undefined) => value ? <><dt>{t(label)}</dt><dd>{value}</dd></> : null;
  return (
    <li className={`nous-program is-${program.status.toLowerCase()}${expanded ? " is-open" : ""}`}>
      <button type="button" className="nous-program-head" aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
        <span className="nous-program-chevron" aria-hidden="true">{expanded ? <ChevronDown /> : <ChevronRight />}</span>
        <span className="nous-program-name">{program.program}{other ? <small>{other}</small> : null}</span>
        {programTags(program).map((id) => <span key={id} className={`nous-program-tag is-${id}`}>{TAG_LABELS[id as NousProgramTag] ? t(TAG_LABELS[id as NousProgramTag]) : id}</span>)}
        <span className={`nous-program-status is-${program.status.toLowerCase()}`}>{t(STATUS_LABELS[program.status])}</span>
        {program.amount ? <span className="nous-program-amount">{program.amount.text}</span> : null}
        {value ? <span className="nous-program-worth" title={t("Indicative value of the whole grant")}>≈ {value}</span> : null}
        {next ? <span className={`nous-program-next${next.overdue ? " is-overdue" : ""}`}>{t(next.label)} {day(next.at)}</span> : null}
        {pool ? <span className="nous-program-benefit-count nous-program-gateway" title={pool.error ?? undefined}>
          {pool.models ? t("Space Gateway · {count} models", { count: pool.models.length }) : t("Space Gateway")}</span> : null}
        {program.benefits.length ? <span className="nous-program-benefit-count">{t(program.benefits.length === 1 ? "1 benefit" : "{count} benefits", { count: program.benefits.length })}</span> : null}
        {program.reapply?.needed ? <span className="nous-program-reapply" title={program.reapply.why ?? t("To re-apply")}><RotateCcw aria-hidden="true" />{t("Re-apply")}</span> : null}
      </button>
      {expanded ? (
        <div id={bodyId} className="nous-program-body">
          {/* R73 (operator 4/11 15:09 BKK): what it is and how we use it, first. */}
          {program.whatItIs || program.howWeUse ? <dl className="nous-goal-facts nous-program-use">{fact("What it is", program.whatItIs)}{fact("How we use it", program.howWeUse)}</dl> : null}
          <PoolModels entry={pool} />
          {program.tiers.length || program.nextAction ? <Tiers tiers={program.tiers} nextAction={program.nextAction} t={t} /> : null}
          {program.benefits.length ? <Benefits benefits={program.benefits} t={t} /> : null}
          <dl className="nous-goal-facts">
            {fact("Parent organization", program.parent)}{fact("Project", program.project)}{fact("Why", program.statusReason)}
            {fact("Applied", day(program.appliedAt))}{fact("Reply expected by", day(program.expectedReplyBy))}{fact("Decided", day(program.decidedAt))}
            {fact("Valid until", day(program.validUntil))}{fact("Amount", program.amount?.text)}{fact("Commitments", program.commitments)}
            {fact("Account", program.account)}{fact("Contacts", program.contacts.join(", "))}{fact("Next action", program.nextAction)}
            {program.reapply?.needed ? fact("Re-apply", [program.reapply.why, program.reapply.when ? t("from {date}", { date: day(program.reapply.when)! }) : null].filter(Boolean).join(" · ") || t("Yes")) : null}
            {fact("Notes", program.notes)}{fact("Sources", program.sources.join(", "))}{fact("Updated", formatAppDateTime(program.updatedAt))}
          </dl>
          {/^https?:\/\//i.test(program.url ?? "") ? <a className="nous-program-link" href={program.url!} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" />{t("Program page")}</a> : null}
          <h4>{t("Mails")} <span>{program.mails.length}</span></h4>
          {program.mails.length ? (
            <ol className="nous-program-mails">
              {program.mails.map((mail, index) => {
                const gmail = nousProgramGmailUrl(mail);
                return (
                  <li key={`${mail.date}-${index}`} className={`is-${mail.direction.toLowerCase()}`}>
                    <span className="nous-program-mail-when">{formatAppDateTime(mail.date)} · {t(mail.direction === "SENT" ? "Sent" : "Received")}{mail.gmailAccount ? ` · ${mail.gmailAccount}` : ""}</span>
                    <span className="nous-program-mail-subject">{mail.subject || t("(no subject)")}</span>
                    <span className="nous-program-mail-who">{mail.from} → {mail.to.join(", ")}</span>
                    {gmail ? <a href={gmail} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" />{t("Open in Gmail")}</a> : null}
                  </li>
                );
              })}
            </ol>
          ) : <p className="nous-goal-history-empty">{t("No mail recorded.")}</p>}
        </div>
      ) : null}
    </li>
  );
}

function Benefits({ benefits, t }: { benefits: NousProgramBenefit[]; t(text: string, vars?: Record<string, string | number>): string }) {
  const monthly = monthlyTotal(benefits);
  // One card per line: the dock is narrow, so its facts wrap under their labels instead of a table's cut-off columns.
  const fact = (label: string, value: string | null | undefined) => value ? <span><b>{t(label)}</b> {value}</span> : null;
  return (
    <section className="nous-program-benefits" aria-label={t("What we got")}>
      <h4>{t("What we got")} <span>{benefits.length}</span>{monthly ? <em>{t("{amount} a month", { amount: monthly })}</em> : null}</h4>
      <ul>
        {benefits.map((line, index) => {
          const percent = usedPercent(line);
          const used = [line.used ? t("used {amount}", { amount: line.used.text }) : null, line.remaining ? t("left {amount}", { amount: line.remaining.text }) : null,
            line.usageAt ? t("as of {date}", { date: day(line.usageAt)! }) : null].filter(Boolean).join(" · ");
          return (
            <li key={`${line.what}-${index}`} className={`is-${line.status.toLowerCase()}`}>
              <div className="nous-program-benefit-head">
                <strong>{line.what}</strong>
                <span className={`nous-program-benefit-status is-${line.status.toLowerCase()}`}>{t(BENEFIT_LABELS[line.status])}</span>
              </div>
              <div className="nous-program-benefit-facts">
                {fact("Account", line.account)}{fact("Per month", line.perMonth?.text)}{fact("Total", line.total?.text)}{fact("Usage", used)}
                {fact("Valid until", day(line.validUntil))}
              </div>
              {percent !== null ? <div className="nous-program-benefit-meter">
                <meter min={0} max={100} value={percent} aria-hidden="true" /><span>{t("{percent}% used", { percent })}</span>
              </div> : null}
              {line.allocations.length ? <small className="nous-program-allocations">{line.allocations.map((share, at) => (
                <span key={`${share.project}-${at}`} title={share.purpose ?? undefined}>{share.project}{share.percent !== null ? ` ${share.percent}%` : ""}</span>
              ))}</small> : null}
              {line.notes ? <small className="nous-program-benefit-notes" title={line.notes}>{line.notes}</small> : null}
              {line.source ? <small className="nous-program-source" title={line.source}>{t("Source")}: {line.source}</small> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Tiers({ tiers, nextAction, t }: { tiers: NousProgramTier[]; nextAction: string | null; t(text: string, vars?: Record<string, string | number>): string }) {
  const next = tiers.find((tier) => tier.status === "PENDING") ?? tiers.find((tier) => tier.status === "NEXT");
  return (
    <section className="nous-program-tiers" aria-label={t("Tiers and next step")}>
      <h4>{t("Tiers and next step")}</h4>
      {nextAction ? <p><strong>{t("Next step")}:</strong> {nextAction}</p> : null}
      {next ? <p className="nous-program-if-approved"><strong>{t("If approved")}:</strong> {next.name}{next.gives ? ` — ${next.gives}` : ""}{next.amount ? ` (${next.amount.text})` : ""}</p> : null}
      {tiers.length ? (
        <ol>
          {tiers.map((tier, index) => (
            <li key={`${tier.name}-${index}`} className={`is-${tier.status.toLowerCase()}`}>
              <span className={`nous-program-tier-status is-${tier.status.toLowerCase()}`}>{t(TIER_LABELS[tier.status])}</span>
              <strong>{tier.name}</strong>
              {tier.gives ? <span>{t("Gives")}: {tier.gives}{tier.amount ? ` (${tier.amount.text})` : ""}</span> : tier.amount ? <span>{tier.amount.text}</span> : null}
              {tier.requires ? <span>{t("Requires")}: {tier.requires}</span> : null}
              {tier.source ? <small className="nous-program-source">{tier.source}</small> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
