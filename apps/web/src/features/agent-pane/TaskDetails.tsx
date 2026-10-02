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
  const ledger = run.ledger;
  const cost = ledger?.cost;
  const evaluation = ledger?.evaluation;
  const costLabel = !cost || cost.status === "UNKNOWN" ? "Unknown"
    : `${cost.status === "ESTIMATED" ? "Estimated " : ""}$${cost.amountUsd.toFixed(6)}`;
  const evaluationLabel = !evaluation ? "Not evaluated" : evaluation.status === "PENDING" ? "Pending"
    : evaluation.status === "UNSCORABLE" ? "Unscorable"
      : `${evaluation.validation ? "Checks: " : ""}${Number(evaluation.qualityScore.toFixed(2))}/100${evaluation.criticalFailure ? " · Critical failure" : ""}`;
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
    `Cost: ${costLabel}`, `Quality evaluation: ${evaluationLabel}`,
    ...(ledger ? [
      `Ledger recorded: ${ledger.recordedAt ?? "Historical record; no ledger was recorded"}`,
      `Model evidence: ${ledger.model.source}; scope: ${ledger.model.scope}; observed: ${ledger.model.observedAt ?? "Not recorded"}`,
      `Usage: Unknown; ${ledger.usage.reason}`,
      `Cost evidence: ${cost?.status === "UNKNOWN" ? cost.reason : `${cost?.source}; ${cost?.observedAt}; pricing: ${cost?.priceCatalogVersion ?? "Not applicable"}`}`,
      `Evaluation evidence: ${evaluation?.status === "SCORED" ? `${evaluation.evaluator}; rubric: ${evaluation.rubricVersion}; evidence: ${evaluation.evidenceIds.join(", ")}` : evaluation?.reason}`,
      ...(evaluation?.status === "SCORED" && evaluation.validation ? [
        "Evaluation scope: Declared checks only",
        `Result SHA-256: ${evaluation.validation.resultSha256}`,
        ...evaluation.validation.checks.map(check => `Check ${check.id}: ${check.passed ? "Passed" : "Failed"}${check.critical ? " (critical)" : ""}`)
      ] : [])
    ] : []),
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
        <div><dt>Cost</dt><dd>{costLabel}</dd></div>
        <div><dt>Quality evaluation</dt><dd>{evaluationLabel}</dd></div>
      </dl>
      <p className="chat-task-evidence-note">The runtime model is reported at startup; later routing changes may not be reported.</p>
      {ledger && <section aria-label="Measurement evidence">
        <p>Usage: {ledger.usage.reason}</p>
        <p>Cost: {cost?.status === "UNKNOWN" ? cost.reason : `${cost?.source} · ${cost?.observedAt} · Pricing: ${cost?.priceCatalogVersion ?? "Not applicable"}`}</p>
        <p>Evaluation: {evaluation?.status === "SCORED"
          ? `${evaluation.evaluator} · Rubric: ${evaluation.rubricVersion} · Assessed: ${evaluation.assessedAt}`
          : evaluation?.reason}</p>
        {ledger.model.observedAt && <p>Model reported: <Timestamp value={ledger.model.observedAt} /></p>}
        {evaluation?.status === "SCORED" && evaluation.validation && <section aria-label="Result checks">
          <p>Only the declared checks were assessed. Other aspects of the answer have not been evaluated.</p>
          {evaluation.criticalFailure && <p role="status">A required check failed. Review the result before using it.</p>}
          <ul>{evaluation.validation.checks.map(check => <li key={check.id}>
            {check.id}: {check.passed ? "Passed" : "Failed"}{check.critical ? " · Required" : ""}
          </li>)}</ul>
          <p>Result SHA-256: {evaluation.validation.resultSha256}</p>
        </section>}
        {!ledger.recordedAt && <p>No measurement ledger was recorded for this historical task.</p>}
      </section>}
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
