import type { AgentPaneTaskRun } from "@space/contracts";
import { ChatCopyButton } from "./ChatMarkdown.js";
import { api } from "../../api.js";
import { Download } from "../ui-theme/app-icons.js";

const statusLabels: Record<AgentPaneTaskRun["status"], string> = {
  QUEUED: "Queued", RUNNING: "Working", COMPLETED: "Completed",
  FAILED: "Failed", INTERRUPTED: "Stopped"
};

function Timestamp({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{new Date(value).toLocaleString()}</time> : <>Not recorded</>;
}

export function TaskDetails({ run }: { run: AgentPaneTaskRun }) {
  const attachments = run.execution?.attachments;
  const duration = run.startedAt && run.completedAt
    ? Math.max(0, Math.round((Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000)) : null;
  const receipt = [
    `Task: ${run.runId}`, `Status: ${statusLabels[run.status]}`,
    `Provider: ${run.execution?.providerName ?? "Not recorded"}`,
    `Requested model: ${run.execution?.requestedModel ?? "Unknown"}`,
    `Runtime model at start: ${run.runtimeModelAtStart ?? "Not reported"}`,
    `Requested reasoning: ${run.execution?.requestedReasoning ?? "Not recorded"}`,
    `Submitted: ${run.createdAt}`, `Started: ${run.startedAt ?? "Not recorded"}`,
    `Finished: ${run.completedAt ?? "Not recorded"}`,
    `Execution time: ${duration === null ? "Not available yet" : `${duration}s`}`,
    `Trace: ${run.execution?.traceId ?? "Not recorded"}`,
    `Thread: ${run.threadId ?? "Not assigned"}`, `Turn: ${run.turnId ?? "Not assigned"}`,
    "Cost: Unknown", "Quality evaluation: Not evaluated",
    `Submitted files: ${attachments === undefined ? "Not recorded" : attachments.length}`,
    ...(attachments ?? []).map(file => `File: ${JSON.stringify(file.name)}; ${file.mimeType}; ${file.byteSize} bytes; ${file.artifactId}; SHA-256: ${file.sha256}`)
  ].join("\n");
  return <details className="chat-task-details" data-task-run-id={run.runId}>
    <summary><span>Task details</span><span className={`chat-task-status is-${run.status.toLowerCase()}`}>{statusLabels[run.status]}</span></summary>
    <div className="chat-task-details-body">
      <p>Latest task in this conversation. Completion records execution; it does not certify answer quality.</p>
      <dl>
        <div><dt>Provider</dt><dd>{run.execution?.providerName ?? "Not recorded"}</dd></div>
        <div><dt>Requested model</dt><dd>{run.execution?.requestedModel ?? "Unknown"}</dd></div>
        <div><dt>Runtime model at start</dt><dd>{run.runtimeModelAtStart ?? "Not reported"}</dd></div>
        <div><dt>Requested reasoning</dt><dd>{run.execution?.requestedReasoning ?? "Not recorded"}</dd></div>
        <div><dt>Submitted</dt><dd><Timestamp value={run.createdAt} /></dd></div>
        <div><dt>Started</dt><dd><Timestamp value={run.startedAt} /></dd></div>
        <div><dt>Finished</dt><dd><Timestamp value={run.completedAt} /></dd></div>
        <div><dt>Execution time</dt><dd>{duration === null ? "Not available yet" : `${duration}s`}</dd></div>
        <div><dt>Cost</dt><dd>Unknown</dd></div>
        <div><dt>Quality evaluation</dt><dd>Not evaluated</dd></div>
      </dl>
      <p className="chat-task-evidence-note">The runtime model is reported at startup; later routing changes may not be reported. Cost and quality measurements are not available for this task.</p>
      <section className="chat-task-attachments" aria-label="Submitted files">
        <h3>Submitted files{attachments?.length ? ` · ${attachments.length}` : ""}</h3>
        {attachments?.length ? <>
          <ul>{attachments.map(file => <li key={file.artifactId}>
            <a href={api.artifactFileUrl(file.artifactId)} download={file.name} aria-label={`Download ${file.name}`}>
              <Download aria-hidden="true" />
              <span><strong>{file.name}</strong><small>{file.mimeType} · {file.byteSize.toLocaleString("en-US")} bytes</small></span>
            </a>
          </li>)}</ul>
          <p>Files included with this request. This does not confirm that their contents were read or checked.</p>
        </> : <p>{attachments === undefined ? "Not recorded for this task." : "No files submitted."}</p>}
      </section>
      <dl className="chat-task-identifiers">
        <div><dt>Task ID</dt><dd>{run.runId}</dd></div>
        <div><dt>Trace ID</dt><dd>{run.execution?.traceId ?? "Not recorded"}</dd></div>
        <div><dt>Thread ID</dt><dd>{run.threadId ?? "Not assigned"}</dd></div>
        <div><dt>Turn ID</dt><dd>{run.turnId ?? "Not assigned"}</dd></div>
      </dl>
      <ChatCopyButton text={receipt} label="Copy task details" />
    </div>
  </details>;
}
