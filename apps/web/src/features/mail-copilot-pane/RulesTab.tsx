import { useCallback, useEffect, useState } from "react";
import type { MailRule, MailRuleDecision } from "@space/contracts";
import { api } from "../../api.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import { Check, ShieldCheck, X } from "../ui-theme/app-icons.js";
import { mailTime } from "./MailClient.js";
import { subscribeMailCopilotLiveEvents } from "./live-events.js";

const STATUS_LABEL: Record<MailRule["status"], string> = { PROPOSED: "Proposed", APPROVED: "Approved", REJECTED: "Rejected", RETIRED: "Retired" };
const ACTION_LABEL: Record<MailRule["action"]["type"], string> = { REPLY: "reply", ARCHIVE: "archive", LABEL: "label", MOVE: "move", FIX: "send to the copilot to fix", STAR: "star", TRASH: "trash", MARK_READ: "mark read" };

type Translate = (text: string, vars?: Record<string, string | number>) => string;

/** "From acme.com, subject matches /invoice/" — the condition in words. */
export function ruleConditionText(condition: MailRule["condition"], t: Translate): string {
  const parts: string[] = [];
  if (condition.fromAddress) parts.push(t("from {value}", { value: condition.fromAddress }));
  if (condition.fromContains) parts.push(t("from contains \"{value}\"", { value: condition.fromContains }));
  if (condition.domain) parts.push(t("from {value}", { value: condition.domain }));
  if (condition.subjectPattern) parts.push(t("subject matches /{value}/", { value: condition.subjectPattern }));
  if (condition.labelAny?.length) parts.push(t("labeled {labels}", { labels: condition.labelAny.join(` ${t("or")} `) }));
  if (condition.hasAttachment !== undefined) parts.push(condition.hasAttachment ? t("with an attachment") : t("without attachments"));
  return parts.join(", ");
}
export function ruleActionText(action: MailRule["action"], t: Translate): string {
  if (action.type === "MOVE" && action.labels?.length) return t("move to {labels}", { labels: action.labels.join(", ") });
  return action.type === "LABEL" && action.labels?.length ? t("label {labels}", { labels: action.labels.join(", ") }) : t(ACTION_LABEL[action.type]);
}

function RuleRow({ rule, onChange }: { rule: MailRule; onChange(rule: MailRule): void }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decide(decision: MailRuleDecision["decision"]) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onChange((await api.decideMailRule(rule.id, { decision })).rule);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("The decision failed."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className={`jc-rule status-${rule.status.toLowerCase()}`}>
      <div className="jc-memory-head">
        <span className={`jc-tag status-${rule.status.toLowerCase()}`}>{t(STATUS_LABEL[rule.status])}</span>
        <strong className="jc-rule-name">{rule.name}</strong>
        {rule.accountEmail ? <span className="jc-muted">{rule.accountEmail}</span> : <span className="jc-muted">{t("all accounts")}</span>}
      </div>
      <p className="jc-memory-text">{t("When mail is {condition}:", { condition: ruleConditionText(rule.condition, t) })} <strong>{ruleActionText(rule.action, t)}</strong> {t("on its own.")}</p>
      {rule.evidence.length ? <ul className="jc-rule-evidence">{rule.evidence.map((line, index) => <li key={index} className="jc-muted">{line}</li>)}</ul> : null}
      <div className="jc-memory-meta jc-muted">
        <span>{rule.proposedBy === "AGENT" ? t("proposed by the copilot") : rule.proposedBy === "LEARNED" ? t("learned from your actions") : t("written by you")}</span>
        <span>{t("{percent}% sure", { percent: Math.round(rule.confidence * 100) })}</span>
        <span>{rule.appliedCount === 1 ? t("applied once") : t("applied {count} times", { count: rule.appliedCount })}</span>
        <span title={rule.updatedAt}>{mailTime(rule.updatedAt)}</span>
      </div>
      <div className="jc-actions">
        {rule.status === "PROPOSED" ? (
          <>
            <button type="button" className="jc-button primary" disabled={busy} onClick={() => void decide("approve")}><Check aria-hidden="true" /> {t("Approve")}</button>
            <button type="button" className="jc-button ghost danger" disabled={busy} onClick={() => void decide("reject")}><X aria-hidden="true" /> {t("Reject")}</button>
          </>
        ) : rule.status === "APPROVED" ? (
          <button type="button" className="jc-button ghost" disabled={busy} onClick={() => void decide("retire")}>{t("Retire")}</button>
        ) : (
          <button type="button" className="jc-button ghost" disabled={busy} onClick={() => void decide("approve")}>{t("Approve again")}</button>
        )}
      </div>
      {error ? <p className="jc-message" role="alert">{error}</p> : null}
    </li>
  );
}

/** The Rules rail tab: what the copilot may do alone under Rules autonomy; proposals first, then approved and past rules. */
export function RulesTab({ paneId }: { paneId: string }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [rules, setRules] = useState<MailRule[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try { setRules((await api.mailRules()).rules); } catch { setRules([]); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => subscribeMailCopilotLiveEvents(paneId, (detail) => {
    const type = detail.payload.type as string | undefined;
    if (type === "RULE_PROPOSED" || type === "RULE_DECIDED" || type === "RULE_APPLIED" || type === "RULE_LEARNED" || type === "RULE_RETIRED") void load();
  }), [load, paneId]);
  const order: Record<MailRule["status"], number> = { PROPOSED: 0, APPROVED: 1, RETIRED: 2, REJECTED: 3 };
  const sorted = [...rules].sort((left, right) => order[left.status] - order[right.status] || right.updatedAt.localeCompare(left.updatedAt));
  return (
    <div className="jc-memory-tab" role="tabpanel" id="jc-panel-rules" aria-labelledby="jc-tab-rules">
      <p className="jc-muted jc-rules-hint"><ShieldCheck aria-hidden="true" /> {t("Under Rules autonomy the copilot acts alone only where an approved rule matches. When you handle a sender's mail the same way three times or more on an account, the rule is learned and approved on its own; retire it whenever you like.")}</p>
      {loading ? <p className="jc-muted jc-panel-loading" role="status">{t("Loading rules…")}</p> : null}
      {!loading && rules.length === 0 ? <div className="jc-empty"><strong>{t("No rules yet")}</strong><span>{t("Proposals from the copilot land here for you to approve or reject.")}</span></div> : null}
      <ul className="jc-memory-list" aria-label={t("Rules")}>
        {sorted.map((rule) => <RuleRow key={rule.id} rule={rule} onChange={(updated) => setRules((current) => current.map((entry) => entry.id === updated.id ? updated : entry))} />)}
      </ul>
    </div>
  );
}
