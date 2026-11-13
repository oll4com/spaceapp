import { lazy, Suspense, useEffect, useState } from "react";
import { api } from "../../api.js";
import type { ArtifactMetadataPayload } from "../../live-api.js";
import { DockButton, DockIconButton } from "../dock-kit/DockKit.js";
import { ChevronLeft, ChevronRight, Download, Play, Star } from "../ui-theme/app-icons.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";

const LazyFilePreviewDialog = lazy(() => import("../agent-files/AgentFilesDock.js").then((module) => ({ default: module.FilePreviewDialog })));

/** A file a card names: under the option that names it (its tile answers it), else under its own name (plan clipboard:T2uboz26Oh3q S4). */
export interface NeedsYouChoice { id: string; option: string | null; caption: string }
/** The Design or Video pane that made a card's files: "Open in Design" goes there, at the request when the file names one (S3). */
export interface NeedsYouStudio { source: "DESIGN" | "VIDEO"; roomId: string; paneId: string; target: string }

/** An option's words without the ids it names ("Variant B (artifact:x1)" reads "Variant B"): the tile shows the file itself. */
export const choiceCaption = (words: string) => words.replace(/\s*[([]?\bartifact:[A-Za-z0-9_-]{6,120}[)\]]?/g, "").replace(/\s*[:,–-]\s*$/, "").trim();

/** The recommended answer's badge (S7): part of its button's name, so a screen reader hears it; the space keeps the words apart. */
export function RecommendedBadge() {
  return <>{" "}<span className="ny-badge"><Star aria-hidden="true" />{uiText(useUiLanguage(), "Recommended")}</span></>;
}

type Meta = ArtifactMetadataPayload | "missing";
// S9: the preview opens on Choose this, so Enter answers (plan 7: ← / →, Enter = Choose, Escape closes); after the dialog's Close autoFocus.
const focusAfterMount = (node: HTMLButtonElement | null) => { if (node) queueMicrotask(() => node.focus()); };
const kindOf = (meta: Meta | undefined) => meta && meta !== "missing" ? /^image\//i.test(meta.artifact.mimeType) ? "IMAGE" : /^video\//i.test(meta.artifact.mimeType) ? "VIDEO" : null : null;

function studioOf(meta: Meta | undefined): NeedsYouStudio | null {
  if (!meta || meta === "missing") return null;
  const { roomId, paneId, metadata } = meta.artifact;
  const source = metadata.source === "DESIGN" || metadata.source === "VIDEO" ? metadata.source : null;
  // Design PNGs made before the record named its request carry it inside (`spaceapp:design`).
  const requestId = metadata.requestId ?? meta.design?.requestId;
  return source && roomId && paneId ? { source, roomId, paneId, target: typeof requestId === "string" && requestId ? `request:${requestId}` : "activity" } : null;
}

