import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { jobApplyMailboxConnected, type Artifact, type ConnectorCapability, type JobApplyCandidate, type JobApplyPaneMetadata, type JobApplyPostalAddress, type JobApplyProfile, type JobApplySite, type JobCopilotLaunchSettings, type Pane } from "@space/contracts";
import { api } from "../../api.js";
import { BROWSER_PANE_ACCOUNT_SELECTED_EVENT, dispatchBrowserPaneActionEvent } from "../browser-pane/events.js";
import { GoogleAccountMenuItems } from "../browser-pane/GoogleAccountMenuItems.js";
import type { YouTubeAccounts } from "../browser-pane/youtube-accounts.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { Check, Plus, Trash2 } from "../ui-theme/app-icons.js";
import { AgentAccountField, useJobCopilotAccounts } from "./AgentAccountField.js";
import { jobCopilotAgentLabel, loadPaneAccountProfileId, type JobCopilotRuntimeOption } from "./agent-runtimes.js";

export type SetupStep = "profile" | "mailbox" | "limits" | "agent";
const STEPS: Array<{ id: SetupStep; label: string }> = [
  { id: "profile", label: "CV & profile" }, { id: "mailbox", label: "Google account" }, { id: "limits", label: "Limits" }, { id: "agent", label: "Agent" }
];
const GOOGLE_ACCESS: Array<{ capability: ConnectorCapability; label: string }> = [
  { capability: "MAIL_READ", label: "Read email: codes, links, recruiter replies" },
  { capability: "MAIL_COMPOSE", label: "Draft replies (you send them from Gmail)" },
  { capability: "CALENDAR", label: "Calendar: busy times and interviews" },
  { capability: "MAIL_ORGANIZE", label: "Organize mail: file application emails under Job Applications labels and archive receipts" }
];

/** Google consent for the copilot's account: Gmail read, drafts and labels plus Calendar, returning to this tab with a Job Copilot notice. */
export function jobCopilotGoogleConsentUrl(email: string): string {
  return `/api/connectors/google/start?${new URLSearchParams({ capabilities: GOOGLE_ACCESS.map(({ capability }) => capability).join(","), loginHint: email, source: "job-copilot" })}`;
}
const SITES: JobApplySite[] = ["linkedin", "greenhouse", "ashby", "lever", "workday", "indeed", "other"];
const SITE_LABEL: Record<JobApplySite, string> = { linkedin: "LinkedIn", greenhouse: "Greenhouse", ashby: "Ashby", lever: "Lever", workday: "Workday", indeed: "Indeed", other: "Other" };

const EMPTY_ADDRESS: JobApplyPostalAddress = { line1: null, line2: null, city: null, region: null, postalCode: null, country: null };

/** Facts the copilot needs before it can answer forms truthfully; the meter counts these. */
export const PROFILE_COMPLETENESS_FIELDS: Array<keyof JobApplyCandidate> = [
  "fullName", "email", "phone", "location", "country", "linkedinUrl", "headline", "summary", "workAuthorization", "needsSponsorship",
  "willingToRelocate", "salaryExpectation", "noticePeriod", "yearsOfExperience", "skills", "experience", "education"
];

export function profileCompleteness(profile: JobApplyProfile | null): { filled: number; total: number; percent: number } {
  const total = PROFILE_COMPLETENESS_FIELDS.length + 1;
  if (!profile) return { filled: 0, total, percent: 0 };
  let filled = profile.cvArtifactId && profile.cvTextChars > 0 ? 1 : 0;
  for (const key of PROFILE_COMPLETENESS_FIELDS) {
    const value = profile.candidate[key];
    if (Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== "") filled += 1;
  }
  return { filled, total, percent: Math.round((filled / total) * 100) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}

function artifactName(artifact: Artifact): string {
  const original = artifact.metadata.originalFilename;
  if (typeof original === "string" && original) return original;
  return artifact.storageUri.split("/").pop() ?? artifact.id;
}

function listText(values: string[]): string {
  return values.join(", ");
}
function parseList(text: string): string[] {
  return text.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 100);
}

