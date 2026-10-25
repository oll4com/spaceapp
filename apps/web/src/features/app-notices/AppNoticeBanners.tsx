import type { RefObject } from "react";
import { GlobalApiErrorAlert } from "../../core-api-availability.js";
import { ShieldAlert, X } from "../ui-theme/app-icons.js";
import type { AppNotices } from "./useAppNotices.js";

/** The banner stack at the top of the workspace, in display order. */
export function AppNoticeBanners({ notices, actionError, onDismissActionError, vpnCityNotice, vpnCityNoticeRef, onDismissVpnCityNotice, isRoomFocusMode, isDemoRuntime }: {
  notices: AppNotices;
  actionError: string | null;
  onDismissActionError: () => void;
  vpnCityNotice: string | null;
  vpnCityNoticeRef: RefObject<HTMLDivElement | null>;
  onDismissVpnCityNotice: () => void;
  /** Focus mode hides the storage warning (except in the demo) and clipboard notices. */
  isRoomFocusMode: boolean;
  isDemoRuntime: boolean;
}) {
  const { watchdogAlerts, storageWarning, dismissedStorageWarning, clipToolNotice, clipboardNotice, accountNotice, accountError } = notices;
  return (
    <>
      {watchdogAlerts.map((alert) => (
        <div key={alert.id} className="banner bad" role="alert">
          <div className="notice-row">
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <ShieldAlert size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
              <span>{alert.message}</span>
            </div>
            <button
              type="button"
              className="notice-close"
              aria-label="Dismiss watchdog alert"
              title="Dismiss watchdog alert"
              onClick={() => notices.dismissWatchdogAlert(alert.id)}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </div>
      ))}

      <GlobalApiErrorAlert actionError={actionError} onDismissActionError={onDismissActionError} />
      {storageWarning && (!isRoomFocusMode || isDemoRuntime) && dismissedStorageWarning !== storageWarning ? (
        <div className="banner warn" role="status">
          <div className="notice-row">
            <span>{storageWarning}</span>
            <button
              type="button"
              className="notice-close"
              aria-label="Dismiss message"
              title="Dismiss message"
              onClick={notices.dismissStorageWarning}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
      {clipToolNotice ? (
        <div className="banner warn" role="status">
          <div className="notice-row"><span>{clipToolNotice}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => notices.setClipToolNotice(null)}><X aria-hidden="true" /></button></div>
        </div>
      ) : null}
      {vpnCityNotice ? (
        <div ref={vpnCityNoticeRef} className="banner ok" role="status">
          <div className="notice-row"><span>{vpnCityNotice}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={onDismissVpnCityNotice}><X aria-hidden="true" /></button></div>
        </div>
      ) : null}
      {!isRoomFocusMode && clipboardNotice ? (
        <div className="banner warn" role="status">
          <div className="notice-row"><span>{clipboardNotice}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => notices.setClipboardNotice(null)}><X aria-hidden="true" /></button></div>
        </div>
      ) : null}
      {accountNotice ? (
        <div className="banner ok" role="status">
          <div className="notice-row"><span>{accountNotice}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => notices.setAccountNotice(null)}><X aria-hidden="true" /></button></div>
        </div>
      ) : null}
      {accountError ? (
        <div className="banner warn" role="alert">
          <div className="notice-row"><span>{accountError}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => notices.setAccountError(null)}><X aria-hidden="true" /></button></div>
        </div>
      ) : null}
    </>
  );
}

/** The Live voice debug toast; a click anywhere dismisses it. */
export function LiveDebugToastView({ notices }: { notices: AppNotices }) {
  const toast = notices.liveDebugToast;
  if (!toast) return null;
  return (
    <aside
      className={`live-debug-toast is-${toast.type}`}
      role="status"
      aria-live="polite"
      onClick={notices.dismissLiveDebugToast}
    >
      <span>{toast.message}</span>
      <button
        type="button"
        aria-label="Close"
        onClick={(e) => {
          e.stopPropagation();
          notices.dismissLiveDebugToast();
        }}
      >
        ×
      </button>
    </aside>
  );
}
