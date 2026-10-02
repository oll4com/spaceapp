import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { X } from "../ui-theme/app-icons.js";
import type { MemoryGraphNodeDetail } from "@space/contracts";

export function MemoryNodeDetail({ detail, loading, onClose, onSelectNode }: {
  detail: MemoryGraphNodeDetail | null;
  loading: boolean;
  onClose: () => void;
  onSelectNode?: (id: string) => void;
  onOpenChanges?: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => { if (detail) panelRef.current?.focus(); }, [detail?.node.id]);
  const record = detail?.record;
  const related = detail?.relatedNodes.filter(node => node.type === "MEMORY" || node.type === "TOPIC" || node.type === "SOURCE") ?? [];
  return <aside ref={panelRef} className="memory-node-detail" aria-label="Memory node detail" tabIndex={-1}>
    <button type="button" className="memory-node-detail-close" aria-label="Close memory node detail" onClick={onClose}><X aria-hidden="true" /></button>
    {loading ? <p role="status">Opening memory…</p> : detail ? <>
      <span className="memory-atlas-eyebrow">{detail.node.type === "MEMORY" ? "MEMORY" : detail.node.type === "TOPIC" ? "CONNECTED THEME" : "KNOWLEDGE SOURCE"}</span>
      <h3>{detail.node.label}</h3>
      {record ? <>
        <div className="memory-atlas-record-meta"><time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })}</time><span>{record.scope.toLowerCase()}</span></div>
        {!!record.tags?.length && <ul className="memory-tag-list" aria-label="Tags">{record.tags.map(tag => <li key={tag}>#{tag}</li>)}</ul>}
        <div className="memory-atlas-prose"><ReactMarkdown remarkPlugins={[remarkGfm]}>{record.body}</ReactMarkdown></div>
        {!!record.topics?.length && <section className="memory-detail-section"><h4>Discovered topics</h4><ul className="memory-tag-list">{record.topics.filter(topic => topic.origin === "DERIVED_TFIDF").map(topic => <li key={topic.label} title={`${Math.round(topic.confidence * 100)}% confidence`}>{topic.label}</li>)}</ul></section>}
      </> : <p>{detail.node.type === "SOURCE" ? "A canonical file. Its connections show referenced files and the memories it contains." : "Explore the memories connected to this theme."}</p>}
      {detail.node.type === "SOURCE" && detail.node.sourcePath ? <p className="memory-atlas-source">{detail.node.sourcePath}</p> : null}
      {related.length > 0 && <section className="memory-detail-section"><h4>Connected knowledge <small>{related.length}</small></h4><ul className="memory-atlas-related">{related.map(node => <li key={node.id}><button type="button" onClick={() => onSelectNode?.(node.id)} disabled={!onSelectNode}><span>{node.type === "MEMORY" ? "Memory" : node.type === "SOURCE" ? "File" : "Topic"}</span><strong>{node.label}</strong><span aria-hidden="true">↗</span></button></li>)}</ul></section>}
      {record && <details className="memory-atlas-source"><summary>Source & provenance</summary><p>{record.sourcePath}</p><p>{record.provenance}</p><p>{record.lifecycleStatus.toLowerCase()}</p></details>}
    </> : <p>Select a point on the map to explore its memory.</p>}
  </aside>;
}