export function SetupWizard({ pane, profile, settings, runtimeOptions, switching = false, accountRevision = 0, footer = null, onProfileChange, onSettingsChange, onSwitchAgent, onSetDefault }: {
  pane: Pane;
  profile: JobApplyProfile;
  settings: JobApplyPaneMetadata;
  runtimeOptions: JobCopilotRuntimeOption[];
  /** The pane's agent is being switched (its CLI restarts). */
  switching?: boolean;
  /** Changes after each agent switch, so the Agent step reloads the pane's account. */
  accountRevision?: number;
  /** Shown at the end of the last step, Agent (Start over). */
  footer?: ReactNode;
  onProfileChange(profile: JobApplyProfile): void;
  onSettingsChange(settings: JobApplyPaneMetadata): void;
  /** Switch this pane's CLI, or its account (the CLI restarts on it). */
  onSwitchAgent(runtimeId: string, accountProfileId?: string): void;
  /** New Job Copilot panes open with this pane's agent and account. */
  onSetDefault(): void;
}) {
  const [step, setStep] = useState<SetupStep>(() => !profile.cvArtifactId || !profile.candidate.fullName ? "profile" : !jobApplyMailboxConnected(profile) ? "mailbox" : "limits");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<Artifact[]>([]);
  const [cvArtifactId, setCvArtifactId] = useState(profile.cvArtifactId ?? "");
  const [coverLetterArtifactId, setCoverLetterArtifactId] = useState(profile.coverLetterArtifactId ?? "");
  const [candidate, setCandidate] = useState<JobApplyCandidate>(profile.candidate);
  const [mailbox, setMailbox] = useState({ host: profile.mailbox?.host ?? "imap.gmail.com", port: profile.mailbox?.port ?? 993, secure: profile.mailbox?.secure ?? true, user: profile.mailbox?.user ?? "", password: "" });
  const [draft, setDraft] = useState<JobApplyPaneMetadata>(settings);
  const completeness = useMemo(() => profileCompleteness(profile), [profile]);
  const [launch, setLaunch] = useState<JobCopilotLaunchSettings | null>(null);
  const [googleAccounts, setGoogleAccounts] = useState<YouTubeAccounts | null>(null);
  const [googleAccountsError, setGoogleAccountsError] = useState<string | null>(null);
  const [choosingAccount, setChoosingAccount] = useState(false);
  const choosingTimer = useRef<number | null>(null);

  // The same accounts as the pane browser's Google account menu; reloaded whenever the pane switches accounts.
  const loadGoogleAccounts = useCallback(() => {
    api.browserAccounts(pane.id).then((accounts) => { setGoogleAccounts(accounts); setGoogleAccountsError(null); })
      .catch((error: unknown) => setGoogleAccountsError(errorText(error)));
  }, [pane.id]);
  useEffect(() => { if (step === "mailbox") loadGoogleAccounts(); }, [loadGoogleAccounts, step]);
  const runtimeId = pane.terminalRuntimeId ?? null;
  const runtimeOption = runtimeOptions.find((option) => option.runtime.id === runtimeId) ?? null;
  const runtimeLabel = runtimeId ? jobCopilotAgentLabel(runtimeId, runtimeOption?.runtime) : "";
  const accounts = useJobCopilotAccounts(step === "agent" ? runtimeId : null);
  const [paneAccount, setPaneAccount] = useState<string | null>(null);
  // The Agent step shows the saved default and the account this pane's CLI runs on now (the terminal's account menu changes it too).
  useEffect(() => {
    if (step !== "agent") return;
    let cancelled = false;
    api.userSettings().then((userSettings) => { if (!cancelled) setLaunch(userSettings.jobCopilot ?? null); }).catch(() => undefined);
    void loadPaneAccountProfileId(pane.id, runtimeId).then((accountProfileId) => { if (!cancelled) setPaneAccount(accountProfileId); });
    return () => { cancelled = true; };
  }, [accountRevision, pane.id, runtimeId, step]);
  const isDefault = Boolean(launch && !launch.askOnLaunch && runtimeId && launch.runtimeId === runtimeId && (launch.accountProfileId ?? null) === paneAccount);
  useEffect(() => {
    function accountSelected(event: Event) {
      if ((event as CustomEvent<{ paneId?: string }>).detail?.paneId !== pane.id) return;
      if (choosingTimer.current !== null) window.clearTimeout(choosingTimer.current);
      setChoosingAccount(false);
      loadGoogleAccounts();
      // The API made the chosen account the copilot's Google account; show its access.
      api.jobApplyProfile().then((response) => onProfileChange(response.profile)).catch(() => undefined);
    }
    window.addEventListener(BROWSER_PANE_ACCOUNT_SELECTED_EVENT, accountSelected);
    return () => {
      window.removeEventListener(BROWSER_PANE_ACCOUNT_SELECTED_EVENT, accountSelected);
      if (choosingTimer.current !== null) window.clearTimeout(choosingTimer.current);
    };
  }, [loadGoogleAccounts, onProfileChange, pane.id]);

  // Every Google account the operator could allow: the pane browser's account first, then those already allowed, then the menu's others.
  const mailAccountEmails = useMemo(() => [...new Set([
    ...(profile.google ? [profile.google.email] : []),
    ...profile.googleAccounts.map((account) => account.email),
    ...(googleAccounts?.profiles ?? []).flatMap((entry) => entry.email ? [entry.email.trim().toLowerCase()] : [])
  ])], [googleAccounts, profile.google, profile.googleAccounts]);

  /** The pane browser opens the account (it owns the session restart and the Google sign-in); the API then names it the copilot's account. */
  function chooseGoogleAccount(profileId: string, signIn = false) {
    setMessage(null);
    setChoosingAccount(true);
    if (choosingTimer.current !== null) window.clearTimeout(choosingTimer.current);
    choosingTimer.current = window.setTimeout(() => {
      setChoosingAccount(false);
      setMessage("The pane browser did not switch accounts. Try again once it has finished loading.");
    }, 30_000);
    dispatchBrowserPaneActionEvent({ paneId: pane.id, roomId: pane.roomId, action: "account", profileId, signIn });
  }

  useEffect(() => { setDraft(settings); }, [settings]);

  useEffect(() => {
    let cancelled = false;
    api.artifacts({ roomId: pane.roomId, collection: "AGENT_FILES", pageSize: 100, sortOrder: "desc" })
      .then((page) => { if (!cancelled) setFiles(page.data.filter((artifact) => !artifact.deletedAt)); })
      .catch(() => { if (!cancelled) setFiles([]); });
    return () => { cancelled = true; };
  }, [pane.roomId]);

  async function run(label: string, action: () => Promise<string | void>) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await action();
      setMessage(result ?? `${label} saved.`);
    } catch (error) {
      setMessage(`${label}: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }

  const readCv = () => run("CV", async () => {
    if (!cvArtifactId) throw new Error("Choose a CV from Agent Files first.");
    const result = await api.importJobApplyCv({ artifactId: cvArtifactId });
    onProfileChange(result.profile);
    return `CV read (${result.coverage.toLowerCase()}): ${result.textPreview.slice(0, 160)}…`;
  });

  const saveCandidate = (event: FormEvent) => {
    event.preventDefault();
    void run("Profile", async () => {
      const response = await api.updateJobApplyProfile({ candidate, coverLetterArtifactId: coverLetterArtifactId || null });
      onProfileChange(response.profile);
    });
  };

  const connectMailbox = (event: FormEvent) => {
    event.preventDefault();
    void run("Mailbox", async () => {
      const response = await api.setJobApplyMailbox(mailbox);
      onProfileChange(response.profile);
      setMailbox((current) => ({ ...current, password: "" }));
      return "Mailbox connected and verified.";
    });
  };

  const testMailbox = () => run("Mailbox test", async () => {
    const result = await api.testJobApplyMailbox();
    return `Mailbox reachable. Latest: ${result.recent.map((entry) => entry.subject || entry.from).slice(0, 2).join(" · ") || "no mail"}`;
  });

  const disconnectMailbox = () => run("Mailbox", async () => {
    const response = await api.clearJobApplyMailbox();
    onProfileChange(response.profile);
    return "Mailbox disconnected.";
  });

  const saveSettings = (event: FormEvent) => {
    event.preventDefault();
    void run("Limits", async () => {
      const response = await api.updateJobApplySettings(pane.id, draft);
      onSettingsChange(response.metadata);
    });
  };

  const text = (key: keyof JobApplyCandidate, label: string, type = "text") => (
    <label className="jc-field">
      <span>{label}</span>
      <input type={type} value={(candidate[key] as string | null) ?? ""} onChange={(event) => setCandidate({ ...candidate, [key]: event.target.value || null })} />
    </label>
  );

  const address: JobApplyPostalAddress = candidate.address ?? EMPTY_ADDRESS;
  // An address with every field cleared is stored as no address.
  const addressText = (key: keyof JobApplyPostalAddress, label: string) => (
    <label className="jc-field">
      <span>{label}</span>
      <input value={address[key] ?? ""} onChange={(event) => {
        const next = { ...address, [key]: event.target.value || null };
        setCandidate({ ...candidate, address: Object.values(next).some(Boolean) ? next : null });
      }} />
    </label>
  );

  const stepDone: Record<SetupStep, boolean> = {
    profile: Boolean(profile.cvArtifactId && profile.candidate.fullName && profile.candidate.email),
    mailbox: jobApplyMailboxConnected(profile),
    limits: true,
    agent: Boolean(pane.terminalRuntimeId)
  };

  return (
    <div className="jc-setup" role="tabpanel" id="jc-panel-setup" aria-labelledby="jc-tab-setup">
      <nav className="jc-steps" aria-label="Setup steps">
        {STEPS.map(({ id, label }, index) => (
          <button key={id} type="button" className={`jc-step${step === id ? " selected" : ""}${stepDone[id] ? " done" : ""}`} aria-current={step === id ? "step" : undefined} onClick={() => setStep(id)}>
            <span className="jc-step-index" aria-hidden="true">{stepDone[id] ? <Check /> : index + 1}</span>
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="jc-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={completeness.percent} aria-label="Profile completeness">
        <span className="jc-meter-bar" style={{ width: `${completeness.percent}%` }} />
        <span className="jc-meter-label">Profile {completeness.percent}% complete · {completeness.filled}/{completeness.total} facts</span>
      </div>

      {step === "profile" ? (
        <form className="jc-form" onSubmit={saveCandidate}>
          <section className="jc-form-section">
            <h4>CV</h4>
            <label className="jc-field">
              <span>CV file (Agent Files)</span>
              <select value={cvArtifactId} onChange={(event) => setCvArtifactId(event.target.value)}>
                <option value="">Choose a file…</option>
                {files.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifactName(artifact)}</option>)}
              </select>
            </label>
            <div className="jc-actions">
              <button type="button" className="jc-button" disabled={busy || !cvArtifactId} onClick={() => void readCv()}>Read CV</button>
              <span className="jc-muted">{profile.cvTextChars > 0 ? `${profile.cvTextChars.toLocaleString()} characters read` : "Not read yet. The copilot answers experience questions from this text."}</span>
            </div>
            <label className="jc-field">
              <span>Cover letter template (optional)</span>
              <select value={coverLetterArtifactId} onChange={(event) => setCoverLetterArtifactId(event.target.value)}>
                <option value="">None</option>
                {files.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifactName(artifact)}</option>)}
              </select>
            </label>
          </section>
          <section className="jc-form-section">
            <h4>Identity</h4>
            <div className="jc-form-grid">
              {text("fullName", "Full name")}
              {text("email", "Email", "email")}
              {text("phone", "Phone")}
              {text("location", "Location")}
              {text("country", "Country")}
              {text("linkedinUrl", "LinkedIn URL", "url")}
              {text("githubUrl", "GitHub URL", "url")}
              {text("websiteUrl", "Website", "url")}
            </div>
            {text("headline", "Headline")}
            <label className="jc-field">
              <span>Summary</span>
              <textarea rows={3} value={candidate.summary ?? ""} onChange={(event) => setCandidate({ ...candidate, summary: event.target.value || null })} />
            </label>
          </section>
          <section className="jc-form-section">
            <h4>Postal address</h4>
            <p className="jc-muted">Used only for application forms that require it.</p>
            <div className="jc-form-grid">
              {addressText("line1", "Street address")}
              {addressText("line2", "Address line 2")}
              {addressText("city", "City")}
              {addressText("region", "State / province")}
              {addressText("postalCode", "Postal code")}
              {addressText("country", "Country")}
            </div>
          </section>
          <section className="jc-form-section">
            <h4>Eligibility and expectations</h4>
            <div className="jc-form-grid">
              {text("workAuthorization", "Work authorization")}
              {text("salaryExpectation", "Salary expectation")}
              {text("noticePeriod", "Notice period")}
              <label className="jc-field">
                <span>Years of experience</span>
                <input type="number" min={0} max={80} value={candidate.yearsOfExperience ?? ""} onChange={(event) => setCandidate({ ...candidate, yearsOfExperience: event.target.value === "" ? null : Math.max(0, Math.min(80, Number.parseInt(event.target.value, 10) || 0)) })} />
              </label>
            </div>
            <div className="jc-form-grid">
              <SpaceToggle label="Needs visa sponsorship" checked={candidate.needsSponsorship === true} onChange={(checked) => setCandidate({ ...candidate, needsSponsorship: checked })} />
              <SpaceToggle label="Willing to relocate" checked={candidate.willingToRelocate === true} onChange={(checked) => setCandidate({ ...candidate, willingToRelocate: checked })} />
            </div>
            <label className="jc-field"><span>Skills (comma separated)</span><input value={listText(candidate.skills)} onChange={(event) => setCandidate({ ...candidate, skills: parseList(event.target.value) })} /></label>
            <label className="jc-field"><span>Languages (comma separated)</span><input value={listText(candidate.languages)} onChange={(event) => setCandidate({ ...candidate, languages: parseList(event.target.value) })} /></label>
          </section>
          <section className="jc-form-section">
            <h4>Experience</h4>
            {candidate.experience.map((entry, index) => (
              <div key={index} className="jc-card">
                <div className="jc-form-grid">
                  <label className="jc-field"><span>Company</span><input value={entry.company} onChange={(event) => setCandidate({ ...candidate, experience: candidate.experience.map((item, i) => i === index ? { ...item, company: event.target.value } : item) })} /></label>
                  <label className="jc-field"><span>Title</span><input value={entry.title} onChange={(event) => setCandidate({ ...candidate, experience: candidate.experience.map((item, i) => i === index ? { ...item, title: event.target.value } : item) })} /></label>
                  <label className="jc-field"><span>Start</span><input value={entry.start ?? ""} placeholder="2021-03" onChange={(event) => setCandidate({ ...candidate, experience: candidate.experience.map((item, i) => i === index ? { ...item, start: event.target.value || null } : item) })} /></label>
                  <label className="jc-field"><span>End</span><input value={entry.end ?? ""} placeholder="present" onChange={(event) => setCandidate({ ...candidate, experience: candidate.experience.map((item, i) => i === index ? { ...item, end: event.target.value || null } : item) })} /></label>
                </div>
                <label className="jc-field"><span>Summary</span><textarea rows={2} value={entry.summary} onChange={(event) => setCandidate({ ...candidate, experience: candidate.experience.map((item, i) => i === index ? { ...item, summary: event.target.value } : item) })} /></label>
                <button type="button" className="jc-button ghost danger" aria-label={`Remove experience ${entry.company || index + 1}`} onClick={() => setCandidate({ ...candidate, experience: candidate.experience.filter((_, i) => i !== index) })}><Trash2 aria-hidden="true" /> Remove</button>
              </div>
            ))}
            <button type="button" className="jc-button ghost" disabled={candidate.experience.length >= 40} onClick={() => setCandidate({ ...candidate, experience: [...candidate.experience, { company: "", title: "", start: null, end: null, summary: "" }] })}><Plus aria-hidden="true" /> Add experience</button>
          </section>
          <section className="jc-form-section">
            <h4>Education</h4>
            {candidate.education.map((entry, index) => (
              <div key={index} className="jc-card">
                <div className="jc-form-grid">
                  <label className="jc-field"><span>School</span><input value={entry.school} onChange={(event) => setCandidate({ ...candidate, education: candidate.education.map((item, i) => i === index ? { ...item, school: event.target.value } : item) })} /></label>
                  <label className="jc-field"><span>Degree</span><input value={entry.degree} onChange={(event) => setCandidate({ ...candidate, education: candidate.education.map((item, i) => i === index ? { ...item, degree: event.target.value } : item) })} /></label>
                  <label className="jc-field"><span>Field</span><input value={entry.field} onChange={(event) => setCandidate({ ...candidate, education: candidate.education.map((item, i) => i === index ? { ...item, field: event.target.value } : item) })} /></label>
                  <label className="jc-field"><span>Years</span><input value={[entry.start ?? "", entry.end ?? ""].filter(Boolean).join(" – ")} placeholder="2012 – 2016" onChange={(event) => { const [start, end] = event.target.value.split(/\s*[–-]\s*/); setCandidate({ ...candidate, education: candidate.education.map((item, i) => i === index ? { ...item, start: start || null, end: end || null } : item) }); }} /></label>
                </div>
                <button type="button" className="jc-button ghost danger" aria-label={`Remove education ${entry.school || index + 1}`} onClick={() => setCandidate({ ...candidate, education: candidate.education.filter((_, i) => i !== index) })}><Trash2 aria-hidden="true" /> Remove</button>
              </div>
            ))}
            <button type="button" className="jc-button ghost" disabled={candidate.education.length >= 20} onClick={() => setCandidate({ ...candidate, education: [...candidate.education, { school: "", degree: "", field: "", start: null, end: null }] })}><Plus aria-hidden="true" /> Add education</button>
          </section>
          <div className="jc-actions sticky"><button type="submit" className="jc-button primary" disabled={busy}>Save profile</button></div>
        </form>
      ) : null}

      {step === "mailbox" ? (
        <div className="jc-form">
          <section className="jc-google" aria-label="Google account">
            <p className="jc-muted">Choose the Google account Job Copilot works with. The pane browser opens it, so “Sign in with Google” on job boards uses it. With Gmail &amp; Calendar allowed, the copilot also reads verification codes and recruiter mail, drafts replies for you and keeps your calendar.</p>
            {googleAccounts?.profiles.length ? (
              <div className="jc-account-list" role="menu" aria-label="Google accounts for Job Copilot" aria-busy={choosingAccount || undefined}>
                <GoogleAccountMenuItems accounts={googleAccounts} onSelect={(profileId) => chooseGoogleAccount(profileId)} onSignIn={(profileId) => chooseGoogleAccount(profileId, true)} />
              </div>
            ) : (
              <p className="jc-muted" role="status">{googleAccountsError ?? (googleAccounts ? "No Google accounts yet. Link one in Settings → Google accounts." : "Loading Google accounts…")}</p>
            )}
            {choosingAccount ? <p className="jc-muted" role="status">Opening the Google account in the pane browser…</p> : null}
            <h4 className="jc-google-heading">Mail &amp; calendar access</h4>
            <p className="jc-muted">The copilot reads codes, links and recruiter mail from every account below that allowed Gmail. Drafts and calendar events use the pane browser's account unless the copilot names another.</p>
            {mailAccountEmails.length ? mailAccountEmails.map((email) => {
              const capabilities = profile.googleAccounts.find((account) => account.email === email)?.capabilities ?? [];
              const missing = GOOGLE_ACCESS.some(({ capability }) => !capabilities.includes(capability));
              return (
                <div key={email} className="jc-google-access" aria-label={`Google access for ${email}`}>
                  <div className="jc-google-access-head">
                    <strong>{email}</strong>
                    {email === profile.google?.email ? <span className="jc-tag accent">Pane browser</span> : null}
                  </div>
                  <ul>
                    {GOOGLE_ACCESS.map(({ capability, label }) => {
                      const granted = capabilities.includes(capability);
                      return <li key={capability} data-granted={granted ? "true" : "false"}>{granted ? <Check aria-hidden="true" /> : <span aria-hidden="true" />}<span>{label}{granted ? "" : " · not allowed yet"}</span></li>;
                    })}
                  </ul>
                  {profile.googleAvailable && missing ? <div className="jc-actions"><a className="jc-button primary" href={jobCopilotGoogleConsentUrl(email)}>Allow Gmail &amp; Calendar</a></div> : null}
                </div>
              );
            }) : <p className="jc-muted">No Google account yet. Link one in Settings → Google accounts, or sign in to one in the pane browser.</p>}
            <div className="jc-actions">
              <button type="button" className="jc-button" disabled={busy || !jobApplyMailboxConnected(profile)} onClick={() => void testMailbox()}>Test mail</button>
            </div>
            {profile.googleAvailable ? (
              <details className="jc-help">
                <summary>Google says “Access blocked”?</summary>
                <p>While the server's Google Cloud app is in Testing, only its test users can allow access. In Google Cloud Console open Google Auth Platform → Audience and add the account under Test users, or publish the app. Enable the Gmail API and Google Calendar API for the same project. Access allowed in Testing ends after seven days; Job Copilot then asks you to allow it again.</p>
              </details>
            ) : <p className="jc-muted">Google sign-in is not configured on this server, so Gmail and Calendar cannot be allowed here. Use an IMAP mailbox below for verification codes.</p>}
          </section>
          <details className="jc-imap" open={Boolean(profile.mailbox) || undefined}>
            <summary>{profile.mailbox ? `IMAP mailbox · ${profile.mailbox.user}` : "Use an IMAP mailbox instead"}</summary>
            <form className="jc-form" onSubmit={connectMailbox}>
              <p className="jc-muted">Without Gmail access the copilot reads verification codes and confirmation links from this mailbox. The app password is sealed on the server and never shown again.</p>
              <div className="jc-form-grid">
                <label className="jc-field"><span>IMAP host</span><input value={mailbox.host} onChange={(event) => setMailbox({ ...mailbox, host: event.target.value })} required /></label>
                <label className="jc-field"><span>Port</span><input type="number" min={1} max={65535} value={mailbox.port} onChange={(event) => setMailbox({ ...mailbox, port: Number.parseInt(event.target.value, 10) || 993 })} /></label>
              </div>
              <SpaceToggle label="TLS" checked={mailbox.secure} onChange={(checked) => setMailbox({ ...mailbox, secure: checked })} />
              <label className="jc-field"><span>Email address</span><input type="email" value={mailbox.user} onChange={(event) => setMailbox({ ...mailbox, user: event.target.value })} required /></label>
              <label className="jc-field"><span>App password</span><input type="password" autoComplete="off" value={mailbox.password} onChange={(event) => setMailbox({ ...mailbox, password: event.target.value })} required /></label>
              <div className="jc-actions">
                <button type="submit" className="jc-button primary" disabled={busy}>Connect</button>
                <button type="button" className="jc-button" disabled={busy || !profile.mailbox} onClick={() => void testMailbox()}>Test</button>
                <button type="button" className="jc-button ghost danger" disabled={busy || !profile.mailbox} onClick={() => void disconnectMailbox()}>Disconnect</button>
                <span className="jc-muted">{profile.mailbox ? `Connected as ${profile.mailbox.user}` : "Not connected"}</span>
              </div>
            </form>
          </details>
        </div>
      ) : null}

      {step === "limits" ? (
        <form className="jc-form" onSubmit={saveSettings}>
          <label className="jc-field">
            <span>Submit mode</span>
            <select value={draft.settings.submitMode} onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, submitMode: event.target.value as "AUTO" | "REVIEW" } })}>
              <option value="AUTO">Automatic: the copilot submits and verifies</option>
              <option value="REVIEW">Review: the copilot stops before Submit and asks you</option>
            </select>
          </label>
          <fieldset className="jc-caps">
            <legend>Daily caps per site</legend>
            {SITES.map((site) => (
              <label key={site} className="jc-field">
                <span>{SITE_LABEL[site]}</span>
                <input type="number" min={0} max={500} value={draft.settings.dailyCaps[site]} onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, dailyCaps: { ...draft.settings.dailyCaps, [site]: Math.max(0, Math.min(500, Number.parseInt(event.target.value, 10) || 0)) } } })} />
              </label>
            ))}
          </fieldset>
          <div className="jc-form-grid">
            <label className="jc-field"><span>Minimum spacing (seconds)</span><input type="number" min={0} max={3600} value={Math.round(draft.settings.minDelayMs / 1000)} onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, minDelayMs: Math.max(0, (Number.parseInt(event.target.value, 10) || 0) * 1000) } })} /></label>
            <label className="jc-field"><span>Maximum spacing (seconds)</span><input type="number" min={0} max={3600} value={Math.round(draft.settings.maxDelayMs / 1000)} onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, maxDelayMs: Math.max(0, (Number.parseInt(event.target.value, 10) || 0) * 1000) } })} /></label>
          </div>
          <SpaceToggle label="Paused" detail="The copilot does not start new applications while paused." checked={draft.settings.paused} onChange={(checked) => setDraft({ ...draft, settings: { ...draft.settings, paused: checked } })} />
          <div className="jc-actions"><button type="submit" className="jc-button primary" disabled={busy}>Save limits</button></div>
        </form>
      ) : null}

      {step === "agent" ? (
        <div className="jc-form">
          <label className="jc-field">
            <span>Copilot agent</span>
            <select value={runtimeId ?? ""} disabled={switching} onChange={(event) => {
              const next = event.target.value;
              if (next && next !== runtimeId) onSwitchAgent(next);
            }}>
              {!runtimeId ? <option value="">Choose a CLI…</option> : null}
              {runtimeOptions.map(({ runtime, ready, recommended }) => (
                <option key={runtime.id} value={runtime.id} disabled={!ready}>{runtime.displayName}{recommended ? " (recommended)" : ""}{ready ? "" : ` — ${runtime.statusReason}`}</option>
              ))}
            </select>
          </label>
          {runtimeId ? (
            <AgentAccountField runtimeId={runtimeId} runtimeLabel={runtimeLabel} accounts={accounts} value={paneAccount} disabled={switching}
              onChange={(profileId) => onSwitchAgent(runtimeId, profileId)} />
          ) : null}
          <p className="jc-muted">Switching the agent or its account restarts this pane's CLI session. Claude Code is recommended for long, tool-heavy application loops.</p>
          <div className="jc-default-agent">
            <p className="jc-muted" role="status">
              {launch && !launch.askOnLaunch
                ? `New Job Copilot panes open with ${jobCopilotAgentLabel(launch.runtimeId, runtimeOptions.find((option) => option.runtime.id === launch.runtimeId)?.runtime)}${launch.accountProfileId ? ` (${launch.accountProfileId} account)` : ""} without asking.`
                : "New Job Copilot panes ask which agent to use."} Change it in Settings → Job Copilot.
            </p>
            <button type="button" className="jc-button" disabled={!runtimeId || switching || isDefault} onClick={() => {
              onSetDefault();
              if (runtimeId) setLaunch({ runtimeId, accountProfileId: paneAccount, askOnLaunch: false });
            }}>{isDefault ? "This is your default agent" : "Set as default"}</button>
          </div>
          <p className="jc-muted">Handoff, question and review alerts arrive as Space notifications: toasts, sound, desktop and Telegram follow Settings → Notifications.</p>
          <SpaceToggle label="Telegram alerts" detail="Needs-you moments and run summaries go to the paired Telegram bot (Settings → Telegram)." checked={settings.settings.notifications.telegram}
            onChange={(checked) => void run("Telegram alerts", async () => {
              const response = await api.updateJobApplySettings(pane.id, { ...settings, settings: { ...settings.settings, notifications: { ...settings.settings.notifications, telegram: checked } } });
              onSettingsChange(response.metadata);
            })} />
          {footer}
        </div>
      ) : null}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
    </div>
  );
}
