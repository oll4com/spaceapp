import type { PgClientLike } from "./space-store.js";

/** The copilot rails whose operator answers Nous's daily review counts (goal 7365014c-b): table and the event types that are an answer. */
export const RAIL_DECISION_SOURCES = [
  { table: "mail_copilot_events", label: "Mail Copilot", types: ["REVIEW_DECIDED", "RULE_DECIDED", "ANSWERED"] },
  { table: "marketing_copilot_events", label: "Marketing Copilot", types: ["REVIEW_DECIDED", "RULE_DECIDED", "CAMPAIGN_DECIDED", "ANSWERED"] },
  { table: "freelance_copilot_events", label: "Freelance Copilot", types: ["REVIEW_DECIDED", "RULE_DECIDED", "LEAD_DECIDED", "ANSWERED"] },
  { table: "job_apply_events", label: "Job Copilot", types: ["REVIEW_DECIDED", "ANSWERED"] }
] as const;

export interface RailDecisionCount { source: string; type: string; decision: string; count: number }

/**
 * The owner's answers in every rail since `since`: per source, event type and decision (approve, edit, reject, ...; a question's
 * answer reads "answered", or "Nous" when Nous answered it), plus needs-you cards the operator answered (source "Needs you", type the card's source).
 */
export async function countRailDecisions(client: PgClientLike, owner: string, since: string): Promise<RailDecisionCount[]> {
  const rails = RAIL_DECISION_SOURCES.map(({ table, label, types }) => `SELECT '${label}' AS source, type,
      coalesce(payload->>'decision', CASE WHEN message LIKE 'Nous %' THEN 'Nous' ELSE 'answered' END) AS decision
    FROM ${table} WHERE owner_user_id = $1 AND created_at >= $2::timestamptz AND type IN (${types.map((type) => `'${type}'`).join(", ")})`);
  const cards = `SELECT 'Needs you' AS source, source AS type, 'answered' AS decision
    FROM space_notifications WHERE owner_user_id = $1 AND payload ? 'answer' AND (payload->'answer'->>'at')::timestamptz >= $2::timestamptz`;
  const result = await client.query<{ source: string; type: string; decision: string; count: string }>(
    `SELECT source, type, decision, count(*) AS count FROM (${[...rails, cards].join("\nUNION ALL\n")}) AS answers GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [owner, since]);
  return result.rows.map((row) => ({ source: row.source, type: row.type, decision: row.decision, count: Number(row.count) }));
}
