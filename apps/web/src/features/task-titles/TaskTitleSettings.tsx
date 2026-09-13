import { useEffect, useState } from "react";
import {
  taskTitleSettingsSchema,
  type TaskTitleSettings as Settings,
  type TaskTitleCandidateStatus,
} from "@space/contracts";
import { api } from "../../api.js";
export function TaskTitleSettings() {
  const [settings, setSettings] = useState<Settings | null>(null),
    [candidates, setCandidates] = useState<TaskTitleCandidateStatus[]>([]),
    [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([api.taskTitleSettings(), api.taskTitleAvailability()])
      .then(([s, status]) => {
        if (active) {
          setSettings(s);
          setCandidates(status.candidates);
        }
      })
      .catch(() => {
        if (active) setError("Task title settings are unavailable.");
      });
    return () => {
      active = false;
    };
  }, []);
  async function save(patch: Partial<Settings>) {
    if (!settings) return;
    setPending(true);
    setError(null);
    try {
      setSettings(
        await api.updateTaskTitleSettings(
          taskTitleSettingsSchema.parse({ ...settings, ...patch }),
        ),
      );
    } catch {
      setError("Could not save task title settings.");
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="task-title-settings" aria-label="Task titles">
      <h3>Task titles</h3>
      <p>
        Automatic titles and task summaries. Free models first; existing
        subscription quota can provide fallback. No additional charges.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {settings ? (
        <>
          <label>
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={pending}
              onChange={(e) => void save({ enabled: e.target.checked })}
            />{" "}
            Automatic summaries
          </label>
          <label>
            Preferred model
            <select
              aria-label="Task title preferred model"
              disabled={pending}
              value={settings.preferredCandidateIds[0] ?? ""}
              onChange={(e) =>
                void save({
                  preferredCandidateIds: e.target.value ? [e.target.value] : [],
                })
              }
            >
              <option value="">Automatic with fallback</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName} · {c.providerId}
                </option>
              ))}
            </select>
          </label>
          <div className="provider-settings-grid">
            {(
              [
                ["perTaskHourAttempts", "Attempts per task per hour"],
                ["perTaskDayAttempts", "Attempts per task per day"],
                ["globalDayAttempts", "Total attempts per day"],
                [
                  "subscriptionReservePercent",
                  "Subscription quota reserve (%)",
                ],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  aria-label={label}
                  min={key === "subscriptionReservePercent" ? 0 : 1}
                  max={key === "subscriptionReservePercent" ? 95 : 5000}
                  defaultValue={settings[key]}
                  disabled={pending}
                  onBlur={(e) => {
                    const value = Number(e.target.value);
                    if (value !== settings[key]) {
                      try {
                        taskTitleSettingsSchema.parse({
                          ...settings,
                          [key]: value,
                        });
                        void save({ [key]: value });
                      } catch {
                        e.target.value = String(settings[key]);
                      }
                    }
                  }}
                />
              </label>
            ))}
          </div>
          <label>
            Allowed providers
            <input
              aria-label="Allowed title providers"
              placeholder="All eligible connected providers"
              defaultValue={settings.allowedProviderIds.join(", ")}
              disabled={pending}
              onBlur={(e) =>
                void save({
                  allowedProviderIds: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <label>
            Allowed subscription providers
            <input
              aria-label="Subscription title providers"
              placeholder="All eligible subscription providers"
              defaultValue={settings.subscriptionProviderIds.join(", ")}
              disabled={pending}
              onBlur={(e) =>
                void save({
                  subscriptionProviderIds: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <details>
            <summary>Model availability</summary>
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Provider</th>
                  <th>Usage</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.id}>
                    <td>{c.displayName}</td>
                    <td>{c.providerId}</td>
                    <td>{c.billing}</td>
                    <td>{c.availability}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              Providers without a quota endpoint remain Unknown until a request
              succeeds. Add optional providers using the existing provider
              connections.
            </p>
          </details>
        </>
      ) : null}
    </section>
  );
}
