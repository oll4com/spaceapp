import { transitionAgentRunLedger } from "@space/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentPaneTaskRun } from "@space/contracts";
import { TaskDetails } from "../src/features/agent-pane/TaskDetails.js";
import { CodexTranscript } from "../src/features/agent-pane/CodexTranscript.js";
import { writeClipboardText } from "../src/features/clipboard-dock/clipboard-events.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { SpaceRuntimeProvider } from "../src/runtime/SpaceRuntime.js";
vi.mock("../src/features/clipboard-dock/clipboard-events.js", () => ({ writeClipboardText: vi.fn() }));

const run: AgentPaneTaskRun = {
  runId: "agent_run:receipt", status: "COMPLETED", createdAt: "2026-09-26T01:00:00Z",
  startedAt: "2026-09-26T01:00:02Z", completedAt: "2026-09-26T01:00:12Z",
  execution: { traceId: "trace:receipt", providerId: null, providerName: "Codex",
    modelConfigId: "codex-v1|requested|high", requestedModel: "requested", requestedReasoning: "high" },
  runtimeModelAtStart: "reported", threadId: "thread:receipt", turnId: "turn:receipt",
  costStatus: "UNKNOWN", evaluationStatus: "NOT_EVALUATED"
};

describe("Chat task details", () => {
  it("shows failed required checks without claiming the whole answer is verified", () => {
    const ledger = transitionAgentRunLedger({ status: "COMPLETED", at: run.completedAt, evaluation: {
      status: "SCORED", reason: null, assessedAt: run.completedAt!, evaluator: "space:objective-validator",
      rubricVersion: "declared-checks-v1", qualityScore: 0, criticalFailure: true, evidenceIds: [run.runId],
      validation: { scope: "DECLARED_CHECKS_ONLY", resultSha256: "b".repeat(64),
        checks: [{ id: "answer", kind: "TEXT_EQUALS", passed: false, critical: true }] } } });
    const { container } = render(<TaskDetails run={{ ...run, ledger }} />);
    expect(screen.getByText("Checks: 0/100 · Critical failure")).toBeTruthy();
    expect(screen.getByText("A required check failed. Review the result before using it.")).toBeTruthy();
    expect(screen.getByText("Only the declared checks were assessed. Other aspects of the answer have not been evaluated.")).toBeTruthy();
    expect(container.textContent).not.toContain("Verified");
  });
  it("renders safe downloadable submitted-file receipts and includes them in copied details", async () => {
    const name = '<img src=x onerror=alert(1)>.pdf';
    const artifactId = 'artifact:receipt/unsafe?part=#one';
    const receiptRun = { ...run, execution: { ...run.execution!, attachments: [{ artifactId, name,
      mimeType: "application/pdf", byteSize: 1234, sha256: "a".repeat(64) }] } };
    const { container } = render(<SpaceRuntimeProvider runtime={liveRuntime}><TaskDetails run={receiptRun} /></SpaceRuntimeProvider>);
    const link = screen.getByRole("link", { name: `Download ${name}`, hidden: true });
    expect(link.getAttribute("href")).toBe(`/api/artifacts/${encodeURIComponent(artifactId)}/file`);
    expect(link.getAttribute("download")).toBe(name);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("application/pdf · 1,234 bytes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy task details", hidden: true }));
    await waitFor(() => expect(vi.mocked(writeClipboardText).mock.calls.at(-1)?.[0]).toContain("Submitted files: 1"));
    expect(vi.mocked(writeClipboardText).mock.calls.at(-1)?.[0]).toContain(artifactId);
  });
  it("shows how much of each file was read and copies it with the receipt", async () => {
    const files = [
      { artifactId: "artifact:pdf", name: "quote.pdf", mimeType: "application/pdf", byteSize: 2048, sha256: "a".repeat(64),
        coverage: { status: "PARTIAL" as const, method: "pdf-text", chars: 1200, pages: 3, truncated: false, reason: "1 of 3 pages have no text layer." } },
      { artifactId: "artifact:mp3", name: "call.mp3", mimeType: "audio/mpeg", byteSize: 4096, sha256: "b".repeat(64),
        coverage: { status: "UNAVAILABLE" as const, method: "audio", chars: null, pages: null, truncated: false, reason: "No transcription service for files is configured." } }
    ];
    render(<SpaceRuntimeProvider runtime={liveRuntime}><TaskDetails run={{ ...run, execution: { ...run.execution!, attachments: files } }} /></SpaceRuntimeProvider>);
    expect(screen.getByText("Partly read (3 pages, 1,200 characters). 1 of 3 pages have no text layer.")).toBeTruthy();
    expect(screen.getByText("Not readable. No transcription service for files is configured.")).toBeTruthy();
    expect(screen.getByText(/Coverage records how much of each file the task could read/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy task details", hidden: true }));
    await waitFor(() => expect(vi.mocked(writeClipboardText).mock.calls.at(-1)?.[0]).toContain("Partly read (3 pages, 1,200 characters)"));
  });
  it("distinguishes older unknown attachment records from an explicitly empty submission", () => {
    const { rerender } = render(<TaskDetails run={run} />);
    expect(screen.getByText("Not recorded for this task.")).toBeTruthy();
    rerender(<TaskDetails run={{ ...run, execution: { ...run.execution!, attachments: [] } }} />);
    expect(screen.getByText("No files submitted.")).toBeTruthy();
    expect(screen.queryByText("Not recorded for this task.")).toBeNull();
  });
  it("shows measured tokens and an estimated cost with the price version, not a guess", () => {
    const at = run.completedAt!;
    const ledger = transitionAgentRunLedger({ status: "COMPLETED", at,
      usage: { status: "MEASURED", inputTokens: 12_000, cachedInputTokens: 10_000, outputTokens: 1_000, reasoningOutputTokens: 400,
        totalTokens: 13_000, source: "codex-app-server:thread/tokenUsage/updated", observedAt: at, model: "gpt-test" },
      cost: { status: "ESTIMATED", reason: null, amountUsd: 0.017, source: "tokens × prices-2026-10", observedAt: at, priceCatalogVersion: "prices-2026-10" } });
    render(<TaskDetails run={{ ...run, ledger }} />);
    expect(screen.getByText(/^Usage: 13,000 tokens \(input 12,000, of which cached 10,000; output 1,000, of which reasoning 400\) on gpt-test, reported by the runtime$/)).toBeTruthy();
    expect(screen.getByText(/Pricing: prices-2026-10/)).toBeTruthy();
    expect(screen.getByText("Estimated $0.017000")).toBeTruthy();
  });
  it("shows what Auto would have chosen as a shadow decision that was not applied", () => {
    const autoRoute = { policyVersion: "auto-route-v1", mode: "SHADOW" as const, decidedAt: run.createdAt, tier: "LIGHT" as const, estimatedInputTokens: 6_010,
      choice: { model: "small", reasoning: "low" }, reasons: ["A short request with no files.", "The cheapest priced model that fits (prices-test)."], excluded: [],
      actual: { model: "requested", reasoning: "high", source: "USER_SELECTED" as const }, agreesWithActual: false };
    render(<TaskDetails run={{ ...run, execution: { ...run.execution!, autoRoute } }} />);
    const note = screen.getByText(/^Auto \(shadow\): Would choose small · low \(light task; auto-route-v1; not applied\) · differs from what ran$/);
    expect(note.getAttribute("title")).toBe("A short request with no files. The cheapest priced model that fits (prices-test).");
  });
  it("keeps details collapsed and distinguishes saved choices, runtime evidence and unknown measurements", () => {
    const { container } = render(<TaskDetails run={run} />);
    expect(container.querySelector("details")?.open).toBe(false);
    expect(screen.getByText("requested")).toBeTruthy();
    expect(screen.getByText("reported")).toBeTruthy();
    expect(screen.getByText("10s")).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(screen.getByText("Not evaluated")).toBeTruthy();
    expect(container.textContent).not.toMatch(/\$0|100%|Verified/);
  });
  it("copies an identifiable receipt from saved facts", async () => {
    render(<TaskDetails run={run} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy task details", hidden: true }));
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith(expect.stringContaining("Task: agent_run:receipt")));
    const text = vi.mocked(writeClipboardText).mock.calls.at(-1)![0];
    expect(text).toContain("Provider: Codex");
    expect(text).toContain("Execution time: 10s");
    expect(text).toContain("Requested model: requested");
    expect(text).toContain("Runtime model at start: reported");
    expect(text).toContain("Cost: Unknown");
    expect(text).toContain("Trace: trace:receipt");
  });
  it("does not invent model or start-time evidence for legacy and queued records", () => {
    const { container, rerender } = render(<TaskDetails run={{ ...run, status: "QUEUED", execution: null,
      runtimeModelAtStart: null, startedAt: null, completedAt: null }} />);
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.getByText("Not reported")).toBeTruthy();
    expect(screen.getByText("Not available yet")).toBeTruthy();
    expect(container.textContent).not.toContain("requested");
    rerender(<TaskDetails run={{ ...run, status: "INTERRUPTED" }} />);
    expect(screen.getByText("Stopped")).toBeTruthy();
  });
  it("supports older sessions without run details and resets expansion for a new run", () => {
    const props = { items: [], messages: [], isRunning: false, loading: false, elapsedSeconds: 0, providerName: "Codex" };
    const { container, rerender } = render(<CodexTranscript {...props} />);
    expect(container.querySelector("details")).toBeNull();
    rerender(<CodexTranscript {...props} latestRun={run} />);
    container.querySelector("details")!.open = true;
    rerender(<CodexTranscript {...props} latestRun={{ ...run, runId: "agent_run:next" }} />);
    expect(container.querySelector("details")?.open).toBe(false);
  });
});


it("shows and copies explicit measurement reasons without fabricating zero cost or verification", async () => {
  const ledger = transitionAgentRunLedger({ status: "COMPLETED", at: run.completedAt, runtimeModelAtStart: "reported" });
  const { container } = render(<TaskDetails run={{ ...run, ledger }} />);
  expect(screen.getByText("Unscorable")).toBeTruthy();
  expect(screen.getByText(/No complete task billing receipt/)).toBeTruthy();
  expect(screen.getByText(/No task-specific quality validator/)).toBeTruthy();
  expect(container.textContent).not.toMatch(/\$0|Verified|100%/);
  fireEvent.click(screen.getByRole("button", { name: "Copy task details", hidden: true }));
  await waitFor(() => expect(vi.mocked(writeClipboardText).mock.calls.at(-1)?.[0]).toContain("Quality evaluation: Unscorable"));
  expect(vi.mocked(writeClipboardText).mock.calls.at(-1)?.[0]).toContain("scope: STARTUP_ONLY");
});
