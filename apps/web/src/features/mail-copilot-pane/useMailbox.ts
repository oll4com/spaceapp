import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MailAccountSummary, MailLabel, MailThread, MailThreadSummary, MailThreadsPage } from "@space/contracts";
import { api } from "../../api.js";
import { subscribeMailCopilotLiveEvents } from "./live-events.js";

export interface MailboxSelection { account: "all" | string; labelId: string; query: string }

export interface MailboxState {
  accounts: MailAccountSummary[];
  labels: MailLabel[];
  threads: MailThreadSummary[];
  nextPageToken: string | null;
  errors: MailThreadsPage["errors"];
  thread: MailThread | null;
  selectedThreadId: string | null;
  loading: boolean;
  loadingMore: boolean;
  loadingThread: boolean;
  error: string | null;
  selection: MailboxSelection;
  setSelection(update: Partial<MailboxSelection>): void;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  openThread(thread: Pick<MailThreadSummary, "account" | "threadId"> | null, images?: boolean): Promise<MailThread | null>;
  /** Opens one conversation and narrows the list to it, as a search for its Message-ID. */
  showOnlyThread(thread: Pick<MailThreadSummary, "account" | "threadId">): Promise<void>;
  /** Replaces one thread row after an action (read, star, …) without a reload. */
  patchThread(threadId: string, update: Partial<MailThreadSummary>): void;
  removeThread(threadId: string): void;
}

const LIVE_REFRESH_DEBOUNCE_MS = 600;
const VIEW_DEBOUNCE_MS = 500;

/** Accounts, labels, the thread list (paged) and the open thread of a Mail Copilot pane, refreshed on live events. */
export function useMailbox(paneId: string, enabled: boolean, initial: Partial<MailboxSelection> = {}): MailboxState {
  const [selection, setSelectionState] = useState<MailboxSelection>({ account: initial.account ?? "all", labelId: initial.labelId ?? "INBOX", query: initial.query ?? "" });
  const [accounts, setAccounts] = useState<MailAccountSummary[]>([]);
  const [labels, setLabels] = useState<MailLabel[]>([]);
  const [threads, setThreads] = useState<MailThreadSummary[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [errors, setErrors] = useState<MailThreadsPage["errors"]>([]);
  const [thread, setThread] = useState<MailThread | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const current = ++generation.current;
    const { account, labelId, query } = selectionRef.current;
    setLoading(true);
    try {
      const [accountsResponse, labelsResponse, page] = await Promise.all([
        api.mailAccounts(paneId),
        api.mailLabels(paneId, account),
        api.mailThreads(paneId, { account, labelId, q: query || undefined })
      ]);
      if (current !== generation.current) return;
      setAccounts(accountsResponse.accounts);
      setLabels(labelsResponse.labels);
      setThreads(page.threads);
      setNextPageToken(page.nextPageToken);
      setErrors(page.errors);
      setError(null);
    } catch (caught) {
      if (current !== generation.current) return;
      setError(caught instanceof Error ? caught.message : "The mailbox could not be loaded.");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [enabled, paneId]);

  const loadMore = useCallback(async () => {
    const token = nextPageToken;
    if (!token || loadingMore) return;
    const { account, labelId, query } = selectionRef.current;
    setLoadingMore(true);
    try {
      const page = await api.mailThreads(paneId, { account, labelId, q: query || undefined, pageToken: token });
      setThreads((current) => [...current, ...page.threads.filter((entry) => !current.some((row) => row.threadId === entry.threadId && row.account === entry.account))]);
      setNextPageToken(page.nextPageToken);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "More mail could not be loaded.");
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextPageToken, paneId]);

  const openThread = useCallback(async (target: Pick<MailThreadSummary, "account" | "threadId"> | null, images = false) => {
    if (!target) { setThread(null); setSelectedThreadId(null); return null; }
    setSelectedThreadId(target.threadId);
    setLoadingThread(true);
    try {
      const response = await api.mailThread(paneId, target.account, target.threadId, images);
      setThread(response.thread);
      setError(null);
      return response.thread;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The conversation could not be loaded.");
      return null;
    } finally {
      setLoadingThread(false);
    }
  }, [paneId]);

  // A Gmail search, so the search box shows the filter and clearing it lifts it; the open conversation stays.
  const showOnlyThread = useCallback(async (target: Pick<MailThreadSummary, "account" | "threadId">) => {
    const loaded = await openThread(target);
    if (!loaded) return;
    const messageId = loaded.messages.find((message) => message.rfcMessageId)?.rfcMessageId?.replace(/^<|>$/g, "");
    setSelectionState({ account: target.account, labelId: "ALL", query: messageId ? `rfc822msgid:${messageId}` : "" });
  }, [openThread]);

  const setSelection = useCallback((update: Partial<MailboxSelection>) => {
    setSelectionState((current) => ({ ...current, ...update }));
    setThread(null);
    setSelectedThreadId(null);
  }, []);

  // A changed selection reloads the list; the server learns what the operator looks at (debounced).
  useEffect(() => { void refresh(); }, [refresh, selection.account, selection.labelId, selection.query]);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => {
      void api.updateMailCopilotView(paneId, { account: selection.account, labelId: selection.labelId, threadId: selectedThreadId, messageId: null, query: selection.query || null }).catch(() => undefined);
    }, VIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, paneId, selectedThreadId, selection.account, selection.labelId, selection.query]);

  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    const unsubscribe = subscribeMailCopilotLiveEvents(paneId, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), LIVE_REFRESH_DEBOUNCE_MS);
    });
    return () => { unsubscribe(); window.clearTimeout(timer); };
  }, [enabled, paneId, refresh]);

  const patchThread = useCallback((threadId: string, update: Partial<MailThreadSummary>) => {
    setThreads((current) => current.map((row) => row.threadId === threadId ? { ...row, ...update } : row));
  }, []);
  const removeThread = useCallback((threadId: string) => {
    setThreads((current) => current.filter((row) => row.threadId !== threadId));
    setSelectedThreadId((current) => current === threadId ? null : current);
    setThread((current) => current?.threadId === threadId ? null : current);
  }, []);

  return useMemo(() => ({ accounts, labels, threads, nextPageToken, errors, thread, selectedThreadId, loading, loadingMore, loadingThread, error, selection,
    setSelection, refresh, loadMore, openThread, showOnlyThread, patchThread, removeThread }),
    [accounts, labels, threads, nextPageToken, errors, thread, selectedThreadId, loading, loadingMore, loadingThread, error, selection, setSelection, refresh, loadMore, openThread, showOnlyThread, patchThread, removeThread]);
}
