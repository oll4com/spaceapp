import React, { useEffect, useMemo, useRef, useState } from "react";
import type { GitOperationResult, RepositoryProviderId, RepositoryProviderState, RepositoryTarget } from "@space/contracts";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { DockButton, DockNotice } from "../dock-kit/DockKit.js";
import { Upload } from "../ui-theme/app-icons.js";
import type { PendingPublish, PublishPreview, SourceControlClient } from "./client.js";
import { providerAvailability, providerLabel } from "./ProviderIcon.js";

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const randomId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
/** Collapsible, but its summary reads as a button so the publish flow is easy to find. */
const PublishSummary = () => <summary className="dock-kit-button source-control-publish-summary"><Upload aria-hidden="true" />Publish to a provider</summary>;

/**
 * Creates a new remote repository in an existing target and binds the project to it.
 * Files are never staged, committed or pushed here; existing commits need an explicit Push afterwards.
 */
export function PublishRepositoryPanel({ client, projectPath, providers, preferred, defaultName, disabled, onPublished, onBusyChange }: {
  client: SourceControlClient; projectPath: string; providers: RepositoryProviderState[]; preferred: RepositoryProviderId | null;
  defaultName: string; disabled: boolean;
  /** Receives the project the publish started for, so a caller can ignore a result for another project. */
  onPublished: (projectPath: string, provider: RepositoryProviderId, result: GitOperationResult, hasCommits: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const ready = useMemo(() => providers.filter(state => providerAvailability(state) === "connected"), [providers]);
  const [provider, setProvider] = useState<RepositoryProviderId | "">(preferred && ready.some(p => p.id === preferred) ? preferred : ready[0]?.id ?? "");
  const [targets, setTargets] = useState<RepositoryTarget[]>([]);
  const [targetCursor, setTargetCursor] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [projects, setProjects] = useState<RepositoryTarget[]>([]);
  const [targetId, setTargetId] = useState("");
  const [name, setName] = useState(defaultName);
  const [isPrivate, setPrivate] = useState(true);
  const [preview, setPreview] = useState<(PublishPreview & { bindingId: string; operationId: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const operation = useRef(randomId());
  const [pending, setPending] = useState<PendingPublish[]>([]);
  const [confirmDismiss, setConfirmDismiss] = useState<string | null>(null);
  const loadPending = async (signal?: AbortSignal) => {
    try { const list = await client.pendingPublishes(projectPath, signal); if (!signal?.aborted) setPending(list); } catch { /* The form stays usable; publish reports conflicts itself. */ }
  };
  useEffect(() => { const controller = new AbortController(); void loadPending(controller.signal); return () => controller.abort(); }, [client, projectPath]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  useEffect(() => { if (!provider && ready[0]) setProvider(ready[0].id); }, [ready, provider]);
  useEffect(() => { setName(current => current || defaultName); }, [defaultName]);
  useEffect(() => {
    setTargets([]); setTargetCursor(null); setTargetId(""); setWorkspace(""); setProjects([]); setPreview(null); setError(null);
    if (!provider) return;
    const controller = new AbortController();
    void client.targets(provider, undefined, undefined, controller.signal).then(page => {
      if (controller.signal.aborted) return;
      setTargets(page.data); setTargetCursor(page.nextCursor);
      if (provider !== "bitbucket") setTargetId(page.data.find(target => target.canCreateRepository)?.id ?? page.data[0]?.id ?? "");
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Targets could not load."); });
    return () => controller.abort();
  }, [client, provider]);
  useEffect(() => {
    if (provider !== "bitbucket" || !workspace) { setProjects([]); return; }
    const controller = new AbortController();
    void client.targets("bitbucket", workspace, undefined, controller.signal).then(page => { if (!controller.signal.aborted) { setProjects(page.data); setTargetId(page.data[0]?.id ?? ""); } })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Projects could not load."); });
    return () => controller.abort();
  }, [client, provider, workspace]);
  const options = provider === "bitbucket" ? projects : targets;
  const target = options.find(item => item.id === targetId) ?? null;
  const inherited = target?.visibility ?? null;
  // Azure repositories inherit the project's visibility; derive it so the toggle never shows a stale value.
  const visibilityPrivate = inherited ? inherited === "private" : isPrivate;
  if (!ready.length && !pending.length) return <details className="source-control-publish"><PublishSummary /><p className="source-control-muted">Connect a repository provider in Settings → Plugins to publish this project.</p></details>;
  const dismiss = async (item: PendingPublish) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await client.dismissPublish(item.bindingId, item.operationId);
      setNotice(`The earlier ${providerLabel(item.provider)} publish is marked as not created. You can publish again.`);
      setConfirmDismiss(null); operation.current = randomId(); await loadPending();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The publish could not be dismissed."); }
    finally { setBusy(false); }
  };
  const unresolved = pending.length ? <div className="source-control-publish-preview" role="group" aria-label="Unconfirmed publish">
    {pending.map(item => <div key={item.bindingId}>
      <p>An earlier publish to <strong>{providerLabel(item.provider)}</strong>{item.name ? <> named <strong>{item.name}</strong></> : null} {item.state === "created" ? "created a repository that is not connected yet. Publish again to connect it." : "was not confirmed. Check the provider first: if the repository exists, select it under Repository; if it does not, mark this attempt as not created."}</p>
      {item.state !== "created" ? confirmDismiss === item.operationId ? <div className="source-control-actions">
        <DockButton tone="ghost" disabled={busy} onClick={() => setConfirmDismiss(null)}>Cancel</DockButton>
        <DockButton tone="danger" disabled={busy} onClick={() => void dismiss(item)}>Confirm: no repository was created</DockButton>
      </div> : <DockButton disabled={busy || disabled} onClick={() => setConfirmDismiss(item.operationId)}>Mark as not created</DockButton> : null}
    </div>)}
  </div> : null;
  if (!ready.length) return <details className="source-control-publish" open><PublishSummary />{unresolved}<p className="source-control-muted">Connect a repository provider in Settings → Plugins to publish this project.</p></details>;

  const review = async () => {
    if (!provider || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const binding = await client.bindRepository(projectPath, provider);
      const status = await client.status(binding.id);
      const operationId = operation.current;
      const result = await client.previewPublish({ bindingId: binding.id, expectedVersion: status.version, name, private: visibilityPrivate, paths: [], confirmed: false, ...(targetId ? { targetId } : {}), operationId });
      setPreview({ ...result, bindingId: binding.id, operationId });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Publish preview failed."); }
    finally { setBusy(false); }
  };
  const publish = async () => {
    if (!preview || busy || !provider) return;
    setBusy(true); setError(null);
    try {
      const result = await client.operate("publish", { bindingId: preview.bindingId, expectedVersion: preview.expectedVersion, name: preview.name, private: preview.private, paths: [], confirmed: true, ...(preview.targetId ? { targetId: preview.targetId } : {}), operationId: preview.operationId });
      const parts = [result.remoteCreated ? "Remote created" : result.createOutcome === "unknown" ? "Remote creation not confirmed" : "Remote not created", result.committed ? "committed" : "nothing committed", result.pushed ? "pushed" : "nothing pushed"];
      if (result.ok) { setNotice(`${parts.join(" · ")}. ${result.message}`); setPreview(null); operation.current = randomId(); onPublished(projectPath, provider, result, preview.hasCommits); }
      else { setError(`${parts.join(" · ")}. ${result.message}`); setPreview(null); if (result.remoteCreated) onPublished(projectPath, provider, result, preview.hasCommits); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Publish failed.");
      // A definite rejection (for example a name collision) allows a new, explicitly reviewed attempt.
      operation.current = randomId(); setPreview(null);
    } finally { setBusy(false); void loadPending(); }
  };
  return (
    <details className="source-control-publish" open={!!preview || pending.length > 0 || undefined}>
      <PublishSummary />
      {unresolved}
      <div className="source-control-publish-form">
        <label>Provider<select aria-label="Publish provider" value={provider} disabled={busy || disabled} onChange={event => setProvider(event.target.value as RepositoryProviderId)}>
          {ready.map(state => <option key={state.id} value={state.id}>{state.label} · {state.connection.accountLogin}</option>)}
        </select></label>
        {provider === "bitbucket" ? <>
          <label>Workspace<select aria-label="Bitbucket workspace" value={workspace} disabled={busy || disabled} onChange={event => setWorkspace(event.target.value)}>
            <option value="">Choose a workspace</option>{targets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <label>Project<select aria-label="Bitbucket project" value={targetId} disabled={busy || disabled || !workspace} onChange={event => setTargetId(event.target.value)}>
            {!projects.length ? <option value="">No projects</option> : null}{projects.map(item => <option key={item.id} value={item.id}>{item.name}{item.createPermission === "unknown" ? " (permission checked on create)" : ""}</option>)}
          </select></label>
        </> : <label>{provider === "azure-devops" ? "Project" : provider === "gitlab" ? "Namespace" : "Owner"}<select aria-label="Publish target" value={targetId} disabled={busy || disabled} onChange={event => setTargetId(event.target.value)}>
          {options.map(item => <option key={item.id} value={item.id} disabled={!item.canCreateRepository && item.createPermission !== "unknown"}>{item.name}{!item.canCreateRepository && item.createPermission !== "unknown" ? " (no create permission)" : ""}</option>)}
        </select></label>}
        {provider === "gitlab" && target && target.kind === "namespace" ? <DockButton tone="ghost" disabled={busy} onClick={() => void (async () => {
          // GitLab groups nest; subgroups are listed on demand under the selected group.
          try {
            let cursor: string | undefined; const found: RepositoryTarget[] = [];
            for (let page = 0; page < 20; page++) { const result = await client.targets("gitlab", target.id, cursor); found.push(...result.data); if (!result.nextCursor) break; cursor = result.nextCursor; }
            setTargets(current => [...current, ...found.filter(item => !current.some(existing => existing.id === item.id))]);
            if (!found.length) setNotice(`${target.name} has no subgroups.`);
          } catch (cause) { setError(cause instanceof Error ? cause.message : "Subgroups could not load."); }
        })()}>Show subgroups of {target.name}</DockButton> : null}
        {targetCursor && provider !== "bitbucket" ? <DockButton tone="ghost" disabled={busy} onClick={() => void client.targets(provider as RepositoryProviderId, undefined, targetCursor).then(page => { setTargets(current => [...current, ...page.data]); setTargetCursor(page.nextCursor); }).catch(cause => setError(cause instanceof Error ? cause.message : "Targets could not load."))}>Load more targets</DockButton> : null}
        <label>Repository name<input aria-label="Repository name" value={name} spellCheck={false} disabled={busy || disabled} onChange={event => { setName(event.target.value); setPreview(null); }} /></label>
        <SpaceToggle label="Private repository" checked={visibilityPrivate} disabled={busy || disabled || !!inherited} onChange={value => { setPrivate(value); setPreview(null); }}
          detail={inherited ? `Inherited from the ${inherited} project.` : "Private is the default."} />
        {!preview ? <DockButton tone="primary" disabled={busy || disabled || !namePattern.test(name) || (!targetId && provider !== "github" && provider !== "gitea")} onClick={() => void review()}>Review publish</DockButton> : <div className="source-control-publish-preview" role="group" aria-label="Publish preview">
          <p>Create a <strong>{preview.visibility}</strong> repository <strong>{preview.name}</strong> in <strong>{preview.targetName}</strong>.</p>
          <p>{preview.hasCommits ? "Existing commits stay local until you choose Push." : "The project has no commits yet; an empty remote will be connected."} Nothing is staged, committed or pushed automatically, and an existing origin is never replaced.</p>
          {preview.createPermission === "unknown" ? <p>The provider decides whether you may create here.</p> : null}
          <div className="source-control-actions"><DockButton tone="ghost" onClick={() => setPreview(null)} disabled={busy}>Back</DockButton><DockButton tone="primary" busy={busy} onClick={() => void publish()} disabled={busy}>Create remote repository</DockButton></div>
        </div>}
        {busy ? <p className="source-control-muted" role="status">Working…</p> : null}
        {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
        {notice ? <DockNotice tone="success" onDismiss={() => setNotice(null)}>{notice}</DockNotice> : null}
      </div>
    </details>
  );
}
