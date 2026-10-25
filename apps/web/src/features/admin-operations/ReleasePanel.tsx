import type {
  AdminOperationRun,
  CreateReleasePreviewInput,
  CreateReleaseRequest,
  ReleasePreview
} from "@space/contracts";
import { GitBranch, Loader2, RefreshCw, Rocket, ShieldCheck } from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  activeOperationStatuses,
  errorMessage,
  releaseRequestFromRuns
} from "./admin-operation-utils.js";

export interface ReleaseClient {
  createReleasePreview(input: CreateReleasePreviewInput): Promise<ReleasePreview>;
  publishRelease(input: CreateReleaseRequest): Promise<AdminOperationRun>;
  listReleaseRuns(): Promise<{ data: AdminOperationRun[] }>;
}

interface ReleaseProviderResult {
  provider: string;
  status: string;
  releaseUrl?: string;
}

function isReleaseProviderResult(value: unknown): value is ReleaseProviderResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as ReleaseProviderResult).provider === "string" &&
    typeof (value as ReleaseProviderResult).status === "string"
  );
}

export function ReleasePanel({
  client,
  onBusyChange
}: {
  client: ReleaseClient;
  onBusyChange: (busy: boolean) => void;
}) {
  const [runs, setRuns] = useState<AdminOperationRun[]>([]);
  const [preview, setPreview] = useState<ReleasePreview | null>(null);
  const [notes, setNotes] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [dismissedPartialPreviewId, setDismissedPartialPreviewId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedTag, setStartedTag] = useState<string | null>(null);
  const latest = runs[0];
  const hasActiveRun = runs.some((run) => activeOperationStatuses.has(run.status));
  const partialRetryCandidate = useMemo(
    () => releaseRequestFromRuns(runs),
    [runs]
  );
  const partialRetry = partialRetryCandidate?.previewId === dismissedPartialPreviewId
    ? null
    : partialRetryCandidate;
  const previewSucceeded = Boolean(preview && runs.some(
    (run) => run.status === "SUCCEEDED" && run.result.previewId === preview.id
  ));
  const target = partialRetry ?? (previewSucceeded ? null : preview);
  const showingPreview = Boolean(preview && target === preview);
  const targetPreviewId = partialRetry?.previewId ?? (showingPreview ? preview?.id ?? null : null);
  const exactConfirmation = target ? "PUBLISH" : "";
  const latestTag = typeof latest?.result?.tag === "string" ? latest.result.tag : null;
  const latestSucceeded = latest?.status === "SUCCEEDED" && latestTag !== null;
  const publishedProviders = Array.isArray(latest?.result?.providers)
    ? latest.result.providers.filter(isReleaseProviderResult)
    : [];

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      setRuns((await client.listReleaseRuns()).data);
    } catch (reason) {
      setError(errorMessage(reason, "Release history could not be loaded."));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onBusyChange(pending);
  }, [onBusyChange, pending]);

  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = window.setTimeout(() => void load(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [hasActiveRun, latest?.updatedAt, load]);

  async function preparePreview() {
    if (pending || hasActiveRun) return;
    setPending(true);
    setError(null);
    setConfirmation("");
    setStartedTag(null);
    try {
      const input = notes.trim() ? { notes: notes.trim() } : {};
      setPreview(await client.createReleasePreview(input));
    } catch (reason) {
      setPreview(null);
      setError(errorMessage(reason, "Release preview could not be prepared."));
    } finally {
      setPending(false);
    }
  }

  async function publish() {
    if (!target || !targetPreviewId || pending || hasActiveRun || confirmation !== exactConfirmation) return;
    setPending(true);
    setError(null);
    try {
      const run = await client.publishRelease({
        previewId: targetPreviewId,
        tag: target.tag,
        notes: target.notes,
        confirmation: exactConfirmation
      });
      setRuns((current) => [run, ...current.filter((candidate) => candidate.id !== run.id)]);
      setStartedTag(target.tag);
      setConfirmation("");
    } catch (reason) {
      setError(errorMessage(reason, "Space release publishing could not be started."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="admin-operation-panel">
      <div className="admin-operation-callout">
        <ShieldCheck aria-hidden="true" />
        <p>
          Space publishes the clean live <code>main</code> commit to Gitea first and GitHub second, using fast-forward-only pushes,
          one annotated Athens tag and provider release objects. No force push or automatic deploy is allowed.
        </p>
      </div>

      {!target ? (
        <section className="admin-release-preparation">
          <label>
            <span>Release notes override <small>(optional)</small></span>
            <textarea
              aria-label="Release notes override"
              rows={5}
              maxLength={20_000}
              value={notes}
              disabled={pending || hasActiveRun}
              onChange={(event) => setNotes(event.currentTarget.value)}
            />
          </label>
          <button
            type="button"
            className="admin-operation-primary"
            disabled={pending || hasActiveRun}
            onClick={() => void preparePreview()}
            aria-label="Prepare release preview"
          >
            {pending ? <Loader2 className="spin" aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
            Prepare release preview
          </button>
        </section>
      ) : (
        <section className="admin-release-preview">
          <header>
            <span>
              <strong>{showingPreview ? "Release preview ready" : "Partial release ready to retry"}</strong>
              <small>{showingPreview && preview ? `Expires ${preview.expiresAt}` : "Durable idempotent retry"}</small>
            </span>
            <span className="admin-release-tag">{target.tag}</span>
          </header>
          {showingPreview && preview ? (
            <dl>
              <div><dt>Live commit</dt><dd>{preview.sourceCommit.slice(0, 12)}</dd></div>
              <div><dt>Previous tag</dt><dd>{preview.previousTag ?? "First release"}</dd></div>
              <div><dt>Gitea main</dt><dd>{preview.remoteMainCommits.gitea.slice(0, 12)}</dd></div>
              <div><dt>GitHub main</dt><dd>{preview.remoteMainCommits.github.slice(0, 12)}</dd></div>
            </dl>
          ) : null}
          <pre>{target.notes}</pre>
          <label>
            <span>Type <code>{exactConfirmation}</code> to confirm</span>
            <input
              aria-label={`Type ${exactConfirmation} to confirm`}
              autoComplete="off"
              spellCheck={false}
              value={confirmation}
              disabled={pending || hasActiveRun}
              onChange={(event) => setConfirmation(event.currentTarget.value)}
            />
          </label>
          <div className="admin-release-actions">
            <button
              type="button"
              disabled={pending || hasActiveRun}
              onClick={() => {
                if (showingPreview) {
                  setPreview(null);
                } else if (partialRetry) {
                  setDismissedPartialPreviewId(partialRetry.previewId);
                }
                setConfirmation("");
                setStartedTag(null);
              }}
            >
              {showingPreview ? "Discard preview" : "Prepare new preview"}
            </button>
            <button
              type="button"
              className="admin-operation-primary"
              aria-label={showingPreview ? "Publish to Gitea and GitHub" : "Retry Gitea and GitHub publishing"}
              disabled={pending || hasActiveRun || confirmation !== exactConfirmation}
              onClick={() => void publish()}
            >
              {pending ? <Loader2 className="spin" aria-hidden="true" /> : <Rocket aria-hidden="true" />}
              {showingPreview ? "Publish to Gitea and GitHub" : "Retry publishing"}
            </button>
          </div>
        </section>
      )}

      <section className="admin-operation-history" aria-label="Space release history">
        <header>
          <span>
            <strong>Latest release run</strong>
            <small>{latest ? latest.updatedAt : "No release run recorded yet."}</small>
          </span>
          <button
            type="button"
            aria-label="Refresh Space release history"
            disabled={loading || pending}
            onClick={() => void load()}
          >
            {loading ? <Loader2 className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
          </button>
        </header>
        {latest ? (
          <div className="admin-operation-run-summary">
            <span className={`admin-operation-status ${latest.status.toLowerCase()}`}>{latest.status}</span>
            <p>{latest.summary}</p>
          </div>
        ) : <p className="admin-operation-empty">Prepare a preview to create the first release.</p>}
        {latestSucceeded ? (
          <p className="admin-operation-alert success" role="status">
            Release {latestTag} was published to Gitea and GitHub.
          </p>
        ) : null}
        {latestSucceeded && publishedProviders.length > 0 ? (
          <ul className="admin-operation-providers" aria-label="Published release providers">
            {publishedProviders.map((provider) => (
              <li key={provider.provider}>
                <strong>{provider.provider === "gitea" ? "Gitea" : "GitHub"}</strong>
                <span className={`admin-operation-provider-status ${provider.status.toLowerCase()}`}>
                  {provider.status}
                </span>
                {typeof provider.releaseUrl === "string" && provider.releaseUrl ? (
                  <a href={provider.releaseUrl} target="_blank" rel="noreferrer">
                    Release
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {startedTag && hasActiveRun ? (
        <p className="admin-operation-alert" role="status">
          Publishing {startedTag} started — the result appears here when it completes.
        </p>
      ) : null}
      {error ? <p className="admin-operation-alert error" role="alert">{error}</p> : null}
    </div>
  );
}
