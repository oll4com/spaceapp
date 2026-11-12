import type { PgClientLike } from "./space-store.js";

/** The copilot rails whose operator answers Nous's daily review counts (goal 7365014c-b): table and the event types that are an answer. */
export const RAIL_DECISION_SOURCES = [
  { table: "mail_copilot_events", label: "Mail Copilot", types: ["REVIEW_DECIDED", "RULE_DECIDED", "ANSWERED"] },
  { table: "marketing_copilot_events", label: "Marketing Copilot", types: ["REVIEW_DECIDED", "RULE_DECIDED", "CAMPAIGN_DECIDED", "ANSWERED"] },
  { table: "freelance_copilot_events", label: "Freelance Copilot", types: ["REVIEW_DECIDED", "RULE_DECIDED", "LEAD_DECIDED", "ANSWERED"] },
  { table: "job_apply_events", label: "Job Copilot", types: ["REVIEW_DECIDED", "ANSWERED"] },
  { table: "security_copilot_events", label: "Security Copilot", types: ["REVIEWED", "ANSWERED"] }
] as const;

/** Who ran a rail decision when not the rail itself (event payload `by`): "nous" its decision or answer, "card" the operator's needs-you card (already its own NEEDS_YOU ledger row). */
export type RailAnswerBy = "nous" | "card";

export interface RailDecisionCount { source: string; type: string; decision: string; count: number }

/**
 * The owner's answers in every rail since `since`: per source, event type and decision (approve, edit, reject, ...; a question's
 * answer reads "answered", or "Nous" when Nous answered it or its decision ran it), plus needs-you cards the operator answered (source "Needs you", type the card's source).
 */
export async function countRailDecisions(client: PgClientLike, owner: string, since: string): Promise<RailDecisionCount[]> {
  const rails = RAIL_DECISION_SOURCES.map(({ table, label, types }) => `SELECT '${label}' AS source, type,
      CASE WHEN payload->>'by' = 'nous' THEN 'Nous' ELSE coalesce(payload->>'decision', CASE WHEN message LIKE 'Nous %' THEN 'Nous' ELSE 'answered' END) END AS decision
    FROM ${table} WHERE owner_user_id = $1 AND created_at >= $2::timestamptz AND type IN (${types.map((type) => `'${type}'`).join(", ")})`);
  const cards = `SELECT 'Needs you' AS source, source AS type, 'answered' AS decision
    FROM space_notifications WHERE owner_user_id = $1 AND payload ? 'answer' AND (payload->'answer'->>'at')::timestamptz >= $2::timestamptz`;
  const result = await client.query<{ source: string; type: string; decision: string; count: string }>(
    `SELECT source, type, decision, count(*) AS count FROM (${[...rails, cards].join("\nUNION ALL\n")}) AS answers GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [owner, since]);
  return result.rows.map((row) => ({ source: row.source, type: row.type, decision: row.decision, count: Number(row.count) }));
}

/**
 * R11-3: one operator answer in a copilot rail (Nous's own answers, since R24-3 a copilot's own SUPERSEDED close, and since 12/11 a decision Nous's
 * decision ran, payload `by: "nous"`, and since USQ6 step 4 a needs-you card's, `by: "card"`, which the ledger holds as its NEEDS_YOU row, left out), for the decision ledger.
 */
export interface RailDecision { source: string; id: string; type: string; decision: string; title: string; at: string }

/** The owner's own answers in every rail since `since`, oldest first (at most 500): the ledger appends the ones it does not hold yet. */
export async function listRailDecisions(client: PgClientLike, owner: string, since: string): Promise<RailDecision[]> {
  const rails = RAIL_DECISION_SOURCES.map(({ table, label, types }) => `SELECT '${label}' AS source, id::text AS id, type, coalesce(payload->>'decision', 'answered') AS decision,
      left(coalesce(message, ''), 300) AS title, created_at AS at
    FROM ${table} WHERE owner_user_id = $1 AND created_at >= $2::timestamptz AND type IN (${types.map((type) => `'${type}'`).join(", ")}) AND coalesce(message, '') NOT LIKE 'Nous %'
      AND coalesce(payload->>'decision', '') <> 'superseded' AND coalesce(payload->>'by', '') NOT IN ('nous', 'card')`);
  const result = await client.query<{ source: string; id: string; type: string; decision: string; title: string; at: Date | string }>(
    `SELECT * FROM (${rails.join("\nUNION ALL\n")}) AS answers ORDER BY at ASC, source, id LIMIT 500`, [owner, since]);
  return result.rows.map((row) => ({ ...row, at: row.at instanceof Date ? row.at.toISOString() : new Date(row.at).toISOString() }));
}
