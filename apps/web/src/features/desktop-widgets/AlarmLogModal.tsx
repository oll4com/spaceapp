import React, { useEffect, useState } from "react";
import { Check, Copy, ScrollText, Trash2, X } from "../ui-theme/app-icons.js";
import {
  ALARM_LOG_UPDATED_EVENT,
  clearAlarmLogs,
  getAlarmLogs,
  type QuotaAlarmLogEntry
} from "./alarm-log-service.js";

interface AlarmLogModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AlarmLogModal({ isOpen, onClose }: AlarmLogModalProps) {
  const [logs, setLogs] = useState<QuotaAlarmLogEntry[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLogs(getAlarmLogs());

    const handleUpdate = () => {
      setLogs(getAlarmLogs());
    };
    window.addEventListener(ALARM_LOG_UPDATED_EVENT, handleUpdate);
    return () => window.removeEventListener(ALARM_LOG_UPDATED_EVENT, handleUpdate);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCopy = () => {
    try {
      const text = JSON.stringify(logs, null, 2);
      void navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  const handleClear = () => {
    clearAlarmLogs();
    setLogs([]);
  };

  const formatSourceLabel = (src: QuotaAlarmLogEntry["triggerSource"]) =>
    src === "manual_test" ? "Manual test" : src === "claude_api_key_fallback" ? "Claude API key used (fallback)" : "Quota became available";

  return (
    <div className="widget-alarm-log-overlay" role="dialog" aria-modal="true" aria-label="Alarm History & Conditions Log">
      <div className="widget-alarm-log-card">
        <header className="widget-alarm-log-header">
          <div className="widget-alarm-log-title-group">
            <ScrollText className="widget-alarm-log-icon" aria-hidden="true" />
            <strong>Alarm Trigger Log</strong>
            <span className="widget-alarm-log-count-badge">
              {logs.length} {logs.length === 1 ? "event" : "events"}
            </span>
          </div>
          <div className="widget-alarm-log-actions">
            {logs.length > 0 && (
              <>
                <button
                  type="button"
                  className="widget-tag-btn is-action"
                  onClick={handleCopy}
                  title="Copy full alarm log JSON to clipboard"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  <span>{copied ? "Copied" : "Copy"}</span>
                </button>
                <button
                  type="button"
                  className="widget-tag-btn is-action is-danger"
                  onClick={handleClear}
                  title="Clear all recorded alarm events"
                >
                  <Trash2 size={12} />
                  <span>Clear</span>
                </button>
              </>
            )}
            <button
              type="button"
              className="desktop-widget-btn-action is-close"
              onClick={onClose}
              title="Close log"
              aria-label="Close log"
            >
              <X size={14} />
            </button>
          </div>
        </header>

        <div className="widget-alarm-log-content">
          {logs.length === 0 ? (
            <div className="widget-alarm-log-empty">
              <p>No alarm events recorded yet.</p>
              <small>
                Every alarm trigger will automatically record its exact timestamp,
                trigger condition, provider state, and quota percentages here.
              </small>
            </div>
          ) : (
            <ul className="widget-alarm-log-list">
              {logs.map((entry) => (
                <li key={entry.id} className="widget-alarm-log-item">
                  <div className="widget-alarm-log-item-head">
                    <div className="widget-alarm-log-badges">
                      <span className="widget-alarm-badge is-source">
                        {formatSourceLabel(entry.triggerSource)}
                      </span>
                      <span className="widget-alarm-badge is-provider">
                        {entry.provider === "all" ? "ANY" : entry.provider.toUpperCase()}
                        {entry.proOnly ? " (Pro only)" : ""}
                      </span>
                    </div>
                    <time className="widget-alarm-log-time" title={entry.timestamp}>
                      {entry.localTime}
                    </time>
                  </div>

                  <div className="widget-alarm-log-status-row">
                    <span className="widget-alarm-log-metric">
                      Ready:{" "}
                      <strong className={entry.availableCount > 0 ? "is-ready" : "is-exhausted"}>
                        {entry.availableCount}
                      </strong>{" "}
                      / {entry.totalCount} watched
                    </span>
                    {entry.nextBack ? (
                      <span className="widget-alarm-log-metric">
                        Next back: <strong>{entry.nextBack.title}</strong> ({entry.nextBack.provider})
                      </span>
                    ) : null}
                  </div>

                  {entry.availableAccounts.length > 0 ? (
                    <div className="widget-alarm-log-accounts">
                      <span className="widget-alarm-log-sublabel">Ready accounts:</span>
                      <div className="widget-alarm-log-account-pills">
                        {entry.availableAccounts.map((account, index) => (
                          <span key={index} className="widget-alarm-acc-pill is-active">
                            {account.title} · {account.provider}
                            {account.fiveHourPercent != null ? ` · 5h ${Math.round(account.fiveHourPercent)}%` : ""}
                            {account.weeklyPercent != null ? ` · wk ${Math.round(account.weeklyPercent)}%` : ""}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
