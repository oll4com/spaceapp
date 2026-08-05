import { useEffect, useRef, useState, type FormEvent } from "react";
import { Archive, GitMerge, Pencil, TriangleAlert, X } from "../ui-theme/app-icons.js";
import type {
  CreateMemoryNodeChangeSetInput,
  MemoryChangeKind,
  MemoryGraphNodeDetail
} from "@space/contracts";
import { api } from "../../api.js";
import { DEMO_LOCAL_REPLY, getSpaceRuntimeKind } from "../../runtime/SpaceRuntime.js";

type ProposalKind = Extract<MemoryChangeKind, "EDIT" | "ARCHIVE" | "MERGE">;

function readableType(value: string): string {
  return value.toLocaleLowerCase().replaceAll("_", " ");
}

function idempotencyKey(kind: ProposalKind): string {
  return `memory-node:${kind.toLocaleLowerCase()}:${crypto.randomUUID()}`;
}

function confidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}% confidence`;
}

function MemoryTaxonomy({ record }: { record: NonNullable<MemoryGraphNodeDetail["record"]> }) {
  const tags = record.tags ?? [];
  const derivedTopics = (record.topics ?? []).filter((topic) => topic.origin === "DERIVED_TFIDF");
  return (
    <div className="memory-taxonomy">
      <section className="memory-detail-section" aria-labelledby="memory-explicit-tags-heading">
        <h4 id="memory-explicit-tags-heading">Explicit tags</h4>
        {tags.length > 0 ? (
          <ul className="memory-tag-list">{tags.map((tag) => <li key={tag}>{tag}</li>)}</ul>
        ) : <p>No explicit tags are attached to this memory block.</p>}
      </section>
      <section className="memory-detail-section" aria-labelledby="memory-derived-topics-heading">
        <h4 id="memory-derived-topics-heading">Derived topics</h4>
        {derivedTopics.length > 0 ? (
          <ul className="memory-topic-list">{derivedTopics.map((topic) => (
            <li key={topic.label}>
              <strong>{topic.label}</strong>
              <small>{confidenceLabel(topic.confidence)}</small>
            </li>
          ))}</ul>
        ) : <p>No derived topics were found for this memory block.</p>}
      </section>
    </div>
  );
}

function MemoryRelationships({ detail }: { detail: MemoryGraphNodeDetail }) {
  const relatedEdges = detail.relatedEdges ?? [];
  const nodesById = new Map(detail.relatedNodes.map((node) => [node.id, node]));
  return (
    <section className="memory-detail-section" aria-labelledby="memory-related-heading">
      <h4 id="memory-related-heading">Relationships</h4>
      {relatedEdges.length > 0 ? (
        <ul className="memory-relationship-list">{relatedEdges.map((edge) => {
          const relatedId = edge.source === detail.node.id ? edge.target : edge.source;
          const relatedNode = nodesById.get(relatedId);
          return (
            <li key={edge.id} data-edge-type={edge.type}>
              <div className="memory-relationship-meta">
                <span>{readableType(edge.type)}</span>
                {edge.origin ? <span>{readableType(edge.origin)}</span> : null}
                {edge.confidence === undefined ? null : <span>{confidenceLabel(edge.confidence)}</span>}
              </div>
              <strong>{relatedNode?.label ?? relatedId}</strong>
              {edge.evidence ? <small>{edge.evidence}</small> : null}
            </li>
          );
        })}</ul>
      ) : detail.relatedNodes.length > 0 ? (
        <ul>{detail.relatedNodes.map((node) => <li key={node.id}><span>{readableType(node.type)}</span>{node.label}</li>)}</ul>
      ) : <p>No related nodes.</p>}
    </section>
  );
}

function MemoryIssues({ detail }: { detail: MemoryGraphNodeDetail }) {
  return (
    <section className="memory-detail-section" aria-labelledby="memory-node-issues-heading">
      <h4 id="memory-node-issues-heading">Issues</h4>
      {detail.issues.length > 0 ? (
        <ul>{detail.issues.map((issue) => <li key={issue.id} data-severity={issue.severity}><span>{readableType(issue.type)}</span>{issue.evidence}</li>)}</ul>
      ) : <p>No issues are attached to this memory block.</p>}
    </section>
  );
}

export function MemoryNodeDetail({
  detail,
  loading,
  onClose,
  onOpenChanges
}: {
  detail: MemoryGraphNodeDetail | null;
  loading: boolean;
  onClose: () => void;
  onOpenChanges: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [proposalKind, setProposalKind] = useState<ProposalKind | null>(null);
  const [reason, setReason] = useState("");
  const [editedBody, setEditedBody] = useState("");
  const [targetRecordId, setTargetRecordId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!detail) return;
    setProposalKind(null);
    setReason("");
    setEditedBody(detail.record?.body ?? "");
    setTargetRecordId("");
    setError(null);
    setSuccess(null);
    panelRef.current?.focus();
  }, [detail?.node.id]);

  const record = detail?.record ?? null;
  const mergeTargets = detail?.relatedNodes.filter((node) =>
    node.type === "MEMORY" &&
    node.recordId &&
    node.recordId !== record?.id &&
    node.sourcePath === record?.sourcePath
  ) ?? [];

  function openProposal(kind: ProposalKind) {
    setProposalKind(kind);
    setReason("");
    setEditedBody(record?.body ?? "");
    setTargetRecordId("");
    setError(null);
    setSuccess(null);
  }

  async function submitProposal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || !record || !proposalKind || submitting) return;

    let input: CreateMemoryNodeChangeSetInput;
    if (proposalKind === "EDIT") {
      input = { kind: proposalKind, expectedContentHash: record.contentHash, body: editedBody, reason };
    } else if (proposalKind === "MERGE") {
      if (!targetRecordId) return;
      input = { kind: proposalKind, expectedContentHash: record.contentHash, targetRecordId, reason };
    } else {
      input = { kind: proposalKind, expectedContentHash: record.contentHash, reason };
    }

    if (!window.confirm(`Create this ${proposalKind.toLocaleLowerCase()} proposal for operator review?`)) return;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await api.createMemoryNodeChangeSet(detail.node.id, input, idempotencyKey(proposalKind));
      setSuccess(getSpaceRuntimeKind() === "demo"
        ? DEMO_LOCAL_REPLY
        : `${created.kind} proposal created in Changes: ${created.id}`);
      setProposalKind(null);
      setReason("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The memory proposal could not be created.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <aside ref={panelRef} className="memory-node-detail" aria-label="Memory node detail" tabIndex={-1}>
      <button
        type="button"
        className="memory-node-detail-close"
        aria-label="Close memory node detail"
        title="Close memory node detail"
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </button>
      {loading ? <p role="status">Loading node detail…</p> : detail ? (
        <>
          <span>{readableType(detail.node.type)}</span>
          <h3>{detail.node.label}</h3>
          {record ? (
            <>
              <dl className="memory-detail-facts">
                <div><dt>Scope</dt><dd>{record.scope}</dd></div>
                <div><dt>Lifecycle</dt><dd>{record.lifecycleStatus}</dd></div>
                <div><dt>Provenance</dt><dd>{record.provenance}</dd></div>
                <div><dt>Timestamp</dt><dd><time dateTime={record.createdAt}>{record.createdAt}</time></dd></div>
                <div><dt>Source</dt><dd>{record.sourcePath}</dd></div>
              </dl>
              <pre>{record.body}</pre>
              <MemoryTaxonomy record={record} />
            </>
          ) : <p>This structural node has no canonical memory block body or mutation actions.</p>}

          <MemoryRelationships detail={detail} />
          <MemoryIssues detail={detail} />

          {record ? (
            <>
              <section className="memory-node-actions" aria-labelledby="memory-node-actions-heading">
                <h4 id="memory-node-actions-heading">Guarded proposals</h4>
                <p>These actions create reviewable change sets. Canonical files are not changed here.</p>
                <div>
                  <button type="button" onClick={() => openProposal("EDIT")}><Pencil aria-hidden="true" />Edit memory proposal</button>
                  <button type="button" disabled={record.lifecycleStatus !== "ACTIVE"} onClick={() => openProposal("ARCHIVE")}><Archive aria-hidden="true" />Archive memory proposal</button>
                  <button type="button" disabled={record.lifecycleStatus !== "ACTIVE" || mergeTargets.length === 0} onClick={() => openProposal("MERGE")}><GitMerge aria-hidden="true" />Merge memory proposal</button>
                </div>
              </section>

              {proposalKind ? (
                <form className="memory-node-proposal" onSubmit={submitProposal}>
                  <h4>{readableType(proposalKind)} proposal</h4>
                  {proposalKind === "EDIT" ? (
                    <label>
                      Edited canonical block
                      <textarea aria-label="Edited canonical block" name="memoryEditedBody" required maxLength={100_000} value={editedBody} onChange={(event) => setEditedBody(event.currentTarget.value)} />
                    </label>
                  ) : null}
                  {proposalKind === "MERGE" ? (
                    <label>
                      Merge target
                      <select aria-label="Merge target" name="memoryMergeTargetRecordId" required value={targetRecordId} onChange={(event) => setTargetRecordId(event.currentTarget.value)}>
                        <option value="">Select a related memory block</option>
                        {mergeTargets.map((node) => <option key={node.id} value={node.recordId ?? ""}>{node.label}</option>)}
                      </select>
                    </label>
                  ) : null}
                  <label>
                    {proposalKind === "ARCHIVE" ? "Archive proposal reason" : proposalKind === "MERGE" ? "Merge proposal reason" : "Edit proposal reason"}
                    <textarea
                      aria-label={proposalKind === "ARCHIVE" ? "Archive proposal reason" : proposalKind === "MERGE" ? "Merge proposal reason" : "Edit proposal reason"}
                      name="memoryProposalReason"
                      required
                      maxLength={2000}
                      value={reason}
                      onChange={(event) => setReason(event.currentTarget.value)}
                    />
                  </label>
                  <div>
                    <button type="submit" disabled={submitting}>{submitting ? "Creating proposal…" : `Create ${proposalKind.toLocaleLowerCase()} proposal`}</button>
                    <button type="button" disabled={submitting} onClick={() => setProposalKind(null)}>Cancel</button>
                  </div>
                </form>
              ) : null}

              {error ? <p className="memory-node-action-message is-error" role="alert"><TriangleAlert aria-hidden="true" />{error}</p> : null}
              {success ? <div className="memory-node-action-message is-success" role="status"><span>{success}</span><button type="button" onClick={onOpenChanges}>Open Changes</button></div> : null}
            </>
          ) : null}
        </>
      ) : <p>Select a node to inspect its canonical block and relationships.</p>}
    </aside>
  );
}
