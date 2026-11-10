import type { AgentPaneTaskRun, AttachmentCoverage } from "@space/contracts";
import { ChatCopyButton } from "./ChatMarkdown.js";
import { api } from "../../api.js";
import { Download } from "../ui-theme/app-icons.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

type Translate = (text: string, vars?: Record<string, string | number>) => string;
const english: Translate = (text, vars) => uiText("en", text, vars);

const statusLabels: Record<AgentPaneTaskRun["status"], string> = {
  QUEUED: "Queued", RUNNING: "Working", COMPLETED: "Completed",
  FAILED: "Failed", INTERRUPTED: "Stopped"
};

/** Measured tokens are what the runtime reported for this task; anything else stays unknown. */
export function usageText(usage: NonNullable<AgentPaneTaskRun["ledger"]>["usage"], t: Translate = english): string {
  if (usage.status !== "MEASURED") return t("Unknown; {reason}", { reason: usage.reason });
  const n = (value: number) => value.toLocaleString("en-US");
  return t("{total} tokens (input {input}, of which cached {cached}; output {output}, of which reasoning {reasoning}){model}, reported by the runtime", {
    total: n(usage.totalTokens), input: n(usage.inputTokens), cached: n(usage.cachedInputTokens), output: n(usage.outputTokens),
    reasoning: n(usage.reasoningOutputTokens), model: usage.model ? ` ${t("on {model}", { model: usage.model })}` : "" });
}
/** Stage 7: Auto runs in shadow mode — what it would have chosen is shown, never applied. */
export function autoRouteText(route: NonNullable<NonNullable<AgentPaneTaskRun["execution"]>["autoRoute"]>, t: Translate = english): string {
  const choice = route.choice ? `${route.choice.model}${route.choice.reasoning ? ` · ${route.choice.reasoning}` : ""}` : t("no selectable model fits");
  const agreement = route.agreesWithActual === null ? "" : route.agreesWithActual ? ` · ${t("same as what ran")}` : ` · ${t("differs from what ran")}`;
  return `${t("Would choose {choice} ({tier} task; {policy}; not applied)", { choice, tier: route.tier.toLowerCase(), policy: route.policyVersion })}${agreement}`;
}
const coverageLabels: Record<AttachmentCoverage["status"], string> = { FULL: "Read fully", PARTIAL: "Partly read", UNAVAILABLE: "Not readable" };
/** What the task could actually read of a file; absent for files submitted before readers existed. */
export function coverageText(coverage: AttachmentCoverage | undefined, t: Translate = english): string | null {
  if (!coverage) return null;
  const unit = coverage.method === "video-frames" ? "{count} frames" : coverage.method === "pptx-text" ? "{count} slides"
    : coverage.method === "xlsx-cells" ? "{count} sheets" : "{count} pages";
  const amount = [coverage.pages !== null ? t(unit, { count: coverage.pages }) : null,
    coverage.chars ? t("{count} characters", { count: coverage.chars.toLocaleString("en-US") }) : null].filter(Boolean).join(", ");
  return `${t(coverageLabels[coverage.status])}${amount ? ` (${amount})` : ""}${coverage.reason ? `. ${coverage.reason}` : ""}`;
}

function Timestamp({ value }: { value: string | null }) {
  const language = useUiLanguage();
  return value ? <time dateTime={value}>{new Date(value).toLocaleString()}</time> : <>{uiText(language, "Not recorded")}</>;
}

function costText(cost: NonNullable<AgentPaneTaskRun["ledger"]>["cost"] | undefined, t: Translate): string {
  return !cost || cost.status === "UNKNOWN" ? t("Unknown") : `${cost.status === "ESTIMATED" ? `${t("Estimated")} ` : ""}$${cost.amountUsd.toFixed(6)}`;
}
function evaluationLabelText(evaluation: NonNullable<AgentPaneTaskRun["ledger"]>["evaluation"] | undefined, t: Translate): string {
  return !evaluation ? t("Not evaluated") : evaluation.status === "PENDING" ? t("Pending")
    : evaluation.status === "UNSCORABLE" ? t("Unscorable")
      : `${evaluation.validation ? `${t("Checks")}: ` : ""}${Number(evaluation.qualityScore.toFixed(2))}/100${evaluation.criticalFailure ? ` · ${t("Critical failure")}` : ""}`;
}

