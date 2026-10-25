import type { AgentPaneTaskRun, AttachmentCoverage } from "@space/contracts";
import { ChatCopyButton } from "./ChatMarkdown.js";
import { api } from "../../api.js";
import { Download } from "../ui-theme/app-icons.js";

const statusLabels: Record<AgentPaneTaskRun["status"], string> = {
  QUEUED: "Queued", RUNNING: "Working", COMPLETED: "Completed",
  FAILED: "Failed", INTERRUPTED: "Stopped"
};

/** Measured tokens are what the runtime reported for this task; anything else stays unknown. */
export function usageText(usage: NonNullable<AgentPaneTaskRun["ledger"]>["usage"]): string {
  if (usage.status !== "MEASURED") return `Unknown; ${usage.reason}`;
  const n = (value: number) => value.toLocaleString("en-US");
  return `${n(usage.totalTokens)} tokens (input ${n(usage.inputTokens)}, of which cached ${n(usage.cachedInputTokens)}; output ${n(usage.outputTokens)}, `
    + `of which reasoning ${n(usage.reasoningOutputTokens)})${usage.model ? ` on ${usage.model}` : ""}, reported by the runtime`;
}
/** Stage 7: Auto runs in shadow mode — what it would have chosen is shown, never applied. */
export function autoRouteText(route: NonNullable<NonNullable<AgentPaneTaskRun["execution"]>["autoRoute"]>): string {
  const choice = route.choice ? `${route.choice.model}${route.choice.reasoning ? ` · ${route.choice.reasoning}` : ""}` : "no selectable model fits";
  const agreement = route.agreesWithActual === null ? "" : route.agreesWithActual ? " · same as what ran" : " · differs from what ran";
  return `Would choose ${choice} (${route.tier.toLowerCase()} task; ${route.policyVersion}; not applied)${agreement}`;
}
const coverageLabels: Record<AttachmentCoverage["status"], string> = { FULL: "Read fully", PARTIAL: "Partly read", UNAVAILABLE: "Not readable" };
/** What the task could actually read of a file; absent for files submitted before readers existed. */
export function coverageText(coverage: AttachmentCoverage | undefined): string | null {
  if (!coverage) return null;
  const amount = [coverage.pages !== null ? `${coverage.pages} ${coverage.method === "video-frames" ? "frames" : coverage.method === "pptx-text" ? "slides"
    : coverage.method === "xlsx-cells" ? "sheets" : "pages"}` : null, coverage.chars ? `${coverage.chars.toLocaleString("en-US")} characters` : null].filter(Boolean).join(", ");
  return `${coverageLabels[coverage.status]}${amount ? ` (${amount})` : ""}${coverage.reason ? `. ${coverage.reason}` : ""}`;
}

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
    ...(run.execution?.autoRoute ? [`Auto (shadow): ${autoRouteText(run.execution.autoRoute)}`,
      `Auto reasons: ${run.execution.autoRoute.reasons.join(" ")}`] : []),
    ...(ledger ? [
      `Ledger recorded: ${ledger.recordedAt ?? "Historical record; no ledger was recorded"}`,
      `Model evidence: ${ledger.model.source}; scope: ${ledger.model.scope}; observed: ${ledger.model.observedAt ?? "Not recorded"}`,
      `Usage: ${usageText(ledger.usage)}`,
      `Cost evidence: ${cost?.status === "UNKNOWN" ? cost.reason : `${cost?.source}; ${cost?.observedAt}; pricing: ${cost?.priceCatalogVersion ?? "Not applicable"}`}`,
      `Evaluation evidence: ${evaluation?.status === "SCORED" ? `${evaluation.evaluator}; rubric: ${evaluation.rubricVersion}; evidence: ${evaluation.evidenceIds.join(", ")}` : evaluation?.reason}`,
      ...(evaluation?.status === "SCORED" && evaluation.validation ? [
        "Evaluation scope: Declared checks only",
        `Result SHA-256: ${evaluation.validation.resultSha256}`,
        ...evaluation.validation.checks.map(check => `Check ${check.id}: ${check.passed ? "Passed" : "Failed"}${check.critical ? " (critical)" : ""}`)
      ] : [])
    ] : []),
    `Submitted files: ${attachments === undefined ? "Not recorded" : attachments.length}`,
    ...(attachments ?? []).map(file => `File: ${JSON.stringify(file.name)}; ${file.mimeType}; ${file.byteSize} bytes; ${file.artifactId}; SHA-256: ${file.sha256}${
      file.coverage ? `; ${coverageText(file.coverage)}` : ""}`)
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
      {run.execution?.autoRoute && <p className="chat-task-evidence-note" title={run.execution.autoRoute.reasons.join(" ")}>
        Auto (shadow): {autoRouteText(run.execution.autoRoute)}
      </p>}
      {ledger && <section aria-label="Measurement evidence">
        <p>Usage: {usageText(ledger.usage)}</p>
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
            {file.coverage ? <small className="chat-task-coverage" data-coverage={file.coverage.status.toLowerCase()}>{coverageText(file.coverage)}</small> : null}
          </li>)}</ul>
          <p>{attachments.some(file => file.coverage)
            ? "Coverage records how much of each file the task could read. It does not confirm that the answer used the file correctly."
            : "Files included with this request. This does not confirm that their contents were read or checked."}</p>
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