export function NeedsYouChoices({ choices, recommended, busy, onChoose, onStudio }: {
  choices: NeedsYouChoice[];
  recommended: string | null;
  busy: boolean;
  onChoose(option: string): void;
  onStudio(studio: NeedsYouStudio | null): void;
}) {
  const language = useUiLanguage();
  const t = (words: string, vars?: Record<string, string | number>) => uiText(language, words, vars);
  const [metas, setMetas] = useState<Record<string, Meta>>({});
  const [viewing, setViewing] = useState<number | null>(null);
  const ids = choices.map((choice) => choice.id).join(" ");
  useEffect(() => {
    let live = true;
    for (const id of ids.split(" ").filter(Boolean)) {
      api.artifactMetadata(id).then((payload) => { if (live) setMetas((known) => ({ ...known, [id]: payload })); },
        () => { if (live) setMetas((known) => ({ ...known, [id]: "missing" })); });
    }
    return () => { live = false; };
  }, [ids]);
  const studio = choices.map((choice) => studioOf(metas[choice.id])).find(Boolean) ?? null;
  const studioKey = studio ? `${studio.paneId} ${studio.target}` : "";
  useEffect(() => { onStudio(studio); }, [studioKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const media = choices.filter((choice) => kindOf(metas[choice.id]));
  const shown = viewing === null ? null : media[viewing] ?? null;
  const step = (by: number) => setViewing((index) => index === null ? null : (index + by + media.length) % media.length);
  useEffect(() => {
    if (viewing === null || media.length < 2) return;
    // Capture: the dialog stops every key at itself; a video or a field keeps its own arrows.
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== "ArrowLeft" && event.key !== "ArrowRight") || (event.target as HTMLElement | null)?.closest?.("video, input, textarea")) return;
      event.preventDefault();
      event.stopPropagation();
      step(event.key === "ArrowLeft" ? -1 : 1);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [viewing, media.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const nameOf = (choice: NeedsYouChoice) => {
    const meta = metas[choice.id];
    return choice.caption || (meta && meta !== "missing" ? meta.artifact.filename : "");
  };
  const answer = (choice: NeedsYouChoice) => {
    const isRecommended = choice.option === recommended;
    return choice.option === null ? null
      : <DockButton tone={isRecommended ? "primary" : "default"} disabled={busy} data-sensitive-masked="manual" onClick={() => onChoose(choice.option!)}>
        {nameOf(choice) || choice.option}{isRecommended ? <RecommendedBadge /> : null}
      </DockButton>;
  };

  return (
    <>
      <div className="ny-choices">
        {choices.map((choice) => {
          const meta = metas[choice.id];
          const kind = kindOf(meta);
          const url = api.artifactFileUrl(choice.id);
          return (
            <figure key={choice.id} className={`ny-choice${choice.option !== null && choice.option === recommended ? " is-recommended" : ""}`}>
              {meta === undefined ? <span className="ny-choice-media" aria-hidden="true" />
                : meta === "missing" ? <span className="ny-choice-media is-missing">{t("No longer available")}</span>
                : kind ? (
                  <button type="button" className="ny-choice-media" aria-label={t("Preview {name}", { name: nameOf(choice) })} data-sensitive-masked="manual"
                    onClick={() => setViewing(media.indexOf(choice))}>
                    {kind === "IMAGE" ? <img src={url} alt={nameOf(choice)} loading="lazy" />
                      : <><video src={url} muted playsInline preload="metadata" aria-hidden="true" /><Play className="ny-choice-play" aria-hidden="true" /></>}
                  </button>
                )
                : <a className="ny-choice-file" href={url} target="_blank" rel="noopener noreferrer" data-sensitive-masked="manual">{meta.artifact.filename}</a>}
              {/* A gone file the option does not name keeps only "No longer available": its id says nothing. */}
              {answer(choice) ?? (nameOf(choice) ? <figcaption data-sensitive-masked="manual">{nameOf(choice)}</figcaption> : null)}
            </figure>
          );
        })}
      </div>
      {shown && viewing !== null ? (() => {
        const meta = metas[shown.id] as ArtifactMetadataPayload;
        const url = api.artifactFileUrl(shown.id);
        return (
          <Suspense fallback={null}>
            <LazyFilePreviewDialog filename={nameOf(shown)} meta={`${viewing + 1} / ${media.length} · ${meta.artifact.filename}`} kind={kindOf(meta)!} url={url}
              closeLabel={t("Close preview")} onClose={() => setViewing(null)}
              notice={<span className="sr-only" aria-live="polite">{`${viewing + 1} / ${media.length} · ${nameOf(shown)}`}</span>}
              actions={(
                <>
                  {media.length > 1 ? <><DockIconButton label={t("Previous")} icon={ChevronLeft} onClick={() => step(-1)} /><DockIconButton label={t("Next")} icon={ChevronRight} onClick={() => step(1)} /></> : null}
                  {/* A held Enter that opened the preview repeats here: only a fresh press answers. */}
                  {shown.option !== null ? <DockButton ref={focusAfterMount} tone={shown.option === recommended ? "primary" : "default"} disabled={busy}
                    onKeyDown={(event) => { if (event.repeat) event.preventDefault(); }}
                    onClick={() => { setViewing(null); onChoose(shown.option!); }}>{t("Choose this")}</DockButton> : null}
                  <a href={url} download={meta.artifact.filename} className="dock-kit-icon-button" aria-label={t("Download {name}", { name: meta.artifact.filename })} title={t("Download {name}", { name: meta.artifact.filename })}>
                    <Download aria-hidden="true" />
                  </a>
                </>
              )} />
          </Suspense>
        );
      })() : null}
    </>
  );
}
