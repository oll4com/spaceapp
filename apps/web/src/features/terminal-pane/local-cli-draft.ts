import type { PaneCliUploadedFile } from "@space/contracts";

export interface LocalCliFile {
  id: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  uploaded?: PaneCliUploadedFile;
}

export interface LocalCliSubmission {
  id: string;
  sessionId: string;
  text: string;
  files: LocalCliFile[];
  /** Frozen wire payload, never reconstructed after an ambiguous response. */
  payload: string;
  imagePaths: string[];
  status: "SENDING" | "SENT" | "UNCERTAIN" | "REJECTED";
}

export interface LocalCliDraft {
  version: 1;
  revision: string;
  text: string;
  files: LocalCliFile[];
  submission: LocalCliSubmission | null;
}

export const emptyLocalCliDraft = (): LocalCliDraft => ({ version: 1, revision: "", text: "", files: [], submission: null });

export function localCliDraftKey(userId: string, paneId: string): string {
  return `space.cli.localDraft.v1:${encodeURIComponent(userId)}:${encodeURIComponent(paneId)}`;
}

export function readLocalCliDraft(storage: Storage, key: string): LocalCliDraft {
  const raw = storage.getItem(key);
  if (raw === null) return emptyLocalCliDraft();
  const value = JSON.parse(raw) as LocalCliDraft;
  const filesValid = (files: unknown): files is LocalCliFile[] => Array.isArray(files) && files.every(file =>
    file && typeof file.id === "string" && typeof file.name === "string" && typeof file.type === "string" &&
    typeof file.size === "number" && typeof file.lastModified === "number" &&
    (!file.uploaded || (typeof file.uploaded.sessionId === "string" && typeof file.uploaded.terminalPath === "string" &&
      typeof file.uploaded.shellQuotedPath === "string" && typeof file.uploaded.mimeType === "string")));
  const submission = value?.submission;
  const submissionValid = submission === null || (submission && typeof submission.id === "string" &&
    typeof submission.sessionId === "string" && typeof submission.text === "string" && typeof submission.payload === "string" &&
    filesValid(submission.files) && Array.isArray(submission.imagePaths) && submission.imagePaths.every(path => typeof path === "string") &&
    ["SENDING", "SENT", "UNCERTAIN", "REJECTED"].includes(submission.status));
  if (value?.version !== 1 || typeof value.revision !== "string" || typeof value.text !== "string" ||
      !filesValid(value.files) || !submissionValid) {
    throw new Error("This saved draft cannot be opened. Its stored copy has been kept.");
  }
  return value;
}

/** Synchronous on every edit: no debounce window can lose the last typed characters on Ctrl+F5. */
export function writeLocalCliDraft(storage: Storage, key: string, previousRevision: string, draft: LocalCliDraft): LocalCliDraft {
  const current = readLocalCliDraft(storage, key);
  if (current.revision !== previousRevision) {
    throw new Error("Another tab changed this draft. Copy your unsaved text before reopening it here.");
  }
  const next = { ...draft, revision: crypto.randomUUID() };
  storage.setItem(key, JSON.stringify(next));
  return next;
}

type ReloadGuard = () => Promise<boolean> | boolean;
const reloadGuards = new Set<ReloadGuard>();
let draftGeneration = 0;
export function noteLocalCliDraftChange(): void { draftGeneration += 1; }

export function registerLocalCliDraftReloadGuard(guard: ReloadGuard): () => void {
  reloadGuards.add(guard);
  noteLocalCliDraftChange();
  return () => { reloadGuards.delete(guard); noteLocalCliDraftChange(); };
}

/** App upgrades wait for file transactions. Failed saves keep the page and its recoverable data open. */
export async function reloadAfterLocalCliDraftsSaved(reload: () => void): Promise<boolean> {
  for (;;) {
    const generation = draftGeneration;
    const results = await Promise.allSettled([...reloadGuards].map(guard => guard()));
    if (results.some(result => result.status === "rejected" || !result.value)) return false;
    // Another pane may have accepted a file while this pane's transaction was pending.
    if (generation !== draftGeneration) continue;
    reload();
    return true;
  }
}

export interface LocalCliFileStore {
  put(scope: string, files: Array<{ id: string; blob: Blob }>): Promise<void>;
  get(scope: string, id: string): Promise<Blob | null>;
  remove(scope: string, ids: string[]): Promise<void>;
}

const localDraftDurability = new Map<string, LocalCliDraftDurability>();

/** Unsaved data and its reload fence outlive an editor that temporarily unmounts. */
export class LocalCliDraftDurability {
  unsavedDraft: LocalCliDraft | null = null;
  readonly volatileFiles = new Map<string, Blob>();
  fileWrites: Promise<void> = Promise.resolve();
  fileError: string | null = null;
  private pendingWrites = 0;
  private listeners = new Set<() => void>();
  private unregister: (() => void) | null = null;

  constructor(readonly scope: string) {}

  get savingFiles(): boolean { return this.volatileFiles.size > 0 || this.pendingWrites > 0; }
  private beforeUnload = (event: BeforeUnloadEvent) => {
    if (!this.unsavedDraft && !this.savingFiles) return;
    event.preventDefault();
    event.returnValue = "";
  };

