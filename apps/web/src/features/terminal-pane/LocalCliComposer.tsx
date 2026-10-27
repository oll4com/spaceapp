import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./local-cli-composer.css";
import { paneCliUploadMaxBytes, paneCliUploadMaxCount, type PaneCliUploadedFile } from "@space/contracts";
import { api } from "../../api.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { ArrowUp, History, NotebookPen, Paperclip, X } from "../ui-theme/app-icons.js";
import {
  getLocalCliDraftDurability, localCliDraftKey, localCliFileMarkers, localCliFileStore, localCliPrompt, noteLocalCliDraftChange, readLocalCliDraft,
  withoutLocalCliMarker, writeLocalCliDraft, type LocalCliDraft, type LocalCliFile, type LocalCliFileStore
} from "./local-cli-draft.js";

const noLocalFiles: LocalCliFile[] = [];
// A phone's on-screen keyboard Enter arrives as an IME key (229) and adds a line; only Send sends there.
const desktopPlaceholder = "Write here. Enter sends; Shift+Enter adds a line.";
const touchPlaceholder = "Write here. Enter adds a line; tap Send to send.";
const touchDevice = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)")?.matches === true;

export interface LocalCliComposerProps {
  paneId: string;
  paneTitle: string;
  sessionId: string;
  nativeImages: boolean;
  canSend: boolean;
  prepareSend(): Promise<boolean>;
  onUploaded?(files: PaneCliUploadedFile[]): void;
  onClose(): void;
  /** The CLI toolbar row; the draft's buttons render there so the draft adds no row of its own. */
  toolbar?: HTMLElement | null;
}

/** Loads owner identity only when the optional composer is opened, never for every warm terminal. */
export function LocalCliComposer(props: LocalCliComposerProps) {
  const [owner, setOwner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void api.me().then(auth => {
      if (!current) return;
      if (!auth.user) throw new Error("Sign in to open your saved draft.");
      setOwner(auth.user.id);
    }).catch(error => { if (current) setError(String(error instanceof Error ? error.message : error)); });
    return () => { current = false; };
  }, []);
  return owner ? <LocalCliDraftEditor key={`${owner}:${props.paneId}`} {...props} userId={owner} /> :
    <div className="local-cli-composer" data-local-cli-composer="" role="status">{error ?? "Opening saved draft…"}</div>;
}

