import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { SignatureRequest } from "@space/contracts";
import { api } from "../../api.js";
import { DockButton } from "../dock-kit/DockKit.js";
import { takeSurfaceTarget } from "../notifications/notification-store.js";
import { PenLine } from "../ui-theme/app-icons.js";

// pdfjs loads only when a document is signed.
const LazySignDialog = lazy(() => import("./SignDialog.js").then((module) => ({ default: module.SignDialog })));
type Request = SignatureRequest & { document: { filename: string; folder: string | null } | null };

/** A Sign button for one PDF of Agent Files, with its own Sign view. */
export function SignButton({ artifactId, filename }: { artifactId: string; filename: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DockButton icon={PenLine} onClick={() => setOpen(true)}>Sign</DockButton>
      {open ? <Suspense fallback={null}><LazySignDialog artifactId={artifactId} filename={filename} onClose={() => setOpen(false)} /></Suspense> : null}
    </>
  );
}

/** Agents' pending signature requests, on top of Agent Files: one signature fills every spot each asks for. */
export function SignatureRequests({ refreshKey }: { refreshKey?: string | null }) {
  const [requests, setRequests] = useState<Request[]>([]);
  const [signing, setSigning] = useState<Request | null>(null);
  const load = useCallback(() => {
    api.signatureRequests("PENDING").then(({ requests: pending }) => setRequests(pending), () => undefined);
  }, []);
  useEffect(load, [load, refreshKey]);
  // A Needs you card's Open (target sign:<id>) lands here: that request opens, also when the dock was already open.
  const [wanted, setWanted] = useState<string | null>(() => takeSurfaceTarget("sign:"));
  useEffect(() => {
    const onTarget = () => { const id = takeSurfaceTarget("sign:"); if (id) { setWanted(id); load(); } };
    window.addEventListener("space:surface-target", onTarget);
    return () => window.removeEventListener("space:surface-target", onTarget);
  }, [load]);
  useEffect(() => {
    const found = wanted ? requests.find((request) => request.id === wanted) : undefined;
    if (found) { setSigning(found); setWanted(null); }
  }, [requests, wanted]);
  if (!requests.length && !signing) return null;
  return (
    <section className="sign-requests" aria-label="Signature requests">
      <h3 className="sign-requests-title">Signature requests · {requests.length} waiting for you</h3>
      {requests.map((request) => (
        <div key={request.id} className="sign-request">
          <div className="sign-request-text">
            <strong title={request.title}>{request.title}</strong>
            <span className="dock-kit-meta-text">
              {request.document?.filename ?? request.artifactId} · {request.placements.length} spot{request.placements.length === 1 ? "" : "s"}
              {request.fields.length ? ` · ${request.fields.map((field) => field.label).join(", ")}` : ""}
            </span>
          </div>
          <div className="sign-request-actions">
            <DockButton tone="primary" icon={PenLine} onClick={() => setSigning(request)}>Sign</DockButton>
          </div>
        </div>
      ))}
      {signing ? (
        <Suspense fallback={null}>
          <LazySignDialog artifactId={signing.artifactId} filename={signing.document?.filename ?? signing.artifactId} request={signing}
            onClose={() => { setSigning(null); load(); }} />
        </Suspense>
      ) : null}
    </section>
  );
}
