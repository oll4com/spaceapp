import { useState } from "react";
import { MARKETING_CAMPAIGN_TEMPLATES, MARKETING_CHANNEL_DEFAULT_FORMAT, MARKETING_CHANNEL_LABELS, marketingWordingIssues, type MarketingCampaign, type MarketingPost, type MarketingPostStatus } from "@space/contracts";
import { api } from "../../api.js";
import { Check, ExternalLink, Rocket, RotateCcw, Send, Undo2, X } from "../ui-theme/app-icons.js";
import { modeIcons } from "../pane-card/pane-mode-icons.js";

const DesignIcon = modeIcons.DESIGN;

/** The order the groups show in: what waits for the operator first. */
const GROUPS: Array<{ status: MarketingPostStatus; label: string }> = [
  { status: "IN_REVIEW", label: "Needs your review" }, { status: "FAILED", label: "Failed" }, { status: "APPROVED", label: "Approved and scheduled" },
  { status: "PUBLISHING", label: "Publishing" }, { status: "DRAFT", label: "Drafts" }, { status: "PUBLISHED", label: "Published" }, { status: "REJECTED", label: "Rejected" }
];
/** Character limits the operator should see while editing (X counts 280; LinkedIn posts 3000). */
const CHARACTER_LIMIT: Partial<Record<MarketingPost["channel"], number>> = { X: 280, LINKEDIN: 3000 };

export function localInputValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}