  private track() {
    localDraftDurability.set(this.scope, this);
    if (this.unregister) return;
    this.unregister = registerLocalCliDraftReloadGuard(async () => {
      await this.fileWrites;
      return !this.unsavedDraft && !this.savingFiles;
    });
    window.addEventListener("beforeunload", this.beforeUnload);
  }

  private changed() {
    noteLocalCliDraftChange();
    for (const listener of this.listeners) listener();
    if (this.listeners.size || this.unsavedDraft || this.savingFiles) return;
    this.unregister?.();
    this.unregister = null;
    window.removeEventListener("beforeunload", this.beforeUnload);
    if (localDraftDurability.get(this.scope) === this) localDraftDurability.delete(this.scope);
  }

  retain(listener: () => void): () => void {
    this.listeners.add(listener);
    this.track();
    listener();
    return () => { this.listeners.delete(listener); this.changed(); };
  }

  /** Called only by the editor holding the browser lock, after its fenced storage write. */
  keepUnsaved(draft: LocalCliDraft | null) {
    this.unsavedDraft = draft;
    this.track();
    this.changed();
  }

  stageFiles(files: Array<{ id: string; blob: Blob }>) {
    for (const file of files) this.volatileFiles.set(file.id, file.blob);
    this.track();
    this.changed();
  }

  keepFileError(message: string) {
    this.fileError = message;
    this.track();
    this.changed();
  }

  /** Retries join the same queue, including writes started by a previous editor. */
  saveFiles(store: LocalCliFileStore, files: Array<{ id: string; blob: Blob }>): Promise<void> {
    this.pendingWrites += 1;
    this.fileError = null;
    this.track();
    const write = this.fileWrites.catch(() => undefined).then(async () => {
      await store.put(this.scope, files);
      for (const file of files) if (this.volatileFiles.get(file.id) === file.blob) this.volatileFiles.delete(file.id);
    });
    this.fileWrites = write.then(() => {
      this.pendingWrites -= 1;
      if (!this.pendingWrites) this.fileError = this.volatileFiles.size
        ? "Some files are not saved. Keep this tab open and retry saving." : null;
      this.changed();
    }, error => {
      this.pendingWrites -= 1;
      this.fileError = `${error instanceof Error ? error.message : "Files could not be saved."} Keep this tab open and retry saving.`;
      this.changed();
      throw error;
    });
    this.changed();
    return this.fileWrites;
  }
}

export function getLocalCliDraftDurability(scope: string): LocalCliDraftDurability {
  let state = localDraftDurability.get(scope);
  if (!state) {
    state = new LocalCliDraftDurability(scope);
    localDraftDurability.set(scope, state);
  }
  return state;
}

const DATABASE = "space-cli-local-drafts";
const FILES = "files";

function openDraftDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("Local file storage is unavailable in this browser."));
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(FILES);
    request.onerror = () => reject(request.error ?? new Error("Local file storage could not be opened."));
    request.onblocked = () => reject(new Error("Close older Space tabs to unlock local file storage."));
    request.onsuccess = () => resolve(request.result);
  });
}

async function fileTransaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => () => T): Promise<T> {
  const db = await openDraftDatabase();
  return new Promise((resolve, reject) => {
    // A transaction's completion, not an individual request's success, is the durability boundary.
    let transaction: IDBTransaction;
    let result: () => T;
    try {
      transaction = db.transaction(FILES, mode, { durability: "strict" });
      result = operation(transaction.objectStore(FILES));
    } catch (error) { db.close(); reject(error); return; }
    transaction.oncomplete = () => { db.close(); resolve(result()); };
    transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error ?? new Error("The file could not be saved on this device.")); };
  });
}

const blobKey = (scope: string, id: string) => `${scope}:${id}`;

export const localCliFileStore: LocalCliFileStore = {
  put: (scope, files) => fileTransaction("readwrite", store => {
    for (const file of files) store.put(file.blob, blobKey(scope, file.id));
    return () => undefined;
  }),
  get: (scope, id) => fileTransaction("readonly", store => {
    const request = store.get(blobKey(scope, id));
    return () => request.result instanceof Blob ? request.result : null;
  }),
  remove: (scope, ids) => fileTransaction("readwrite", store => {
    for (const id of ids) store.delete(blobKey(scope, id));
    return () => undefined;
  })
};

export function localCliPrompt(text: string, files: LocalCliFile[], nativeImages: boolean): { text: string; imagePaths: string[] } {
  const counts = { Image: 0, Video: 0, File: 0 };
  const imagePaths: string[] = [];
  const references: string[] = [];
  for (const file of files) {
    const uploaded = file.uploaded;
    if (!uploaded) throw new Error(`${file.name} has not finished uploading.`);
    if (nativeImages && uploaded.isImage) {
      imagePaths.push(uploaded.terminalPath);
      continue;
    }
    const kind = uploaded.isImage ? "Image" : uploaded.mimeType.startsWith("video/") ? "Video" : "File";
    references.push(`[${kind} #${++counts[kind]}] ${uploaded.shellQuotedPath}`);
  }
  return { text: [text, ...references].filter(Boolean).join("\n"), imagePaths };
}
