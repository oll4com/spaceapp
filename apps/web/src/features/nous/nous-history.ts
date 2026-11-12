import { useCallback, useRef, useState } from "react";
import type { NousAttachment, NousMessage } from "@space/contracts";
import { api } from "../../api.js";
import { useAgentLanguage } from "../ui-language/ui-language.js";

// Operator 31/10 («Questions must never be lost»): the dock keeps the latest page it polls and every page loaded further back.

/**
 * One conversation from the polled latest page and the pages loaded further back, oldest first: the page's copy of a row wins, and rows
 * of one millisecond keep the server's order (a stable sort, an older page before the rows already here).
 */
export function mergeMessages(current: NousMessage[] | null, incoming: NousMessage[], older = false): NousMessage[] {
  // A `since` poll that found nothing new keeps the same array: the dock does not re-render its rows.
  if (current && !incoming.length) return current;
  const fresh = new Set(incoming.map((message) => message.id));
  const kept = (current ?? []).filter((message) => !fresh.has(message.id));
  return (older ? [...incoming, ...kept] : [...kept, ...incoming]).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

type Page = Awaited<ReturnType<typeof api.nousMessages>>;

export function useNousHistory() {
  const [messages, setMessages] = useState<NousMessage[] | null>(null);
  const [files, setFiles] = useState<Record<string, NousAttachment[]>>({});
  const [hasMore, setHasMore] = useState(false);
  /** The owner's last Clear conversation (the server's mark, null: never): the dock hides the decisions asked before it too. */
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const shown = useRef<NousMessage[]>([]);
  shown.current = messages ?? [];
  /** A page further back is loaded: its hasMore, not the latest page's, says whether older messages remain. */
  const paged = useRef(false);
  /** Clear conversation: a read that started before it never brings the cleared rows back. */
  const generation = useRef(0);
  /** The last latest page's server cursor, in the agents' language it was read in (another language needs every row's translation again). */
  const cursor = useRef<{ at: string; language: string } | null>(null);
  const language = useAgentLanguage();
  const add = useCallback((page: Page, older = false) => {
    setMessages((current) => mergeMessages(current, page.messages, older));
    setFiles((current) => page.attachments && Object.keys(page.attachments).length ? { ...current, ...page.attachments } : current);
  }, []);

  /** The latest page (the dock's poll). */
  const latest = useCallback(async () => {
    const at = generation.current;
    const since = cursor.current?.language === language ? cursor.current.at : undefined;
    const page = await api.nousMessages(since ? { since } : {});
    if (at === generation.current) {
      cursor.current = page.cursor ? { at: page.cursor, language } : null;
      add(page);
      setClearedAt(page.clearedAt ?? null);
      if (!paged.current) setHasMore(Boolean(page.hasMore));
    }
    return page;
  }, [add, language]);

  /** One page further back, or as many as it takes to load `target`. */
  const earlier = useCallback(async (target?: string) => {
    const at = generation.current;
    let loaded = shown.current;
    while (!target || !loaded.some((message) => message.id === target)) {
      const oldest = loaded.find((message) => message.kind !== "TOOL");
      const page = await api.nousMessages(oldest ? { before: oldest.id } : { cleared: true });
      if (at !== generation.current) return;
      loaded = mergeMessages(loaded, page.messages, true);
      add(page, true);
      paged.current = true;
      setHasMore(Boolean(page.hasMore));
      if (!target || !page.hasMore) return;
    }
  }, [add]);

  const cleared = useCallback(() => {
    generation.current += 1;
    paged.current = false;
    cursor.current = null;
    setMessages([]);
    setFiles({});
    setHasMore(false);
    // Until the next latest page brings the server's mark.
    setClearedAt(new Date().toISOString());
  }, []);

  return { messages, files, hasMore, clearedAt, latest, earlier, cleared };
}
