import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { SIGNATURE_DRAWN, type Artifact, type SavedSignature, type SignatureField, type SignaturePlacement, type SignatureRequest } from "@space/contracts";
import { api } from "../../api.js";
import { dispatchArtifactsUpdated } from "../../artifact-events.js";
import { DockButton, DockIconButton, DockNotice } from "../dock-kit/DockKit.js";
import { CalendarDays, Check, PenLine, Phone, X } from "../ui-theme/app-icons.js";
import { DEFAULT_RATIO, SignaturePad } from "./SignaturePad.js";
import "./sign-dialog.css";

// Signature from the phone (operator 4/11 18:38 BKK «δεν εχω εκτυπωτη», plan clipboard:2qSLIT_csvPm): the PDF's pages, a pad to sign with a finger
// or the mouse, the spots the signature goes (a request's own, or tapped here), and the texts the form needs (the phone, the date).
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type Request = SignatureRequest & { document: { filename: string; folder: string | null } | null };
type PlaceKind = "SIGNATURE" | "PHONE" | "DATE";
const DEFAULT_WIDTH = 150;
const today = () => new Date().toISOString().slice(0, 10).split("-").reverse().join(".");

type Page = { proxy: PDFPageProxy; base: PageViewport };

/** One PDF page drawn at the width it has on screen, with the spots on it; a tap answers PDF points. */
function PdfPage({ page, number, width, children, onTap }: {
  page: Page; number: number; width: number; children: (viewport: PageViewport) => React.ReactNode; onTap?: (point: [number, number]) => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const viewport = useMemo(() => page.proxy.getViewport({ scale: width / page.base.width }), [page, width]);
  useEffect(() => {
    const element = canvas.current;
    if (!element || width <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    const sharp = page.proxy.getViewport({ scale: (width / page.base.width) * ratio });
    element.width = Math.floor(sharp.width);
    element.height = Math.floor(sharp.height);
    const task = page.proxy.render({ canvas: element, canvasContext: element.getContext("2d")!, viewport: sharp });
    return () => task.cancel();
  }, [page, width]);
  return (
    <div className="sign-page" style={{ width: viewport.width, height: viewport.height }} data-page={number}
      onClick={onTap ? (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onTap(viewport.convertToPdfPoint(event.clientX - rect.left, event.clientY - rect.top) as [number, number]);
      } : undefined}>
      <canvas ref={canvas} className="sign-page-canvas" aria-label={`Page ${number}`} />
      {children(viewport)}
      <span className="sign-page-number" aria-hidden="true">{number}</span>
    </div>
  );
}

/** A rectangle in PDF points as CSS pixels on the page's viewport (any rotation). */
function cssBox(viewport: PageViewport, x: number, y: number, width: number, height: number) {
  const [x1, y1] = viewport.convertToViewportPoint(x, y);
  const [x2, y2] = viewport.convertToViewportPoint(x + width, y + height);
  return { left: Math.min(x1!, x2!), top: Math.min(y1!, y2!), width: Math.abs(x2! - x1!), height: Math.abs(y2! - y1!) };
}

export function SignDialog({ artifactId, filename, request, onClose, onSigned }: {
  artifactId: string; filename: string; request?: Request | null; onClose: () => void; onSigned?: (artifact: Artifact) => void;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The saved signatures (nous_msg:781819c5ba0440fbbee8682c): `choice` fills every spot (the default first), `spotChoice` overrides one spot.
  const [saved, setSaved] = useState<SavedSignature[]>([]);
  const [choice, setChoice] = useState<string>(SIGNATURE_DRAWN);
  const [spotChoice, setSpotChoice] = useState<Array<string | undefined>>([]);
  const [drawn, setDrawn] = useState<{ png: string; ratio: number } | null>(null);
  const [remember, setRemember] = useState(true);
  const [label, setLabel] = useState("");
  const [phone, setPhone] = useState("");
  const [date, setDate] = useState(today());
  const [values, setValues] = useState<string[]>([]);
  const [placing, setPlacing] = useState<PlaceKind>("SIGNATURE");
  const [placements, setPlacements] = useState<SignaturePlacement[]>(request?.placements ?? []);
  const [fields, setFields] = useState<SignatureField[]>(request?.fields ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signed, setSigned] = useState<Artifact | null>(null);
  const [width, setWidth] = useState(0);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const fixed = Boolean(request);

  useEffect(() => {
    let live = true;
    const task = pdfjs.getDocument({ url: api.artifactFileUrl(artifactId), withCredentials: true });
    task.promise.then(async (loaded) => {
      const all = await Promise.all(Array.from({ length: loaded.numPages }, async (_, index) => {
        const proxy = await loaded.getPage(index + 1);
        return { proxy, base: proxy.getViewport({ scale: 1 }) };
      }));
      if (live) { setDoc(loaded); setPages(all); }
    }, (failure: unknown) => { if (live) setLoadError(failure instanceof Error ? failure.message : "The PDF could not be opened."); });
    return () => { live = false; void task.destroy(); };
  }, [artifactId]);

  useEffect(() => {
    let live = true;
    api.signatures().then(({ signatures }) => {
      const preferred = signatures.find((item) => item.isDefault) ?? signatures[0];
      if (!live || !preferred) return;
      setSaved(signatures);
      setChoice(preferred.id);
      // With signatures saved, one drawn here is kept only when asked.
      setRemember(false);
    }, () => undefined);
    api.signatureDetails().then(({ details }) => {
      if (!live) return;
      setPhone((current) => current || details.phone || "");
    }, () => undefined);
    return () => { live = false; };
  }, []);

  // A request's fields start with the agent's value, else the saved phone (PHONE) or today (DATE).
  useEffect(() => {
    if (!request) return;
    setValues(request.fields.map((field) => field.value ?? (field.kind === "PHONE" ? phone : field.kind === "DATE" ? date : "")));
  // The saved phone arrives once, before the owner types; the date is today's.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, phone]);

  useEffect(() => {
    const element = pagesRef.current;
    if (!element) return;
    const measure = () => { const style = getComputedStyle(element);
      setWidth(Math.min(900, element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2)); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [doc]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const savedById = new Map(saved.map((item) => [item.id, item]));
  const spotIds = placements.map((_, index) => spotChoice[index] ?? choice);
  const ratioOf = (id: string) => { const item = savedById.get(id); return item ? item.height / item.width : drawn?.ratio ?? DEFAULT_RATIO; };
  const imageOf = (id: string) => savedById.has(id) ? api.savedSignatureImageUrl(id) : drawn?.png ?? null;
  const usesDrawn = choice === SIGNATURE_DRAWN || spotIds.includes(SIGNATURE_DRAWN);
  const hasSignature = (placements.length ? spotIds : [choice]).every((id) => savedById.has(id) || (id === SIGNATURE_DRAWN && Boolean(drawn)));
  const ratio = ratioOf(choice);
  const fieldText = (field: SignatureField, index: number) => fixed ? values[index] ?? "" : field.kind === "PHONE" ? phone : field.kind === "DATE" ? date : field.value ?? "";

  function tap(page: number, [x, y]: [number, number]) {
    if (fixed) return;
    if (placing === "SIGNATURE") {
      const width = DEFAULT_WIDTH, height = width * ratio;
      setPlacements((current) => [...current, { page, x: Math.max(0, x - width / 2), y: Math.max(0, y - height / 2), width }]);
    } else {
      setFields((current) => [...current, { page, x: Math.max(0, x), y: Math.max(0, y - 4), kind: placing, label: placing === "PHONE" ? "Phone" : "Date", size: 10 }]);
    }
  }

  async function sign() {
    setBusy(true);
    setError(null);
    try {
      const png = usesDrawn ? drawn?.png : undefined;
      const picked = { spotSignatures: spotIds, ...(png ? { png, remember, ...(remember && label.trim() ? { label: label.trim() } : {}) } : {}) };
      const fieldValues = fields.map(fieldText);
      // The phone typed here is the one the next signing starts with.
      if (!fixed && phone.trim()) await api.saveSignatureDetails({ phone: phone.trim() }).catch(() => undefined);
      const result = request
        ? await api.signSignatureRequest(request.id, { ...picked, fieldValues })
        : await api.signAgentFile(artifactId, { ...picked, placements, fields, fieldValues });
      setSigned(result.artifact);
      if (result.artifact.roomId) dispatchArtifactsUpdated(result.artifact.roomId, [result.artifact]);
      onSigned?.(result.artifact);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The document could not be signed.");
    } finally {
      setBusy(false);
    }
  }

  const ready = hasSignature && placements.length > 0 && !busy;
  const pagesWithSpots = [...new Set(placements.map((spot) => spot.page))].sort((a, b) => a - b);

  const body = (
    <div className="attachment-modal agent-files-modal sign-dialog" role="dialog" aria-modal="true" aria-label={`Sign ${filename}`} onClick={onClose}>
      <div className="attachment-modal-body agent-files-modal-body sign-dialog-body" onClick={(event) => event.stopPropagation()}>
        <div className="agent-files-modal-head">
          <div className="agent-files-modal-heading">
            <span className="dock-kit-card-title" title={filename}>{request?.title ?? `Sign ${filename}`}</span>
            <span className="dock-kit-meta-text">
              {placements.length
                ? `${placements.length} spot${placements.length === 1 ? "" : "s"} · page${pagesWithSpots.length === 1 ? "" : "s"} ${pagesWithSpots.join(", ")} · ${new Set(spotIds).size > 1 ? "a signature picked for each" : "one signature fills them all"}`
                : "Tap the page where the signature goes"}
            </span>
          </div>
          <div className="agent-files-modal-actions"><DockIconButton label="Close signing" icon={X} onClick={onClose} /></div>
        </div>

        {signed ? (
          <div className="sign-done" role="status">
            <Check aria-hidden="true" />
            <strong>Signed. The signed copy is in Agent Files{request?.document?.folder ? ` › ${request.document.folder}` : ""}.</strong>
            <span className="dock-kit-meta-text">{typeof signed.metadata.originalFilename === "string" ? signed.metadata.originalFilename : signed.id}</span>
            <div className="sign-done-actions">
              <a className="dock-kit-button" href={api.agentFileDownloadUrl(signed.id)}>Download</a>
              <DockButton tone="primary" onClick={onClose}>Done</DockButton>
            </div>
          </div>
        ) : (
          <div className="sign-layout">
            <section className="sign-controls" aria-label="Your signature and details">
              {request?.note ? <p className="sign-note">{request.note}</p> : null}
              <h3 className="sign-heading">Signature</h3>
              {saved.length ? (
                <div className="sign-choice sign-picker" role="radiogroup" aria-label="Which signature">
                  {saved.map((item) => (
                    <label key={item.id} className={`sign-pick${choice === item.id ? " is-active" : ""}`}>
                      <input type="radio" checked={choice === item.id} onChange={() => { setChoice(item.id); setSpotChoice([]); }} />
                      <img src={api.savedSignatureImageUrl(item.id)} alt="" />
                      <span>{item.label}{item.isDefault ? " · default" : ""}</span>
                    </label>
                  ))}
                  <label className={`sign-pick${choice === SIGNATURE_DRAWN ? " is-active" : ""}`}>
                    <input type="radio" checked={choice === SIGNATURE_DRAWN} onChange={() => { setChoice(SIGNATURE_DRAWN); setSpotChoice([]); }} /> <span>Draw a new one</span>
                  </label>
                </div>
              ) : null}
              {usesDrawn ? (
                <>
                  <SignaturePad onChange={(png, nextRatio) => setDrawn(png ? { png, ratio: nextRatio } : null)} />
                  <label className="sign-check"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> Save it to my signatures</label>
                  {remember ? <label className="sign-field"><span>Name</span><input value={label} maxLength={80} placeholder={`Signature ${saved.length + 1}`} onChange={(event) => setLabel(event.target.value)} /></label> : null}
                </>
              ) : null}
              {saved.length && placements.length > 1 ? (
                <div className="sign-spots" aria-label="Signature on each spot">
                  {placements.map((spot, index) => (
                    <label key={index} className="sign-field">
                      <span>Spot {index + 1} <small>page {spot.page}</small></span>
                      <select value={spotIds[index]} onChange={(event) => { const id = event.target.value; setSpotChoice((current) => { const next = [...current]; next[index] = id; return next; }); }}>
                        {saved.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                        <option value={SIGNATURE_DRAWN}>Drawn now</option>
                      </select>
                    </label>
                  ))}
                </div>
              ) : null}

              <h3 className="sign-heading">Details</h3>
              {fixed ? (
                request!.fields.length ? request!.fields.map((field, index) => (
                  <label key={index} className="sign-field">
                    <span>{field.label} <small>page {field.page}</small></span>
                    <input value={values[index] ?? ""} inputMode={field.kind === "PHONE" ? "tel" : undefined} type={field.kind === "PHONE" ? "tel" : "text"}
                      autoComplete={field.kind === "PHONE" ? "tel" : "off"} onChange={(event) => setValues((current) => current.map((value, at) => at === index ? event.target.value : value))} />
                  </label>
                )) : <p className="dock-kit-meta-text">This document needs only the signature.</p>
              ) : (
                <>
                  <label className="sign-field"><span>Phone</span>
                    <input type="tel" inputMode="tel" autoComplete="tel" value={phone} placeholder="+66 …" onChange={(event) => setPhone(event.target.value)} /></label>
                  <label className="sign-field"><span>Date</span><input value={date} onChange={(event) => setDate(event.target.value)} /></label>
                  <div className="sign-place" role="radiogroup" aria-label="What a tap places">
                    <span className="dock-kit-meta-text">A tap on a page places:</span>
                    {([["SIGNATURE", "Signature", PenLine], ["PHONE", "Phone", Phone], ["DATE", "Date", CalendarDays]] as const).map(([kind, label, Icon]) => (
                      <button key={kind} type="button" role="radio" aria-checked={placing === kind} className={`sign-place-option${placing === kind ? " is-active" : ""}`} onClick={() => setPlacing(kind)}>
                        <Icon aria-hidden="true" />{label}
                      </button>
                    ))}
                  </div>
                  <span className="dock-kit-meta-text">Tap a placed item to remove it.</span>
                </>
              )}

              {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
              <DockButton tone="primary" icon={PenLine} disabled={!ready} busy={busy} onClick={() => void sign()}>
                {placements.length > 1 ? `Sign all ${placements.length} spots` : "Sign"}
              </DockButton>
              {!hasSignature ? <span className="dock-kit-meta-text">Sign in the box above first.</span> : null}
            </section>

            <section ref={pagesRef} className="sign-pages" aria-label="Document pages">
              {loadError ? <div className="agent-files-preview-note is-error" role="alert">{loadError}</div> : null}
              {!doc && !loadError ? <div className="agent-files-preview-note" role="status">Loading the document…</div> : null}
              {width > 0 ? pages.map((page, index) => (
                <PdfPage key={index} page={page} number={index + 1} width={width} onTap={fixed ? undefined : (point) => tap(index + 1, point)}>
                  {(viewport) => (
                    <>
                      {placements.map((spot, at) => spot.page !== index + 1 ? null : (
                        <button key={`s${at}`} type="button" className="sign-spot" style={cssBox(viewport, spot.x, spot.y, spot.width, spot.width * ratioOf(spotIds[at]!))}
                          aria-label={fixed ? `Signature spot ${at + 1}` : `Remove signature spot ${at + 1}`} disabled={fixed}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (fixed) return;
                            setPlacements((current) => current.filter((_, i) => i !== at));
                            setSpotChoice((current) => current.filter((_, i) => i !== at));
                          }}>
                          {imageOf(spotIds[at]!) ? <img src={imageOf(spotIds[at]!)!} alt="" /> : <span>Sign here</span>}
                        </button>
                      ))}
                      {fields.map((field, at) => field.page !== index + 1 ? null : (
                        <button key={`f${at}`} type="button" className="sign-text-spot" disabled={fixed}
                          style={{ ...cssBox(viewport, field.x, field.y, Math.max(40, fieldText(field, at).length * field.size * 0.55), field.size), fontSize: field.size * viewport.scale }}
                          aria-label={fixed ? field.label : `Remove ${field.label}`}
                          onClick={(event) => { event.stopPropagation(); if (!fixed) setFields((current) => current.filter((_, i) => i !== at)); }}>
                          {fieldText(field, at) || field.label}
                        </button>
                      ))}
                    </>
                  )}
                </PdfPage>
              )) : null}
            </section>
          </div>
        )}
      </div>
    </div>
  );

  const shell = document.querySelector<HTMLElement>(".space-shell");
  return createPortal(
    <div className="dock-kit-scope" data-ui-theme={shell?.dataset.uiTheme ?? document.body.dataset.uiTheme} data-interface-theme={document.documentElement.dataset.interfaceTheme}
      data-room-theme={shell?.dataset.roomTheme ?? document.body.dataset.roomTheme} data-color-mode={shell?.dataset.colorMode ?? document.body.dataset.colorMode}>
      {body}
    </div>, document.body);
}
