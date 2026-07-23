import { SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  CodexCliModeDefaultPair,
  CodexCliModeDefaultsResponse,
  UpdateCodexCliModeDefaultsInput
} from "@space/contracts";
import type { SpaceApiClient } from "../../runtime/SpaceRuntime.js";

type CodexCliDefaultsClient = Pick<
  SpaceApiClient,
  "codexCliModeDefaults" | "updateCodexCliModeDefaults"
>;

type Mode = UpdateCodexCliModeDefaultsInput["mode"];

function modeLabel(mode: Mode): "Build" | "Plan" {
  return mode === "build" ? "Build" : "Plan";
}

function effortLabel(value: string): string {
  const labels: Record<string, string> = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "XHigh",
    max: "Max",
    ultra: "Ultra"
  };
  return labels[value] ?? value;
}

export function CodexCliDefaultsCard({ client }: { client: CodexCliDefaultsClient }) {
  const [response, setResponse] = useState<CodexCliModeDefaultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingMode, setSavingMode] = useState<Mode | null>(null);
  const [savedMode, setSavedMode] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setResponse(await client.codexCliModeDefaults());
    } catch (loadError) {
      setResponse(null);
      setError(loadError instanceof Error ? loadError.message : "Codex CLI defaults failed to load.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    client.codexCliModeDefaults()
      .then((payload) => {
        if (!disposed) setResponse(payload);
      })
      .catch((loadError: unknown) => {
        if (disposed) return;
        setResponse(null);
        setError(loadError instanceof Error ? loadError.message : "Codex CLI defaults failed to load.");
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [client]);

  async function save(mode: Mode, pair: CodexCliModeDefaultPair) {
    if (!response || response.catalog.status !== "AVAILABLE" || savingMode) return;
    const previous = response;
    setResponse({
      ...response,
      defaults: { ...response.defaults, [mode]: pair }
    });
    setSavingMode(mode);
    setSavedMode(null);
    setError(null);
    try {
      setResponse(await client.updateCodexCliModeDefaults({ mode, ...pair }));
      setSavedMode(mode);
    } catch (saveError) {
      setResponse(previous);
      setError(saveError instanceof Error ? saveError.message : `${modeLabel(mode)} defaults failed to save.`);
    } finally {
      setSavingMode(null);
    }
  }

  function changeModel(mode: Mode, modelId: string) {
    if (!response || response.catalog.status !== "AVAILABLE") return;
    const model = response.catalog.models.find((candidate) => candidate.id === modelId);
    if (!model) return;
    const reasoningEffort = model.supportedReasoningEfforts.includes(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : model.supportedReasoningEfforts[0];
    if (!reasoningEffort) return;
    void save(mode, { modelId, reasoningEffort });
  }

  const catalogAvailable = response?.catalog.status === "AVAILABLE";
  const controlsDisabled = loading || Boolean(savingMode) || !catalogAvailable;
  const statusText = savingMode
    ? `Saving ${modeLabel(savingMode)} defaults…`
    : savedMode
      ? `Saved ${modeLabel(savedMode)} defaults`
      : loading
        ? "Loading Codex CLI defaults…"
        : catalogAvailable
          ? "Defaults are ready"
          : "Codex catalog unavailable";

  return (
    <section
      className="agent-settings-card codex-cli-defaults-card"
      aria-busy={loading || Boolean(savingMode)}
      aria-label="Codex CLI defaults"
    >
      <div className="agent-settings-section-title">
        <SlidersHorizontal aria-hidden="true" />
        <span>
          <strong>Codex CLI defaults</strong>
          <small>Applied globally on the next Build or Plan switch.</small>
        </span>
      </div>

      <div className="codex-cli-defaults-status" role="status" aria-live="polite">
        {statusText}
      </div>

      {response ? (
        <div className="codex-cli-defaults-grid">
          {(["build", "plan"] as const).map((mode) => {
            const pair = response.defaults[mode];
            const selectedModel = response.catalog.status === "AVAILABLE"
              ? response.catalog.models.find((model) => model.id === pair.modelId) ?? null
              : null;
            const efforts = selectedModel?.supportedReasoningEfforts ?? [];
            return (
              <fieldset key={mode} className="codex-cli-defaults-mode" disabled={controlsDisabled}>
                <legend>{modeLabel(mode)}</legend>
                <label>
                  <span>Model</span>
                  <select
                    aria-label={`${modeLabel(mode)} model`}
                    name={`codex-cli-${mode}-model`}
                    value={catalogAvailable ? pair.modelId : ""}
                    onChange={(event) => changeModel(mode, event.target.value)}
                  >
                    {response.catalog.status === "AVAILABLE" ? (
                      response.catalog.models.map((model) => (
                        <option key={model.id} value={model.id}>{model.displayName}</option>
                      ))
                    ) : (
                      <option value="">Unavailable</option>
                    )}
                  </select>
                </label>
                <label>
                  <span>Reasoning</span>
                  <select
                    aria-label={`${modeLabel(mode)} reasoning`}
                    name={`codex-cli-${mode}-reasoning`}
                    value={catalogAvailable ? pair.reasoningEffort : ""}
                    onChange={(event) => void save(mode, {
                      modelId: pair.modelId,
                      reasoningEffort: event.target.value
                    })}
                  >
                    {efforts.length ? (
                      efforts.map((effort) => (
                        <option key={effort} value={effort}>{effortLabel(effort)}</option>
                      ))
                    ) : (
                      <option value="">Unavailable</option>
                    )}
                  </select>
                </label>
              </fieldset>
            );
          })}
        </div>
      ) : null}

      {response?.catalog.status === "UNAVAILABLE" ? (
        <div className="codex-cli-defaults-unavailable">{response.catalog.error}</div>
      ) : null}
      {error ? (
        <div className="validation-result bad" role="alert">
          <strong>CODEX_CLI_DEFAULTS_ERROR</strong>
          <small>{error}</small>
          {!response ? (
            <button className="compact-action" type="button" onClick={() => void load()} disabled={loading}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
