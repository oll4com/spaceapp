import { queryOptions } from "@tanstack/react-query";
import type { NousScoreRange } from "@space/contracts";
import { api } from "../../api.js";

/**
 * Operator 5/11 10:36 BKK (lowest usage, best results): the API recomputes every 15 minutes and 2 minutes after the operator writes, and both
 * reads answer from memory, so the tab reads the score every 5 minutes, only while shown and focused (NousScore). The history follows the
 * score: it is read again only on a range change or when a newer score arrives (NousScore invalidates it), never on its own timer.
 */
export const NOUS_SCORE_POLL_MS = 5 * 60_000;
export const scoreQuery = () => queryOptions({ queryKey: ["nous", "score"], queryFn: () => api.nousScore(), staleTime: NOUS_SCORE_POLL_MS });
export const scoreHistoryQuery = (range: NousScoreRange) => queryOptions({ queryKey: ["nous", "score", "history", range],
  queryFn: () => api.nousScoreHistory(range), staleTime: Infinity });
