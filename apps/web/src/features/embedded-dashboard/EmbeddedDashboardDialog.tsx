import { ExternalLink, Loader2, RefreshCw, X } from "../ui-theme/app-icons.js";
import { useEffect, useRef, useState } from "react";
import type { UserLink } from "@space/contracts";

const iframeSandbox = ["allow-scripts", "allow-same-origin", "allow-forms", "allow-downloads", "allow-modals", "allow-popups", "allow-popups-to-escape-sandbox"].join(" ");

export function EmbeddedDashboardDialog({ link, onClose }: { link: UserLink; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const titleId = `embedded-link-title-${link.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;

  useEffect(() => {
    const dialog = dialogRef.current;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) typeof dialog.showModal === "function" ? dialog.showModal() : dialog.setAttribute("open", "");
    return () => {
      if (dialog?.open && typeof dialog.close === "function") dialog.close();
      openerRef.current?.focus();
    };
  }, []);

  return <dialog ref={dialogRef} className="embedded-dashboard-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="embedded-dashboard-header">
      <div><h2 id={titleId}>{link.title}</h2>{link.description ? <p>{link.description}</p> : null}</div>
      <div className="embedded-dashboard-actions">
        <button type="button" aria-label={`Reload ${link.title}`} title={`Reload ${link.title}`} onClick={() => { setIsLoading(true); setReloadToken((value) => value + 1); }}><RefreshCw aria-hidden="true" /><span>Reload</span></button>
        <a href={link.url} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer" aria-label={`Open ${link.title} in new tab`} title={`Open ${link.title} in new tab`}><ExternalLink aria-hidden="true" /><span>Open in new tab</span></a>
        <button type="button" aria-label={`Close ${link.title}`} title={`Close ${link.title}`} onClick={onClose}><X aria-hidden="true" /><span>Close</span></button>
      </div>
    </header>
    <div className="embedded-dashboard-frame" aria-busy={isLoading}>
      {isLoading ? <div className="embedded-dashboard-loading" role="status" aria-live="polite"><Loader2 aria-hidden="true" /><span>Loading {link.title}…</span></div> : null}
      <iframe key={`${link.id}:${reloadToken}`} src={link.url} title={`${link.title} link`} referrerPolicy="no-referrer" allow="clipboard-read; clipboard-write; fullscreen" sandbox={iframeSandbox} onLoad={() => setIsLoading(false)} />
    </div>
  </dialog>;
}