export function LocalCliDraftEditor({ userId, fileStore = localCliFileStore, ...props }: LocalCliComposerProps & {
  userId: string;
  fileStore?: LocalCliFileStore;
}) {
  const storage = getSpaceRuntime().platform.localStorage;
  const scope = localCliDraftKey(userId, props.paneId);
  const [durability] = useState(() => getLocalCliDraftDurability(scope));
  const [loaded] = useState(() => {
    try { return { draft: durability.unsavedDraft ?? readLocalCliDraft(storage, scope), error: durability.unsavedDraft ? "This draft has unsaved changes. Retry saving or copy your text before leaving." : null }; }
    catch (error) { return { draft: null, error: error instanceof Error ? error.message : "The saved draft could not be opened." }; }
  });
  const [draft, setDraft] = useState(loaded.draft);
  const draftRef = useRef(draft);
  const [error, setError] = useState<string | null>(loaded.error);
  const [savingFiles, setSavingFiles] = useState(durability.savingFiles);
  const [fileError, setFileError] = useState<string | null>(durability.fileError);
  const [sending, setSending] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [saved, setSaved] = useState(loaded.draft !== null && !durability.unsavedDraft);
  const [locked, setLocked] = useState(false);
  const [lockAttempt, setLockAttempt] = useState(0);
  const [lockError, setLockError] = useState<string | null>(null);
  const lockHeldRef = useRef(false);
  const inFlightRef = useRef(false);
  const aliveRef = useRef(true);
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | null>(null);
  const [previews, setPreviews] = useState<{ files: LocalCliFile[]; urls: Record<string, string> } | null>(null);

  function save(next: LocalCliDraft): boolean {
    if (!lockHeldRef.current) return false;
    noteLocalCliDraftChange();
    // Keep edits visible even if storage is full; never replace them with an older saved snapshot.
    let updated = next;
    try {
      updated = writeLocalCliDraft(storage, scope, draftRef.current?.revision ?? "", next);
      durability.keepUnsaved(null);
      setSaved(true);
      setError(null);
    } catch (error) {
      durability.keepUnsaved(updated);
      setSaved(false);
      setError(`${error instanceof Error ? error.message : "This draft could not be saved."} Keep this tab open or copy your text.`);
    }
    draftRef.current = updated;
    setDraft(updated);
    return !durability.unsavedDraft;
  }

  useEffect(() => {
    let current = true;
    let release: (() => void) | undefined;
    setLocked(false);
    lockHeldRef.current = false;
    setLockError(null);
    if (!navigator.locks) {
      setLockError("This browser cannot safely lock local drafts. Update your browser to use local composition.");
      return;
    }
    // Hold one browser-wide editor lock, including during HTTP sends. A stale tab
    // cannot create a second submission ID for the same saved draft.
    void navigator.locks.request(scope, { ifAvailable: true }, async lock => {
      if (!current) return;
      if (!lock) { setLockError("This draft is open in another tab. Close it there, then retry opening here."); return; }
      try {
        // Keep the unsaved revision when recovering memory. A different tab's
        // newer revision still makes writeLocalCliDraft refuse to overwrite it.
        const restored = durability.unsavedDraft ?? readLocalCliDraft(storage, scope);
        draftRef.current = restored;
        setDraft(restored);
        setSaved(!durability.unsavedDraft);
        lockHeldRef.current = true;
        setLocked(true);
        await new Promise<void>(resolve => { release = resolve; });
      } catch (error) { setLockError(error instanceof Error ? error.message : "The draft could not be opened."); }
    }).catch(() => { if (current) setLockError("The draft could not be locked. Close other tabs and retry opening."); });
    return () => { current = false; lockHeldRef.current = false; release?.(); };
  }, [scope, storage, lockAttempt]);

  useEffect(() => {
    aliveRef.current = true;
    const release = durability.retain(() => {
      setSavingFiles(durability.savingFiles);
      setFileError(durability.fileError);
    });
    return () => { aliveRef.current = false; release(); };
  }, [durability]);

  // A restored outbox is queried, never resent. The original request may have reached the CLI before reload.
  useEffect(() => {
    if (locked && (draftRef.current?.submission?.status === "SENDING" || draftRef.current?.submission?.status === "UNCERTAIN")) {
      void checkReceipt();
    }
  }, [locked]);

  const visibleFiles = showRecovery && draft?.submission ? draft.submission.files : draft?.files ?? noLocalFiles;
  // Remove old image nodes before their effect cleanup revokes object URLs.
  // A recovered attachment must never reuse a URL from an earlier file list.
  const previewUrls = previews?.files === visibleFiles ? previews.urls : {};
  useEffect(() => {
    let current = true;
    const urls: Record<string, string> = {};
    void Promise.all(visibleFiles.filter(file => file.type.startsWith("image/")).map(async file => {
      const blob = durability.volatileFiles.get(file.id) ?? await fileStore.get(scope, file.id).catch(() => null);
      if (!current) return;
      if (blob) urls[file.id] = URL.createObjectURL(blob);
      else if (file.uploaded?.artifactId) urls[file.id] = api.artifactFileUrl(file.uploaded.artifactId);
    })).then(() => { if (current) setPreviews({ files: visibleFiles, urls: { ...urls } }); });
    return () => {
      current = false;
      Object.values(urls).forEach(url => { if (url.startsWith("blob:")) URL.revokeObjectURL(url); });
    };
  }, [visibleFiles, fileStore, scope]);

  async function addFiles(files: File[]) {
    const current = draftRef.current;
    if (!current || !locked || inFlightRef.current || !files.length) return;
    if (files.length + current.files.length > paneCliUploadMaxCount || files.some(file => file.size > paneCliUploadMaxBytes)) {
      setError(`Attach up to ${paneCliUploadMaxCount} files, each no larger than 10 MB.`);
      return;
    }
    const markers = localCliFileMarkers(current.files, files.map(file => file.type));
    const added = files.map((file, index) => ({ id: crypto.randomUUID(), name: file.name || "clipboard-image", type: file.type, size: file.size,
      lastModified: file.lastModified, marker: markers[index] }));
    const pendingFiles = files.map((file, index) => ({ id: added[index]!.id, blob: file }));
    // Markers go in at the caret like the CLI's own "[Image #1]"; a selection is kept, never replaced.
    const at = Math.min(textareaRef.current?.selectionEnd ?? current.text.length, current.text.length);
    const inserted = `${at && !/\s/.test(current.text[at - 1]!) ? " " : ""}${markers.join(" ")} `;
    caretRef.current = at + inserted.length;
    durability.stageFiles(pendingFiles);
    if (!save({ ...current, text: current.text.slice(0, at) + inserted + current.text.slice(at), files: [...current.files, ...added] })) {
      durability.keepFileError("The selected files are not saved. Keep this tab open and retry saving.");
      return;
    }
    try {
      await durability.saveFiles(fileStore, pendingFiles);
      if (typeof navigator.storage?.persist === "function") void navigator.storage.persist().catch(() => false);
    } catch { /* The shared durability state keeps the error and original bytes. */ }
  }

  useLayoutEffect(() => {
    if (caretRef.current === null || !textareaRef.current) return;
    textareaRef.current.setSelectionRange(caretRef.current, caretRef.current);
    caretRef.current = null;
  }, [draft?.text]);

  async function retrySave() {
    const current = draftRef.current;
    if (!current || !save(current)) return;
    const files = [...durability.volatileFiles].map(([id, blob]) => ({ id, blob }));
    if (!files.length) return;
    try {
      await durability.saveFiles(fileStore, files);
    } catch { /* Reopening the editor can retry these same retained bytes. */ }
  }

  function applyReceipt(id: string, status: "SENT" | "UNCERTAIN" | "REJECTED", reason?: string) {
    const current = draftRef.current;
    if (!current?.submission || current.submission.id !== id) return;
    const next = { ...current, submission: { ...current.submission, status } };
    if (status === "SENT") {
      // Only the frozen sent draft is cleared. New text is not touched by a late receipt.
      if (current.text === current.submission.text && current.files.map(f => f.id).join() === current.submission.files.map(f => f.id).join()) {
        next.text = "";
        next.files = [];
      }
    }
    save(next);
    if (status !== "SENT") setError(reason ?? "Delivery could not be confirmed. Check the CLI before restoring this draft; it will not be sent again automatically.");
  }

  async function checkReceipt() {
    const submission = draftRef.current?.submission;
    if (!submission) return;
    setRecovering(true);
    try {
      const receipt = await api.localCliSubmission(props.paneId, submission.id);
      if (!aliveRef.current) return;
      // A missing receipt cannot prove the original request is no longer in flight.
      applyReceipt(submission.id, receipt.status === "NOT_FOUND" ? "UNCERTAIN" : receipt.status, receipt.reason);
    } catch {
      if (aliveRef.current) setError("Unable to check delivery. Your text and files are still saved; reconnect and check again.");
    } finally { if (aliveRef.current) setRecovering(false); }
  }

  async function send() {
    const current = draftRef.current;
    if (!current || !locked || inFlightRef.current || !props.canSend || (!current.text.trim() && !current.files.length)) return;
    if (current.submission && ["SENDING", "UNCERTAIN"].includes(current.submission.status)) return;
    if (durability.unsavedDraft || durability.savingFiles) { setError("Save your draft and attachments before sending."); return; }
    inFlightRef.current = true;
    setSending(true);
    const expectedSessionId = props.sessionId;
    let submissionId: string | null = null;
    try {
      await durability.fileWrites;
      if (!await props.prepareSend()) throw new Error("CLI input is not ready. Your draft is saved; finish or clear any text in the terminal first.");
      const files: LocalCliFile[] = [];
      for (const file of current.files) {
        if (file.uploaded?.sessionId === expectedSessionId) { files.push(file); continue; }
        const blob = await fileStore.get(scope, file.id);
        if (!blob) throw new Error(`${file.name} is missing from device storage. Reattach it before sending.`);
        const result = await api.uploadCliFiles({ paneId: props.paneId, source: "USER_UPLOAD", files: [new File([blob], file.name, { type: file.type, lastModified: file.lastModified })] });
        const uploaded = result.files[0];
        if (!uploaded || result.sessionId !== expectedSessionId) throw new Error("The CLI session changed. Your draft is saved; try again in the current session.");
        files.push({ ...file, uploaded });
        props.onUploaded?.([uploaded]);
        const latest = draftRef.current!;
        if (!save({ ...latest, files: latest.files.map(candidate => candidate.id === file.id ? { ...file, uploaded } : candidate) })) throw new Error("The uploaded file reference could not be saved. Keep this tab open and retry saving.");
      }
      if (!await props.prepareSend()) throw new Error("CLI input changed before sending. Your draft is saved; finish or clear the text in the terminal first.");
      const payload = localCliPrompt(current.text, files, props.nativeImages);
      submissionId = crypto.randomUUID();
      const snapshot: LocalCliDraft = {
        ...draftRef.current!, files,
        submission: { id: submissionId, sessionId: expectedSessionId, text: current.text, files, payload: payload.text, imagePaths: payload.imagePaths,
          imageOffsets: payload.imageOffsets, status: "SENDING" }
      };
      if (!save(snapshot)) throw new Error("The send receipt could not be saved. Nothing was sent; retry saving first.");
      // Previous confirmed photos remain in the server's photo history. Locally
      // retain the active draft and one recovery copy without leaking old blobs.
      const obsolete = current.submission?.files.filter(file => !files.some(next => next.id === file.id)).map(file => file.id) ?? [];
      if (obsolete.length) void fileStore.remove(scope, obsolete).catch(() => undefined);
      const receipt = await api.submitLocalCliDraft(props.paneId, { submissionId, expectedSessionId, text: payload.text, imagePaths: payload.imagePaths,
        imageOffsets: payload.imageOffsets });
      if (aliveRef.current) applyReceipt(submissionId, receipt.status, receipt.reason);
    } catch (error) {
      if (!aliveRef.current) return;
      if (submissionId && draftRef.current?.submission?.id === submissionId && !durability.unsavedDraft) applyReceipt(submissionId, "UNCERTAIN");
      setError(error instanceof Error ? error.message : "Send failed. Your draft is still saved.");
    } finally {
      inFlightRef.current = false;
      if (aliveRef.current) setSending(false);
    }
  }

  function restore() {
    const current = draftRef.current;
    if (!current?.submission) return;
    if ((current.text || current.files.length) && (current.text !== current.submission.text ||
        current.files.map(file => file.id).join() !== current.submission.files.map(file => file.id).join())) {
      setError("Keep or copy the current draft before restoring the previous one.");
      return;
    }
    // Explicit recovery makes a new send possible; it never sends anything itself.
    if (save({ ...current, text: current.submission.text, files: current.submission.files, submission: null })) {
      setShowRecovery(false);
      textareaRef.current?.focus();
    }
  }

  const uncertain = draft?.submission && ["SENDING", "UNCERTAIN"].includes(draft.submission.status);
  const busy = sending || savingFiles;
  const status = savingFiles ? "Saving attachments…" : !saved ? "Not saved" : sending ? "Sending…" :
    uncertain ? "Delivery needs checking" : draft?.submission?.status === "SENT" && !draft.text && !draft.files.length ? "Sent · recovery copy saved" : "Saved on this device";
  const fieldId = `local-cli-draft-${props.paneId}`;
  const canSendDraft = Boolean(draft && locked && !busy && saved && !uncertain && props.canSend && (draft.text.trim() || draft.files.length));
  const actions = <>
    <span className={status === "Saved on this device" ? "sr-only" : "local-cli-save-state"} role="status">{status}</span>
    <button type="button" className="terminal-shortcuts-button" aria-expanded="true" aria-label="Close local draft" title="Close local draft" disabled={busy || !saved} onClick={props.onClose}><NotebookPen aria-hidden="true" /></button>
    <input ref={inputRef} type="file" hidden multiple onChange={event => {
      const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void addFiles(files);
    }} />
    <button type="button" className="terminal-shortcuts-button" disabled={!draft || !locked || busy} onClick={() => inputRef.current?.click()} aria-label="Attach files to local draft" title="Attach"><Paperclip aria-hidden="true" /></button>
    {!saved || fileError ? <button type="button" className="compact-action" disabled={!locked} onClick={() => { void retrySave(); }}>Retry saving</button> : null}
    {draft?.submission ? <button type="button" className="terminal-shortcuts-button" aria-expanded={showRecovery} aria-label={showRecovery ? "Hide recovery" : "Recovery copy"} title={showRecovery ? "Hide recovery copy" : "Recovery copy of the last send"} onClick={() => setShowRecovery(!showRecovery)}><History aria-hidden="true" /></button> : null}
    {uncertain ? <button type="button" className="compact-action" disabled={recovering || sending || !locked} onClick={() => { void checkReceipt(); }}>{recovering ? "Checking…" : "Check delivery"}</button> : null}
  </>;
  return <div className="local-cli-composer" data-local-cli-composer="" onKeyDown={event => event.stopPropagation()}
    onPaste={event => {
      const files = Array.from(event.clipboardData.files);
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation(); void addFiles(files);
    }}
    onDrop={event => {
      event.preventDefault(); event.stopPropagation(); void addFiles(Array.from(event.dataTransfer.files));
    }} onDragOver={event => { event.preventDefault(); event.stopPropagation(); }}>
    {props.toolbar ? createPortal(actions, props.toolbar) : <div className="local-cli-composer-actions">{actions}</div>}
    <div className="local-cli-input-row">
    <textarea id={fieldId} ref={textareaRef} aria-label={`Local draft for ${props.paneTitle}`} rows={1} maxLength={60_000}
      value={draft?.text ?? ""} disabled={!draft || !locked || sending} placeholder={touchDevice() ? touchPlaceholder : desktopPlaceholder}
      onChange={event => { if (draftRef.current) save({ ...draftRef.current, text: event.target.value }); }}
      onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }}
      onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing && !composingRef.current && event.keyCode !== 229) {
          event.preventDefault(); void send();
        }
      }} />
    <button type="button" className="terminal-turn-control" data-state={canSendDraft ? "ready" : "idle"} aria-label="Send" title="Send draft (Enter)" disabled={!canSendDraft} onClick={() => { void send(); }}><ArrowUp aria-hidden="true" /></button>
    </div>
    {visibleFiles.length ? <ul className="local-cli-files" aria-label={showRecovery ? "Recovery attachments" : "Draft attachments"}>
      {visibleFiles.map(file => <li key={file.id}>
        {previewUrls[file.id] ? <img src={previewUrls[file.id]} alt="" /> : null}
        {file.marker ? <span className="local-cli-file-marker">{file.marker}</span> : null}
        <span title={file.name}>{file.name}</span>
        {!showRecovery ? <button type="button" className="compact-action" aria-label={`Remove ${file.name}`} disabled={busy || !locked} onClick={() => {
          const current = draftRef.current!;
          if (save({ ...current, text: withoutLocalCliMarker(current.text, file.marker), files: current.files.filter(item => item.id !== file.id) }) &&
              !current.submission?.files.some(item => item.id === file.id)) void fileStore.remove(scope, [file.id]).catch(() => undefined);
        }}><X aria-hidden="true" /></button> : null}
      </li>)}
    </ul> : null}
    {error ? <div className="local-cli-error" role="alert">{error}</div> : null}
    {fileError ? <div className="local-cli-error" role="alert">{fileError}</div> : null}
    {lockError ? <div className="local-cli-error" role="alert">{lockError} <button type="button" className="compact-action" onClick={() => setLockAttempt(value => value + 1)}>Retry opening</button></div> : null}
    {showRecovery && draft?.submission ? <div className="local-cli-recovery">
      <p>{draft.submission.status === "SENT" ? "Last confirmed delivery" : "Check the CLI before restoring to avoid sending twice."}</p>
      <pre>{draft.submission.text || "Attachments only"}</pre>
      <button type="button" className="compact-action" disabled={sending || !locked} onClick={restore}>Restore as draft</button>
    </div> : null}
  </div>;
}