export function TaskDetails({ run }: { run: AgentPaneTaskRun }) {
  const language = useUiLanguage();
  const t: Translate = (text, vars) => uiText(language, text, vars);
  const attachments = run.execution?.attachments;
  const ledger = run.ledger;
  const cost = ledger?.cost;
  const evaluation = ledger?.evaluation;
  // The copied receipt is a technical record and stays in English; the panel is translated.
  const costLabel = costText(cost, english);
  const evaluationLabel = evaluationLabelText(evaluation, english);
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
    <summary><span>{t("Task details")}</span><span className={`chat-task-status is-${run.status.toLowerCase()}`}>{t(statusLabels[run.status])}</span></summary>
    <div className="chat-task-details-body">
      <p>{t("Latest task in this conversation. Completion records execution; it does not certify answer quality.")}</p>
      <dl>
        <div><dt>{t("Provider")}</dt><dd>{run.execution?.providerName ?? t("Not recorded")}</dd></div>
        <div><dt>{t("Requested model")}</dt><dd>{run.execution?.requestedModel ?? t("Unknown")}</dd></div>
        <div><dt>{t("Runtime model at start")}</dt><dd>{run.runtimeModelAtStart ?? t("Not reported")}</dd></div>
        <div><dt>{t("Requested reasoning")}</dt><dd>{run.execution?.requestedReasoning ?? t("Not recorded")}</dd></div>
        <div><dt>{t("Submitted")}</dt><dd><Timestamp value={run.createdAt} /></dd></div>
        <div><dt>{t("Started")}</dt><dd><Timestamp value={run.startedAt} /></dd></div>
        <div><dt>{t("Finished")}</dt><dd><Timestamp value={run.completedAt} /></dd></div>
        <div><dt>{t("Execution time")}</dt><dd>{duration === null ? t("Not available yet") : `${duration}s`}</dd></div>
        <div><dt>{t("Cost")}</dt><dd>{costText(cost, t)}</dd></div>
        <div><dt>{t("Quality evaluation")}</dt><dd>{evaluationLabelText(evaluation, t)}</dd></div>
      </dl>
      <p className="chat-task-evidence-note">{t("The runtime model is reported at startup; later routing changes may not be reported.")}</p>
      {run.execution?.autoRoute && <p className="chat-task-evidence-note" title={run.execution.autoRoute.reasons.join(" ")}>
        {t("Auto (shadow): {text}", { text: autoRouteText(run.execution.autoRoute, t) })}
      </p>}
      {ledger && <section aria-label={t("Measurement evidence")}>
        <p>{t("Usage: {text}", { text: usageText(ledger.usage, t) })}</p>
        <p>{t("Cost: {text}", { text: cost?.status === "UNKNOWN" ? cost.reason : t("{source} · {observed} · Pricing: {pricing}", { source: String(cost?.source), observed: String(cost?.observedAt),
          pricing: cost?.priceCatalogVersion ?? t("Not applicable") }) })}</p>
        <p>{t("Evaluation: {text}", { text: evaluation?.status === "SCORED"
          ? t("{evaluator} · Rubric: {rubric} · Assessed: {assessed}", { evaluator: evaluation.evaluator, rubric: evaluation.rubricVersion, assessed: evaluation.assessedAt })
          : evaluation?.reason ?? "" })}</p>
        {ledger.model.observedAt && <p>{t("Model reported:")} <Timestamp value={ledger.model.observedAt} /></p>}
        {evaluation?.status === "SCORED" && evaluation.validation && <section aria-label={t("Result checks")}>
          <p>{t("Only the declared checks were assessed. Other aspects of the answer have not been evaluated.")}</p>
          {evaluation.criticalFailure && <p role="status">{t("A required check failed. Review the result before using it.")}</p>}
          <ul>{evaluation.validation.checks.map(check => <li key={check.id}>
            {check.id}: {check.passed ? t("Passed") : t("Failed")}{check.critical ? ` · ${t("Required")}` : ""}
          </li>)}</ul>
          <p>{t("Result SHA-256: {hash}", { hash: evaluation.validation.resultSha256 })}</p>
        </section>}
        {!ledger.recordedAt && <p>{t("No measurement ledger was recorded for this historical task.")}</p>}
      </section>}
      <section className="chat-task-attachments" aria-label={t("Submitted files")}>
        <h3>{t("Submitted files")}{attachments?.length ? ` · ${attachments.length}` : ""}</h3>
        {attachments?.length ? <>
          <ul>{attachments.map(file => <li key={file.artifactId}>
            <a href={api.artifactFileUrl(file.artifactId)} download={file.name} aria-label={t("Download {name}", { name: file.name })}>
              <Download aria-hidden="true" />
              <span><strong>{file.name}</strong><small>{file.mimeType} · {t("{count} bytes", { count: file.byteSize.toLocaleString("en-US") })}</small></span>
            </a>
            {file.coverage ? <small className="chat-task-coverage" data-coverage={file.coverage.status.toLowerCase()}>{coverageText(file.coverage, t)}</small> : null}
          </li>)}</ul>
          <p>{attachments.some(file => file.coverage)
            ? t("Coverage records how much of each file the task could read. It does not confirm that the answer used the file correctly.")
            : t("Files included with this request. This does not confirm that their contents were read or checked.")}</p>
        </> : <p>{attachments === undefined ? t("Not recorded for this task.") : t("No files submitted.")}</p>}
      </section>
      <dl className="chat-task-identifiers">
        <div><dt>{t("Task ID")}</dt><dd>{run.runId}</dd></div>
        <div><dt>{t("Trace ID")}</dt><dd>{run.execution?.traceId ?? t("Not recorded")}</dd></div>
        <div><dt>{t("Thread ID")}</dt><dd>{run.threadId ?? t("Not assigned")}</dd></div>
        <div><dt>{t("Turn ID")}</dt><dd>{run.turnId ?? t("Not assigned")}</dd></div>
      </dl>
      <ChatCopyButton text={receipt} label={t("Copy task details")} />
    </div>
  </details>;
}
