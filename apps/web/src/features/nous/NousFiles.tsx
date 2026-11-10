import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { NOUS_ATTACHMENTS_MARKER, type NousAttachment } from "@space/contracts";
import { api } from "../../api.js";
import { DockIconButton } from "../dock-kit/DockKit.js";
import { Download, File, FileText, Film, Loader2, X } from "../ui-theme/app-icons.js";

// Files the operator sends Nous (plan clipboard:hQg9iKGYDqx7): the composer's pending files and a sent message's files.
// Each opens the Agent Files preview on click (plan clipboard:h90wb7l2Ns7q).

const LazyFilePreviewDialog = lazy(() => import("../agent-files/AgentFilesDock.js").then((module) => ({ default: module.FilePreviewDialog })));

const MB = 1024 * 1024;
// The server's limits (NOUS_ATTACHMENT_LIMITS); checked here first so a large file fails before it uploads.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
function limitFor(file: File): { bytes: number; label: string } {
  if (IMAGE_TYPES.has(file.type)) return { bytes: 20 * MB, label: "Images" };
  if (VIDEO_TYPES.has(file.type) || /\.(mp4|m4v|mov|webm)$/i.test(file.name)) return { bytes: 100 * MB, label: "Videos" };
  return { bytes: 25 * MB, label: "Files" };
}

export const formatBytes = (bytes: number) => (bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** The operator's own words: the server appends the files' block for Nous's turn after a marker the dock does not show. */
export function operatorText(content: string): string {
  const at = content.indexOf(NOUS_ATTACHMENTS_MARKER);
  return (at === -1 ? content : content.slice(0, at)).trim();
}

export interface PendingFile {
  key: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "failed";
  attachment: NousAttachment | null;
  error: string | null;
  /** A local preview of an image while and after it uploads. */
  previewUrl: string | null;
}

// The API's message without its code prefix ("UNSUPPORTED_MEDIA_TYPE: fake.png is not a valid PNG image.").
const messageOf = (error: unknown, fallback: string) => {
  if (!(error instanceof Error) || !error.message) return fallback;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && error.message.startsWith(`${code}: `) ? error.message.slice(code.length + 2) : error.message;
};
let pendingKey = 0;

/** The composer's files: each uploads on its own, so one refused file leaves the others attached. */
export function usePendingFiles(onError: (message: string) => void) {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;
  // One upload at a time: the server takes at most 4 at once (fileUploadLimits.concurrent) and a message carries up to 10 files.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => () => { for (const file of filesRef.current) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl); }, []);

  const add = useCallback((incoming: File[]) => {
    if (!incoming.length) return;
    for (const file of incoming) {
      const limit = limitFor(file);
      if (file.size > limit.bytes) { onError(`${file.name || "The file"} is ${formatBytes(file.size)}; ${limit.label.toLowerCase()} can be at most ${formatBytes(limit.bytes)}.`); continue; }
      if (!file.size) { onError(`${file.name || "The file"} is empty.`); continue; }
      const key = `nous-file-${++pendingKey}`;
      const previewUrl = IMAGE_TYPES.has(file.type) && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null;
      setFiles((current) => [...current, { key, name: file.name || "Pasted image", size: file.size, status: "uploading", attachment: null, error: null, previewUrl }]);
      queue.current = queue.current.then(() => api.uploadNousAttachments([file]).then(
        ({ attachments: [attachment] }) => setFiles((current) => current.map((entry) => entry.key === key ? { ...entry, status: "ready", attachment: attachment ?? null } : entry)),
        (error: unknown) => setFiles((current) => current.map((entry) => entry.key === key ? { ...entry, status: "failed", error: messageOf(error, "The file could not be uploaded.") } : entry))
      ));
    }
  }, [onError]);

  const remove = useCallback((key: string) => {
    const file = filesRef.current.find((entry) => entry.key === key);
    if (!file) return;
    if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    // An uploaded file nobody sends would wait a day for the sweep; remove it now.
    if (file.attachment) void api.deleteNousAttachment(file.attachment.id).catch(() => undefined);
    setFiles((current) => current.filter((entry) => entry.key !== key));
  }, []);

  /** After a send: the files belong to the message now. */
  const clear = useCallback(() => {
    for (const file of filesRef.current) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
    setFiles([]);
  }, []);

  return { files, add, remove, clear, uploading: files.some((file) => file.status === "uploading"), readyIds: files.flatMap((file) => file.attachment && file.status === "ready" ? [file.attachment.id] : []) };
}

/** Files on the clipboard (a pasted screenshot is the usual case). */
export function clipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const listed = Array.from(data.files ?? []);
  if (listed.length) return listed;
  return Array.from(data.items ?? []).flatMap((item) => (item.kind === "file" ? [item.getAsFile()].filter((file): file is File => Boolean(file)) : []));
}