function PostCard({ post, paneId, onChanged }: { post: MarketingPost; paneId: string; onChanged(): void }) {
  const decidable = post.status === "IN_REVIEW" || post.status === "DRAFT";
  const [title, setTitle] = useState(post.title ?? "");
  const [body, setBody] = useState(post.body);
  const [schedule, setSchedule] = useState(localInputValue(post.scheduledAt));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edited = body !== post.body || (title || null) !== post.title;
  const limit = CHARACTER_LIMIT[post.channel];
  const issues = marketingWordingIssues(`${title}\n${body}`);
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The action failed.");
    } finally {
      setBusy(false);
    }
  }
  const scheduledAt = schedule ? new Date(schedule).toISOString() : null;
  // "Make graphic": the owner's Design pane makes the channel's graphic and the delivery attaches it to this post.
  const graphicFormat = ["DRAFT", "IN_REVIEW", "APPROVED", "FAILED"].includes(post.status) ? MARKETING_CHANNEL_DEFAULT_FORMAT[post.channel] : null;
  const [graphicNote, setGraphicNote] = useState<string | null>(null);
  const makeGraphic = () => void run(async () => {
    const brief = `A ${MARKETING_CHANNEL_LABELS[post.channel]} graphic for this post.${post.title ? `\nTitle: ${post.title}` : ""}\nPost: ${post.body}`.slice(0, 4000);
    const created = await api.requestDesignFromPane(paneId, { brief, formatIds: [graphicFormat!], callback: { kind: "MARKETING_POST", postId: post.id } });
    setGraphicNote(created.designPaneId ? "Sent to the Design pane; the graphic is attached here when it is delivered." : "Queued: open a Design pane to make the graphic.");
  });
  return (
    <li className="mk-post" data-status={post.status.toLowerCase()}>
      <div className="mk-post-head">
        <span className="jc-tag accent">{MARKETING_CHANNEL_LABELS[post.channel]}</span>
        <span className="jc-tag">{post.kind.toLowerCase().replace("_", " ")}</span>
        {post.target ? <span className="jc-muted">{post.target}</span> : null}
        {post.status === "APPROVED" ? <span className="jc-muted">{post.scheduledAt ? `Scheduled ${when(post.scheduledAt)}` : "Due now"}</span> : null}
        {post.status === "PUBLISHED" ? <span className="jc-muted">{when(post.publishedAt)}</span> : null}
      </div>
      {decidable ? (
        <div className="mk-post-edit">
          {post.kind !== "POST" || post.title ? <input value={title} placeholder="Title" aria-label="Post title" disabled={busy} onChange={(event) => setTitle(event.target.value)} /> : null}
          <textarea rows={6} value={body} aria-label="Post text" disabled={busy} onChange={(event) => setBody(event.target.value)} />
          <div className="mk-post-meta">
            {limit ? <span className={body.length > limit ? "mk-over" : "jc-muted"}>{body.length}/{limit}</span> : <span className="jc-muted">{body.length} characters</span>}
            {issues.length ? <span className="mk-over" role="note">Unqualified claims: {issues.join(", ")}</span> : null}
            {post.reviewNote ? <span className="jc-muted">Your note: {post.reviewNote}</span> : null}
          </div>
          <label className="jc-field"><span>Publish at (empty: as soon as approved)</span>
            <input type="datetime-local" value={schedule} disabled={busy} onChange={(event) => setSchedule(event.target.value)} /></label>
          <input value={note} placeholder="Note for the copilot (needed to send back)" aria-label="Note for the copilot" disabled={busy} onChange={(event) => setNote(event.target.value)} />
          <div className="jc-actions">
            <button type="button" className="jc-button primary" disabled={busy || !body.trim()}
              onClick={() => void run(() => api.decideMarketingPost(paneId, post.id, edited ? { decision: "edit", title: title.trim() || null, body: body.trim(), scheduledAt, ...(note.trim() ? { note: note.trim() } : {}) }
                : { decision: "approve", scheduledAt, ...(note.trim() ? { note: note.trim() } : {}) }))}>
              <Check aria-hidden="true" /> {edited ? "Approve my version" : "Approve"}
            </button>
            <button type="button" className="jc-button" disabled={busy || !note.trim()} title="Send it back to the copilot with your note"
              onClick={() => void run(() => api.decideMarketingPost(paneId, post.id, { decision: "revise", note: note.trim() }))}><Undo2 aria-hidden="true" /> Send back</button>
            <button type="button" className="jc-button ghost danger" disabled={busy}
              onClick={() => void run(() => api.decideMarketingPost(paneId, post.id, { decision: "reject", ...(note.trim() ? { note: note.trim() } : {}) }))}><X aria-hidden="true" /> Reject</button>
          </div>
        </div>
      ) : (
        <>
          {post.title ? <strong className="mk-post-title">{post.title}</strong> : null}
          <p className="mk-post-body">{post.body}</p>
          {post.status === "FAILED" && typeof post.evidence.failure === "string" ? <p className="mk-over">{post.evidence.failure}</p> : null}
          <div className="jc-actions">
            {post.status === "FAILED" ? <button type="button" className="jc-button" disabled={busy} onClick={() => void run(() => api.retryMarketingPost(paneId, post.id))}><RotateCcw aria-hidden="true" /> Retry</button> : null}
            {post.publishedUrl ? <a className="jc-button ghost" href={post.publishedUrl} target="_blank" rel="noreferrer noopener"><ExternalLink aria-hidden="true" /> Open</a> : null}
          </div>
        </>
      )}
      {post.assets.length ? (
        // What the copilot will upload with the post: captures play here; pane files show their kind.
        <ul className="mk-assets" aria-label="Post media">
          {post.assets.map((asset, index) => (
            <li key={index}>
              {asset.artifactId && asset.kind === "VIDEO" ? <video src={api.artifactFileUrl(asset.artifactId)} controls playsInline preload="metadata" aria-label={asset.label} />
                : asset.artifactId && asset.kind === "IMAGE" ? <img src={api.artifactFileUrl(asset.artifactId)} alt={asset.label} loading="lazy" />
                : <span className="jc-tag">{asset.kind.toLowerCase()}</span>}
              <span className="jc-muted">{asset.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {graphicFormat ? (
        <div className="jc-actions">
          <button type="button" className="jc-button ghost" disabled={busy} onClick={makeGraphic} title="Ask the Design pane for this channel's graphic"><DesignIcon aria-hidden="true" /> Make graphic</button>
          {graphicNote ? <span className="jc-muted" role="status">{graphicNote}</span> : null}
        </div>
      ) : null}
      {error ? <p className="jc-message" role="alert">{error}</p> : null}
    </li>
  );
}

/**
 * Posts: ask the copilot for something, the campaigns, then every post grouped by state, reviews first.
 * A review approves the post as written, approves the operator's edit (learned), sends it back with a note, or rejects it.
 */
export function PostsTab({ paneId, posts, campaigns, onChanged }: { paneId: string; posts: MarketingPost[]; campaigns: MarketingCampaign[]; onChanged(): void }) {
  const [brief, setBrief] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [campaignGoal, setCampaignGoal] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  async function run(action: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage(done);
      onChanged();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "The action failed.");
    } finally {
      setBusy(false);
    }
  }
  const open = campaigns.filter((campaign) => campaign.status === "ACTIVE");
  return (
    <div className="mk-posts" role="tabpanel" id="jc-panel-posts" aria-labelledby="jc-tab-posts">
      <form className="mk-brief" onSubmit={(event) => { event.preventDefault(); void run(async () => { await api.createMarketingBrief(paneId, { text: brief.trim() }); setBrief(""); }, "Sent to the copilot; it picks it up on its next run."); }}>
        <textarea rows={2} value={brief} placeholder="Ask the copilot for something, e.g. a launch thread for the new version on X" aria-label="Brief for the copilot" disabled={busy} onChange={(event) => setBrief(event.target.value)} />
        <button type="submit" className="jc-button primary" disabled={busy || !brief.trim()}><Send aria-hidden="true" /> Ask</button>
      </form>
      <details className="mk-campaigns">
        <summary>Campaigns ({open.length} active)</summary>
        <ul className="mk-campaign-list">
          {open.map((campaign) => (
            <li key={campaign.id} className="mk-campaign">
              <span><Rocket aria-hidden="true" /> <strong>{campaign.name}</strong>{campaign.goal ? <span className="jc-muted"> · {campaign.goal}</span> : null}</span>
              <span className="jc-actions">
                <button type="button" className="jc-button ghost" disabled={busy} onClick={() => void run(() => api.decideMarketingCampaign(paneId, campaign.id, "complete"), "Campaign completed.")}>Complete</button>
                <button type="button" className="jc-button ghost danger" disabled={busy} onClick={() => void run(() => api.decideMarketingCampaign(paneId, campaign.id, "cancel"), "Campaign cancelled.")}>Cancel</button>
              </span>
            </li>
          ))}
        </ul>
        <form className="mk-campaign-form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
          await api.createMarketingCampaign(paneId, { name: campaignName.trim(), goal: campaignGoal.trim() || null, ...(templateId ? { templateId } : {}) });
          setCampaignName(""); setCampaignGoal(""); setTemplateId("");
        }, "Campaign started; the copilot plans its posts on its next run."); }}>
          <select value={templateId} aria-label="Campaign template" disabled={busy} onChange={(event) => {
            const template = MARKETING_CAMPAIGN_TEMPLATES.find((entry) => entry.id === event.target.value);
            setTemplateId(event.target.value);
            if (template) { setCampaignName((current) => current || template.name); setCampaignGoal((current) => current || template.goal); }
          }}>
            <option value="">No template</option>
            {MARKETING_CAMPAIGN_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
          </select>
          <input value={campaignName} placeholder="Campaign name" aria-label="Campaign name" disabled={busy} onChange={(event) => setCampaignName(event.target.value)} />
          <input value={campaignGoal} placeholder="Goal (optional)" aria-label="Campaign goal" disabled={busy} onChange={(event) => setCampaignGoal(event.target.value)} />
          <button type="submit" className="jc-button" disabled={busy || !campaignName.trim()}>Start campaign</button>
        </form>
      </details>
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      {posts.length === 0 ? (
        <div className="jc-empty"><strong>No posts yet</strong><span>Ask for something above and press Start: drafts land here for your review before anything is published.</span></div>
      ) : GROUPS.filter((group) => showDone || (group.status !== "PUBLISHED" && group.status !== "REJECTED")).map((group) => {
        const entries = posts.filter((post) => post.status === group.status);
        if (!entries.length) return null;
        return (
          <section key={group.status} className="mk-group" aria-label={group.label}>
            <h4>{group.label} <span className="jc-muted">{entries.length}</span></h4>
            <ul className="mk-post-list">{entries.map((post) => <PostCard key={`${post.id}:${post.updatedAt}`} post={post} paneId={paneId} onChanged={onChanged} />)}</ul>
          </section>
        );
      })}
      {posts.some((post) => post.status === "PUBLISHED" || post.status === "REJECTED") ? (
        <button type="button" className="jc-button ghost" onClick={() => setShowDone((shown) => !shown)}>{showDone ? "Hide published and rejected" : "Show published and rejected"}</button>
      ) : null}
    </div>
  );
}
