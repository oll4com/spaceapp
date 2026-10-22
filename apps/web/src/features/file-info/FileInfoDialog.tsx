import { useEffect, useState } from "react";
import { resolveDesignFormat, type DesignAsset, type DesignAssetMadeBy } from "@space/contracts";
import { api, type ArtifactMetadataPayload } from "../../api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { X } from "../ui-theme/app-icons.js";
import "./file-info.css";

// The Details dialog of Agent Files and the Design pane (operator request 2026-10-19): what a file shows, who made it, its
// measured size and the metadata it carries inside (a design PNG's `spaceapp:design`). A Design pane passes the asset
// record too, so JPEG, WebP and MP4 designs and older rows show what Space knows.

interface FileInfoDialogProps {
  artifactId: string;
  filename: string;
  asset?: DesignAsset | null;
  onClose(): void;
}

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
function madeByOf(value: unknown): DesignAssetMadeBy | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return record.by === "AGENT" || record.by === "OPERATOR" ? { by: record.by, runtimeId: text(record.runtimeId), model: text(record.model) } : null;
}
function madeByText(madeBy: DesignAssetMadeBy | null): string {
  if (!madeBy) return "Not recorded";
  if (madeBy.by === "OPERATOR") return "You (Studio)";
  return [madeBy.model, madeBy.runtimeId].filter(Boolean).join(" · ") || "An agent";
}
function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileInfoDialog({ artifactId, filename, asset, onClose }: FileInfoDialogProps) {
  const [data, setData] = useState<ArtifactMetadataPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api.artifactMetadata(artifactId).then((payload) => { if (live) setData(payload); }, (reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { live = false; };
  }, [artifactId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const design = data?.design ?? null;
  const embedded = data?.embedded ?? {};
  const description = text(asset?.description) ?? text(design?.description) ?? text(embedded.Description);
  const madeBy = asset?.madeBy ?? madeByOf(design?.madeBy);
  const width = data?.image?.width ?? asset?.width ?? null;
  const height = data?.image?.height ?? asset?.height ?? null;
  const format = resolveDesignFormat(asset?.formatId ?? text(design?.formatId) ?? "");
  const engine = asset?.engine ?? text(design?.engine);
  const model = asset?.model ?? text(design?.model);
  const label = text(asset?.label) ?? text(design?.label) ?? text(embedded.Title);
  const metadata = data?.artifact?.metadata ?? {};
  const source = [text(metadata.source), text(metadata.folder), text(metadata.runtimeId)].filter(Boolean).join(" · ");
  const insideKeys = Object.keys(embedded);
  const isImage = (data?.artifact?.mimeType ?? asset?.mimeType ?? "").startsWith("image/");

  const rows: Array<[string, string]> = [
    ["What it shows", description ?? "Not recorded"],
    ["Made by", madeByText(madeBy)],
    ...(width && height ? [["Size", `${width} × ${height} px${format ? ` · ${format.label}${format.width === width && format.height === height ? " (matches the format)" : ` (the format is ${format.width} × ${format.height})`}` : ""}`] as [string, string]] : []),
    ...(engine ? [["Engine", `${engine}${model ? ` · ${model}` : ""}`] as [string, string]] : []),
    ...(label ? [["Label", label] as [string, string]] : []),
    ...(text(asset?.prompt) ? [["Prompt", asset!.prompt!] as [string, string]] : []),
    ...(asset?.parentAssetId ?? text(design?.parentAssetId) ? [["Version of", (asset?.parentAssetId ?? text(design?.parentAssetId))!] as [string, string]] : []),
    ...(data ? [
      ["File", `${data.artifact.filename} · ${data.artifact.mimeType} · ${bytesText(data.artifact.byteSize)}`] as [string, string],
      ["Created", formatUserTime(data.artifact.createdAt, { withDate: true })] as [string, string],
      ...(source ? [["Source", source] as [string, string]] : []),
      ["SHA-256", data.artifact.sha256] as [string, string],
      ["Inside the file", insideKeys.length ? insideKeys.join(", ") : isImage ? "No metadata inside this file" : "Not read for this file type"] as [string, string]
    ] : [])
  ];

  return (
    <div className="attachment-modal file-info-modal" role="dialog" aria-modal="true" aria-label={`Details of ${filename}`} onClick={onClose}>
      <div className="attachment-modal-body file-info-body" onClick={(event) => event.stopPropagation()}>
        <div className="file-info-head">
          <strong className="file-info-title" title={filename}>{filename}</strong>
          <button type="button" className="file-info-close" aria-label="Close details" title="Close details" autoFocus onClick={onClose}><X aria-hidden="true" /></button>
        </div>
        <dl className="file-info-facts">
          {rows.map(([name, value]) => <div className="file-info-fact" key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
        </dl>
        {!data && !error ? <p className="file-info-note" role="status">Reading the file…</p> : null}
        {error ? <p className="file-info-note" role="alert">The file details could not be read: {error}</p> : null}
      </div>
    </div>
  );
}