export function NousPendingFiles({ files, onRemove }: { files: PendingFile[]; onRemove(key: string): void }) {
  const [viewing, setViewing] = useState<NousAttachment | null>(null);
  if (!files.length) return null;
  // A file removed or sent while open closes its preview.
  const open = viewing && files.some((file) => file.attachment?.id === viewing.id) ? viewing : null;
  return (
    <>
      <ul className="nous-files is-pending" aria-label="Attached files">
        {files.map((file) => {
          const body = (
            <>
              {file.previewUrl ? <img src={file.previewUrl} alt="" /> : <FileGlyph kind={file.attachment?.kind ?? null} name={file.name} />}
              <span className="nous-file-name">{file.name}</span>
              <span className="nous-file-size">{file.status === "failed" ? file.error : file.status === "uploading" ? "Uploading…" : formatBytes(file.size)}</span>
            </>
          );
          const ready = file.status === "ready" ? file.attachment : null;
          return (
            <li key={file.key} className={`nous-file-chip is-${file.status}`} title={file.error ?? file.name}>
              {ready ? <button type="button" className="nous-file-open" aria-label={`Preview ${file.name}`} onClick={() => setViewing(ready)}>{body}</button> : body}
              {file.status === "uploading" ? <Loader2 className="nous-file-spin" aria-hidden="true" /> : null}
              <DockIconButton label={`Remove ${file.name}`} icon={X} onClick={() => onRemove(file.key)} />
            </li>
          );
        })}
      </ul>
      {open ? <NousFilePreview file={open} onClose={() => setViewing(null)} /> : null}
    </>
  );
}

function FileGlyph({ kind, name }: { kind: NousAttachment["kind"] | null; name: string }) {
  const Icon = kind === "VIDEO" || /\.(mp4|m4v|mov|webm)$/i.test(name) ? Film : kind === "DOCUMENT" ? FileText : File;
  return <Icon className="nous-file-glyph" aria-hidden="true" />;
}

/** What the preview shows: images, video and audio play, a PDF in the browser's viewer, a document's extracted text; the rest downloads. */
function previewOf(file: NousAttachment): { kind: "IMAGE" | "VIDEO" | "AUDIO" | "PDF" | "TEXT" | "NONE"; url: string } {
  const mime = file.mimeType.toLowerCase();
  const kind = file.kind === "IMAGE" || file.kind === "VIDEO" ? file.kind
    : mime.startsWith("audio/") ? "AUDIO"
    : mime === "application/pdf" ? "PDF"
    : file.kind === "DOCUMENT" && file.readable && !file.readable.startsWith("UNAVAILABLE") ? "TEXT" : "NONE";
  return { kind, url: api.nousAttachmentUrl(file.id, kind === "TEXT" ? "text" : undefined) };
}

function NousFilePreview({ file, onClose }: { file: NousAttachment; onClose(): void }) {
  const { kind, url } = previewOf(file);
  const facts = [formatBytes(file.byteSize), file.width && file.height ? `${file.width}×${file.height}` : null,
    file.durationSeconds !== null ? `${Math.round(file.durationSeconds)} s` : null,
    kind === "TEXT" && file.readable?.startsWith("PARTIAL") ? `Partial text${file.readable.slice(7)}` : null];
  return (
    <Suspense fallback={null}>
      <LazyFilePreviewDialog filename={file.filename} meta={facts.filter(Boolean).join(" · ")} kind={kind} url={url} closeLabel="Close preview" onClose={onClose}
        actions={(
          <a href={api.nousAttachmentUrl(file.id, "download")} download={file.filename} className="dock-kit-icon-button" aria-label={`Download ${file.filename}`} title={`Download ${file.filename}`}>
            <Download aria-hidden="true" />
          </a>
        )} />
    </Suspense>
  );
}

/** A sent message's files: image and video stills, documents and files; each opens its preview, each downloads. */
export function NousMessageFiles({ files }: { files: NousAttachment[] }) {
  const [viewing, setViewing] = useState<NousAttachment | null>(null);
  if (!files.length) return null;
  return (
    <>
      <ul className="nous-files" aria-label="Sent files">
        {files.map((file) => (
          <li key={file.id} className={`nous-file is-${file.kind.toLowerCase()}`}>
            {file.kind === "IMAGE" || file.kind === "VIDEO" ? (
              <button type="button" className="nous-file-thumb" onClick={() => setViewing(file)} aria-label={`Preview ${file.filename}`}>
                <img src={api.nousAttachmentUrl(file.id, "preview")} alt={file.filename} loading="lazy" />
                {file.kind === "VIDEO" ? <Film className="nous-file-play" aria-hidden="true" /> : null}
              </button>
            ) : (
              <button type="button" className="nous-file-doc" onClick={() => setViewing(file)} aria-label={`Preview ${file.filename}`}>
                <FileGlyph kind={file.kind} name={file.filename} /><span className="nous-file-name">{file.filename}</span>
              </button>
            )}
            <span className="nous-file-meta">
              <span className="nous-file-size">{formatBytes(file.byteSize)}{file.durationSeconds !== null ? ` · ${Math.round(file.durationSeconds)} s` : ""}</span>
              <a href={api.nousAttachmentUrl(file.id, "download")} download={file.filename} aria-label={`Download ${file.filename}`} className="nous-file-download">
                <Download aria-hidden="true" />
              </a>
            </span>
          </li>
        ))}
      </ul>
      {viewing ? <NousFilePreview file={viewing} onClose={() => setViewing(null)} /> : null}
    </>
  );
}
