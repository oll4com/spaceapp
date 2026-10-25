import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type {
  CliAccountIdentitiesResponse,
  CliAccountProfile,
  CliAccountProfileDetailsResponse,
  CreateCliAccountProfileInput,
  CreateCliAccountProfileResponse,
  ListCliAccountProfilesResponse,
  RemoveCliAccountProfileResponse,
  UpdateCliAccountProfileInput,
  UpdateCliAccountProfileResponse,
} from "@space/contracts";
import { api } from "../../api.js";
import { dispatchCliAccountProfilesChange } from "../../cli-account-profile-events.js";
import { cliRuntimePresentation } from "../../cli-runtime-presentation.js";
import { readStoredSuppressNotifications } from "../../notifications-settings.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";
import { DockNotice } from "../dock-kit/DockKit.js";
import { AlertTriangle, Check, CircleHelp, Link2, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from "../ui-theme/app-icons.js";
import { cliAccountAvailability, cliAccountPlan, type CliAccountAvailability, type CliAccountRuntimeId } from "./cli-account-availability.js";
import {
  accountSuggestions,
  CLI_ACCOUNT_RUNTIME_IDS,
  CLI_ACCOUNT_RUNTIME_LABELS,
  duplicateProfiles,
  linkedProfiles,
  sameAccountName,
  uniqueAccountProfileId,
  type CliAccountSuggestion,
} from "./cli-account-links.js";
import { accountColorStyle, CliAccountAvatar, CliAccountColorLegend, CliAccountMeter } from "./CliAccountVisuals.js";
import { useCliAccountSignals } from "./use-cli-account-signals.js";

export interface CliAccountsPanelClient {
  listCliAccountProfiles?: (runtimeId: string) => Promise<ListCliAccountProfilesResponse>;
  createCliAccountProfile?: (input: CreateCliAccountProfileInput) => Promise<CreateCliAccountProfileResponse>;
  updateCliAccountProfile?: (runtimeId: string, profileId: string, input: UpdateCliAccountProfileInput) => Promise<UpdateCliAccountProfileResponse>;
  getCliAccountProfileDetails?: (runtimeId: string, profileId: string) => Promise<CliAccountProfileDetailsResponse>;
  removeCliAccountProfile?: (runtimeId: string, profileId: string) => Promise<RemoveCliAccountProfileResponse>;
  cliAccountIdentities?: (refresh?: boolean) => Promise<CliAccountIdentitiesResponse>;
}

// Provider names as each CLI's sign-in calls them; Gemini signs in with a Google account.
const providerLabels: Record<CliAccountRuntimeId, string> = {
  "cli:gemini": "Gemini",
  "cli:claude": "Claude",
  "cli:copilot": "GitHub",
  "cli:cursor": "Cursor",
  "cli:kimi": "Kimi",
};

const maxSuggestions = 8;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function RuntimeIcon({ runtimeId, className }: { runtimeId: CliAccountRuntimeId; className?: string }) {
  const presentation = cliRuntimePresentation(runtimeId);
  if (!presentation) return null;
  return (
    <img
      className={className ?? "cli-accounts-runtime-icon"}
      src={presentation.iconSrc}
      alt=""
      aria-hidden="true"
      data-cli-account-brand={presentation.brand}
      draggable={false}
    />
  );
}

export function CliAccountsPanel({ canManage, client }: { canManage: boolean; client: CliAccountsPanelClient }) {
  const [runtimeId, setRuntimeId] = useState<CliAccountRuntimeId>("cli:gemini");
  const [profiles, setProfiles] = useState<CliAccountProfile[] | null>(null);
  const [pending, setPending] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [removeConfirmation, setRemoveConfirmation] = useState<string | null>(null);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [detailsProfileId, setDetailsProfileId] = useState<string | null>(null);
  const [details, setDetails] = useState<CliAccountProfileDetailsResponse["details"] | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const identitiesLoader = client.cliAccountIdentities;
  const loader = useMemo(
    () => (identitiesLoader ? (refresh: boolean) => identitiesLoader(refresh) : undefined),
    [identitiesLoader],
  );
  const { quota, identities, load } = useCliAccountSignals(loader);

  useAutoDismiss(error, setError);
  useAutoDismiss(feedback, setFeedback);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (canManage) load();
    // The shared samples are read once when the panel opens; the refresh button re-reads them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage]);

  const loadProfiles = useCallback(async () => {
    if (!canManage || !client.listCliAccountProfiles) return;
    try {
      const result = await client.listCliAccountProfiles(runtimeId);
      if (mountedRef.current) setProfiles(result.profiles);
    } catch {
      if (mountedRef.current) setProfiles(null);
    }
  }, [canManage, client, runtimeId]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const clock = Math.floor(Date.now() / 30_000) * 30_000;
  const allIdentities = identities ?? [];
  const runtimeLabel = CLI_ACCOUNT_RUNTIME_LABELS[runtimeId];
  const providerLabel = providerLabels[runtimeId];

  const rows = useMemo(() => (profiles ?? []).map((profile) => {
    const identity = allIdentities.find((candidate) => candidate.runtimeId === runtimeId && candidate.profileId === profile.profileId) ?? null;
    return {
      profile,
      email: identity?.email ?? null,
      login: identity?.login ?? null,
      plan: cliAccountPlan(runtimeId, profile.profileId, quota),
      availability: cliAccountAvailability({ runtimeId, profileId: profile.profileId, quota, identity, clock }),
      linked: linkedProfiles(allIdentities, runtimeId, profile.profileId),
      duplicates: duplicateProfiles(allIdentities, runtimeId, profile.profileId),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [clock, identities, profiles, quota, runtimeId]);

  const tiles = useMemo(() => CLI_ACCOUNT_RUNTIME_IDS.map((tileRuntimeId) => {
    const accounts = allIdentities.filter((identity) => identity.runtimeId === tileRuntimeId);
    const availabilities = accounts.map((identity) => cliAccountAvailability({
      runtimeId: tileRuntimeId,
      profileId: identity.profileId,
      quota,
      identity,
      clock,
    }));
    return {
      runtimeId: tileRuntimeId,
      count: identities ? accounts.length : null,
      ready: availabilities.filter((availability) => availability.tone === "ready" || availability.tone === "neutral").length,
      availabilities,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [clock, identities, quota]);

  const suggestions = useMemo(
    () => (profiles ? accountSuggestions(allIdentities, runtimeId, profiles).slice(0, maxSuggestions) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identities, profiles, runtimeId],
  );
  const linkedEmailCount = useMemo(() => new Set(rows.filter((row) => row.linked.length).map((row) => row.email?.toLowerCase())).size, [rows]);

  function selectRuntime(next: CliAccountRuntimeId) {
    if (next === runtimeId) return;
    setRuntimeId(next);
    setProfiles(null);
    setAddOpen(false);
    setEditingProfileId(null);
    setRemoveConfirmation(null);
  }

  function afterProfilesChange() {
    dispatchCliAccountProfilesChange();
    load({ forceIdentities: true });
  }

  async function createProfile(displayName: string, source: "manual" | CliAccountSuggestion) {
    if (pending) return;
    const name = displayName.trim();
    if (!name) {
      setError("Account name is required.");
      return;
    }
    if (profiles?.some((profile) => sameAccountName(profile.displayName, name))) {
      setError(`${name} is already a ${runtimeLabel} account.`);
      return;
    }
    if (!client.createCliAccountProfile) {
      setError("Account profile controls are unavailable.");
      return;
    }
    const profileId = uniqueAccountProfileId(name, profiles?.map((profile) => profile.profileId) ?? []);
    setPending(true);
    setError(null);
    setFeedback(null);
    try {
      const result = await client.createCliAccountProfile({ runtimeId, profileId, displayName: name });
      setProfiles((current) => current
        ? [...current.filter((profile) => profile.profileId !== profileId), result.profile]
        : [result.profile]);
      setAddOpen(false);
      setNewName("");
      afterProfilesChange();
      setFeedback(source === "manual"
        ? `${name} added. Select it in a ${runtimeLabel} pane to complete sign-in.`
        : `${name} added from ${CLI_ACCOUNT_RUNTIME_LABELS[source.sources[0]!.runtimeId as CliAccountRuntimeId]}. Select it in a ${runtimeLabel} pane to sign in once.`);
    } catch (createError) {
      setError(errorMessage(createError, "Account profile could not be added."));
    } finally {
      setPending(false);
    }
  }

  async function removeProfile(profile: CliAccountProfile) {
    if (pending) return;
    if (!client.removeCliAccountProfile) {
      setError("Account profile controls are unavailable.");
      return;
    }
    setPending(true);
    setError(null);
    setFeedback(null);
    try {
      const result = await client.removeCliAccountProfile(runtimeId, profile.profileId);
      setRemoveConfirmation(null);
      if (result.removed) {
        setProfiles((current) => current?.filter((candidate) => candidate.profileId !== profile.profileId) ?? null);
        afterProfilesChange();
        setFeedback(`${profile.displayName} removed.`);
      } else {
        setFeedback(`${profile.displayName} was not found.`);
      }
    } catch (removeError) {
      setError(errorMessage(removeError, "Account profile could not be removed."));
    } finally {
      setPending(false);
    }
  }

  async function renameProfile(event: FormEvent<HTMLFormElement>, profile: CliAccountProfile) {
    event.preventDefault();
    if (pending) return;
    const displayName = editingName.trim();
    if (!displayName) {
      setError("Account name is required.");
      return;
    }
    if (profiles?.some((candidate) => candidate.profileId !== profile.profileId && sameAccountName(candidate.displayName, displayName))) {
      setError(`${displayName} is already a ${runtimeLabel} account.`);
      return;
    }
    if (!client.updateCliAccountProfile) {
      setError("Account rename is unavailable.");
      return;
    }
    setPending(true);
    setError(null);
    setFeedback(null);
    try {
      const result = await client.updateCliAccountProfile(runtimeId, profile.profileId, { displayName });
      setProfiles((current) => current?.map((candidate) => candidate.profileId === profile.profileId ? result.profile : candidate) ?? null);
      setEditingProfileId(null);
      afterProfilesChange();
      setFeedback(`${displayName} saved.`);
    } catch (renameError) {
      setError(errorMessage(renameError, "Account name could not be changed."));
    } finally {
      setPending(false);
    }
  }

  function closeDetails() {
    setDetailsProfileId(null);
    setDetails(null);
    setDetailsError(null);
  }

  async function toggleDetails(profile: CliAccountProfile) {
    if (detailsProfileId === profile.profileId) {
      closeDetails();
      return;
    }
    setDetailsProfileId(profile.profileId);
    setDetails({ runtimeId, profileId: profile.profileId, displayName: profile.displayName, email: null, authStatus: "UNAVAILABLE" });
    setDetailsError(null);
    setDetailsLoading(true);
    setError(null);
    try {
      const reader = client.getCliAccountProfileDetails ?? api.getCliAccountProfileDetails;
      const result = await reader(runtimeId, profile.profileId);
      if (mountedRef.current) setDetails(result.details);
    } catch (detailsLoadError) {
      if (mountedRef.current) setDetailsError(errorMessage(detailsLoadError, "Account details could not be loaded."));
    } finally {
      if (mountedRef.current) setDetailsLoading(false);
    }
  }

  const detailsRow = rows.find((row) => row.profile.profileId === detailsProfileId);
  const detailsModal = detailsProfileId && details && typeof document !== "undefined" ? createPortal(
    <div className="cli-account-details-modal" role="dialog" aria-modal="true" aria-label={`Account details for ${details.displayName}`} onClick={closeDetails}>
      <div className="cli-account-details-modal-body" onClick={(event) => event.stopPropagation()}>
        <div className="cli-account-details-modal-head">
          <strong>{providerLabel === "Gemini" ? "Google" : providerLabel} account details</strong>
          <button type="button" aria-label="Close account details" onClick={closeDetails}>
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="cli-account-profile-details" role="status">
          <span><strong>Name</strong> {details.displayName}</span>
          <span><strong>Email</strong> <span data-sensitive-masked={details.email ? "manual" : undefined}>{detailsLoading ? "Loading…" : details.email ?? "Not available"}</span></span>
          {details.login ? <span><strong>GitHub</strong> <span data-sensitive-masked="manual">@{details.login}</span></span> : null}
          <span>
            <strong>Status</strong>{" "}
            {detailsLoading
              ? "Checking…"
              : details.authStatus === "CONNECTED"
                ? "Connected"
                : details.authStatus === "NOT_CONNECTED"
                  ? "Not connected"
                  : "Unavailable"}
          </span>
          {detailsRow ? <span><strong>Availability</strong> {detailsRow.availability.description}</span> : null}
          {detailsRow?.linked.length ? (
            <span>
              <strong>Linked</strong>{" "}
              {detailsRow.linked.map((linked) => `${CLI_ACCOUNT_RUNTIME_LABELS[linked.runtimeId as CliAccountRuntimeId]} · ${linked.displayName}`).join(", ")}
            </span>
          ) : null}
          {detailsError ? <span className="cli-account-details-error" role="alert">{detailsError}</span> : null}
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <div className="cli-account-profiles cli-accounts-panel settings-flat-vpn" aria-label={`${providerLabel} account profiles`}>
      <div className="cli-accounts-provider-grid" role="tablist" aria-label="CLI account provider">
        {tiles.map((tile) => (
          <button
            key={tile.runtimeId}
            type="button"
            role="tab"
            aria-label={CLI_ACCOUNT_RUNTIME_LABELS[tile.runtimeId]}
            aria-selected={tile.runtimeId === runtimeId}
            className="cli-accounts-provider-tile"
            onClick={() => selectRuntime(tile.runtimeId)}
          >
            <span className="cli-accounts-provider-tile-head">
              <RuntimeIcon runtimeId={tile.runtimeId} />
              <strong>{CLI_ACCOUNT_RUNTIME_LABELS[tile.runtimeId].replace("GitHub ", "")}</strong>
            </span>
            <small>{tile.count == null ? "Accounts" : `${tile.ready}/${tile.count} available`}</small>
            <span className="cli-accounts-provider-strip" aria-hidden="true">
              {tile.availabilities.length
                ? tile.availabilities.map((availability, index) => (
                    <span key={index} style={accountColorStyle(availability)} data-tone={availability.tone} />
                  ))
                : <span data-tone="pending" />}
            </span>
          </button>
        ))}
      </div>

      <div className="cli-accounts-list-head">
        <span>
          <strong>{runtimeLabel} accounts</strong>
          <small>
            {profiles?.length ?? 0} {profiles?.length === 1 ? "account" : "accounts"}
            {linkedEmailCount ? ` · ${linkedEmailCount} linked by email` : ""}
          </small>
        </span>
        <button
          type="button"
          className="cli-account-profile-icon"
          aria-label="Refresh account status"
          title="Re-read sign-ins and quota"
          onClick={() => load({ refreshIdentities: true, forceQuota: true })}
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </div>

      {profiles === null ? (
        <small className="cli-account-profiles-note">Loading accounts…</small>
      ) : profiles.length === 0 ? (
        <small className="cli-account-profiles-note">No {runtimeLabel} accounts yet.</small>
      ) : (
        <ul className="cli-account-profiles-list cli-accounts-list">
          {rows.map((row) => (
            <AccountRow
              key={row.profile.profileId}
              row={row}
              pending={pending}
              editing={editingProfileId === row.profile.profileId}
              editingName={editingName}
              removeConfirmation={removeConfirmation === row.profile.profileId}
              detailsOpen={detailsProfileId === row.profile.profileId}
              detailsLoading={detailsLoading && detailsProfileId === row.profile.profileId}
              onEditingNameChange={setEditingName}
              onStartRename={() => {
                if (pending) return;
                setEditingProfileId(row.profile.profileId);
                setEditingName(row.profile.displayName);
                setRemoveConfirmation(null);
              }}
              onCancelRename={() => setEditingProfileId(null)}
              onRename={(event) => void renameProfile(event, row.profile)}
              onToggleDetails={() => void toggleDetails(row.profile)}
              onAskRemove={() => setRemoveConfirmation(row.profile.profileId)}
              onCancelRemove={() => setRemoveConfirmation(null)}
              onRemove={() => void removeProfile(row.profile)}
              onOpenLinked={(linkedRuntimeId) => selectRuntime(linkedRuntimeId)}
            />
          ))}
        </ul>
      )}

      {suggestions.length ? (
        <div className="cli-accounts-suggestions" aria-label={`Accounts from other CLIs to add to ${runtimeLabel}`}>
          <span className="cli-accounts-suggestions-title">
            <Link2 aria-hidden="true" />
            <span>
              <strong>Already set up in other CLIs</strong>
              <small>Add with one click; no need to enter them again.</small>
            </span>
          </span>
          <div className="cli-accounts-suggestion-chips">
            {suggestions.map((suggestion) => {
              const sourceRuntimes = [...new Set(suggestion.sources.map((source) => source.runtimeId as CliAccountRuntimeId))];
              return (
                <button
                  key={suggestion.key}
                  type="button"
                  className="cli-accounts-suggestion"
                  disabled={pending}
                  aria-label={`Add ${suggestion.displayName} to ${runtimeLabel}`}
                  title={`${suggestion.email ? `${suggestion.email} · ` : ""}Set up in ${sourceRuntimes.map((id) => CLI_ACCOUNT_RUNTIME_LABELS[id]).join(", ")}`}
                  onClick={() => void createProfile(suggestion.displayName, suggestion)}
                >
                  <Plus aria-hidden="true" />
                  <span>{suggestion.displayName}</span>
                  <span className="cli-accounts-suggestion-sources" aria-hidden="true">
                    {sourceRuntimes.map((sourceRuntimeId) => <RuntimeIcon key={sourceRuntimeId} runtimeId={sourceRuntimeId} />)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {addOpen ? (
        <form
          className="cli-account-profile-add"
          onSubmit={(event) => {
            event.preventDefault();
            void createProfile(newName, "manual");
          }}
        >
          <label className="settings-flat-row">
            <span className="settings-flat-row-copy">
              <strong>Account name</strong>
              <small>Shown in this list and in each pane, e.g. Work.</small>
            </span>
            <input
              autoFocus
              name="cli-account-display-name"
              value={newName}
              maxLength={80}
              disabled={pending}
              onChange={(event) => setNewName(event.currentTarget.value)}
            />
          </label>
          <div className="cli-account-profile-add-actions">
            <button type="button" disabled={pending} onClick={() => setAddOpen(false)}>Cancel</button>
            <button type="submit" disabled={pending}>
              {pending ? <Loader2 className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
              Add account
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="cli-account-profile-add-button"
          disabled={pending}
          onClick={() => {
            setAddOpen(true);
            setNewName("");
            setError(null);
            setFeedback(null);
          }}
        >
          <Plus aria-hidden="true" />
          Add account
        </button>
      )}

      {error ? <DockNotice className="cli-runtime-notice" onDismiss={() => setError(null)}>{error}</DockNotice> : null}
      {!readStoredSuppressNotifications() && feedback ? (
        <DockNotice tone="success" className="cli-runtime-notice" onDismiss={() => setFeedback(null)}>{feedback}</DockNotice>
      ) : null}

      <div className="cli-accounts-foot">
        <CliAccountColorLegend />
        <small className="cli-account-profiles-note">
          The main profile is the default account. Profiles signed in with the same email are linked across CLIs; each keeps its own native sign-in.
        </small>
      </div>
      {detailsModal}
    </div>
  );
}

interface AccountRowModel {
  profile: CliAccountProfile;
  email: string | null;
  login: string | null;
  plan: string | null;
  availability: CliAccountAvailability;
  linked: Array<{ runtimeId: string; profileId: string; displayName: string }>;
  duplicates: Array<{ runtimeId: string; profileId: string; displayName: string }>;
}

function AccountRow({
  row,
  pending,
  editing,
  editingName,
  removeConfirmation,
  detailsOpen,
  detailsLoading,
  onEditingNameChange,
  onStartRename,
  onCancelRename,
  onRename,
  onToggleDetails,
  onAskRemove,
  onCancelRemove,
  onRemove,
  onOpenLinked,
}: {
  row: AccountRowModel;
  pending: boolean;
  editing: boolean;
  editingName: string;
  removeConfirmation: boolean;
  detailsOpen: boolean;
  detailsLoading: boolean;
  onEditingNameChange: (value: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onRename: (event: FormEvent<HTMLFormElement>) => void;
  onToggleDetails: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
  onOpenLinked: (runtimeId: CliAccountRuntimeId) => void;
}) {
  const { profile, availability } = row;
  return (
    <li className="cli-account-profile-row cli-accounts-row" data-tone={availability.tone} style={accountColorStyle(availability)}>
      <CliAccountAvatar name={profile.displayName} availability={availability} />
      <div className="cli-accounts-row-main">
        {editing ? (
          <form className="cli-account-profile-rename" onSubmit={onRename}>
            <input
              autoFocus
              aria-label={`New name for ${profile.displayName}`}
              value={editingName}
              maxLength={80}
              disabled={pending}
              onChange={(event) => onEditingNameChange(event.currentTarget.value)}
            />
            <button type="submit" aria-label="Save account name" title="Save name" disabled={pending}>
              {pending ? <Loader2 className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
            </button>
            <button type="button" aria-label="Cancel account rename" title="Cancel" disabled={pending} onClick={onCancelRename}>
              <X aria-hidden="true" />
            </button>
          </form>
        ) : (
          <span className="cli-accounts-row-title">
            <strong>{profile.displayName}</strong>
            {row.plan ? <span className="cli-account-plan-badge" title={`Plan: ${row.plan}`}>{row.plan}</span> : null}
            {profile.profileId === "main" ? <span className="cli-accounts-default-chip">Default</span> : null}
            <span className="cli-accounts-row-status" title={availability.description}>{availability.label}</span>
          </span>
        )}
        <small className="cli-accounts-row-email" data-sensitive-masked={row.email || row.login ? "manual" : undefined}>
          {row.email ?? (row.login ? `@${row.login}` : availability.description)}
        </small>
        <CliAccountMeter availability={availability} />
        <div className="cli-accounts-row-foot">
          <span className="cli-accounts-row-links">
            {row.linked.length ? (
              <span className="cli-accounts-linked">
                <Link2 aria-hidden="true" />
                {row.linked.map((linked) => (
                  <button
                    key={`${linked.runtimeId}/${linked.profileId}`}
                    type="button"
                    className="cli-accounts-linked-chip"
                    aria-label={`Linked: ${linked.displayName} in ${CLI_ACCOUNT_RUNTIME_LABELS[linked.runtimeId as CliAccountRuntimeId]}`}
                    title={`Same email in ${CLI_ACCOUNT_RUNTIME_LABELS[linked.runtimeId as CliAccountRuntimeId]} as ${linked.displayName}`}
                    onClick={() => onOpenLinked(linked.runtimeId as CliAccountRuntimeId)}
                  >
                    <RuntimeIcon runtimeId={linked.runtimeId as CliAccountRuntimeId} />
                  </button>
                ))}
              </span>
            ) : null}
            {row.duplicates.length ? (
              <span className="cli-accounts-duplicate" title="Two profiles of this CLI are signed in with the same email.">
                <AlertTriangle aria-hidden="true" />
                Same email as {row.duplicates.map((duplicate) => duplicate.displayName).join(", ")}
              </span>
            ) : null}
          </span>
          <div className="cli-account-profile-actions">
            <button
              type="button"
              className="cli-account-profile-icon"
              aria-label={`Rename ${profile.displayName}`}
              title="Rename account"
              disabled={pending || editing}
              onClick={onStartRename}
            >
              <Pencil aria-hidden="true" />
            </button>
            <button
              type="button"
              className="cli-account-profile-icon"
              aria-label={`Show details for ${profile.displayName}`}
              title="Account details"
              aria-expanded={detailsOpen}
              disabled={detailsLoading}
              onClick={onToggleDetails}
            >
              {detailsLoading ? <Loader2 className="spin" aria-hidden="true" /> : <CircleHelp aria-hidden="true" />}
            </button>
            {profile.profileId !== "main" ? (
              removeConfirmation ? (
                <span className="cli-account-profile-remove-confirm">
                  <button type="button" disabled={pending} onClick={onCancelRemove}>Cancel</button>
                  <button type="button" className="is-danger" disabled={pending} onClick={onRemove}>Remove</button>
                </span>
              ) : (
                <button
                  type="button"
                  className="cli-account-profile-remove"
                  aria-label={`Remove ${profile.displayName}`}
                  title="Remove account"
                  disabled={pending}
                  onClick={onAskRemove}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              )
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}
