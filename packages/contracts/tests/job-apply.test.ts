import { describe, expect, it } from "vitest";
import {
  canTransitionJobApplication, createPaneInputSchema, createRoomPanesRequestSchema, defaultJobApplyPaneMetadata,
  jobApplicationSchema, jobApplyCandidateSchema, jobApplyPaneMetadataSchema, jobPostingFromUrl, paneSchema, resolveJobApplyPaneMetadata
} from "../src/index.js";

const basePane = {
  id: "pane:owned123", roomId: "room:owned123", title: "Job Applications", mode: "JOB_APPLY", status: "IDLE", providerId: null,
  modelId: null, cwd: null, order: 0, columnSpan: 1, isMaximized: false, isMinimized: false, isClosed: false,
  split: { parentId: null, direction: null, size: null }, createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z"
};

describe("job applications pane contracts", () => {
  it("fills conservative defaults and rejects inverted delays or unknown settings", () => {
    const metadata = defaultJobApplyPaneMetadata();
    expect(metadata.version).toBe(1);
    expect(metadata.settings.submitMode).toBe("AUTO");
    expect(metadata.settings.dailyCaps.linkedin).toBe(25);
    expect(metadata.settings.paused).toBe(false);
    expect(resolveJobApplyPaneMetadata(null)).toEqual(metadata);
    expect(jobApplyPaneMetadataSchema.safeParse({ version: 1, settings: { minDelayMs: 5000, maxDelayMs: 1000 } }).success).toBe(false);
    expect(jobApplyPaneMetadataSchema.safeParse({ version: 1, settings: { captchaKey: "x" } }).success).toBe(false);
    expect(jobApplyPaneMetadataSchema.safeParse({ version: 2, settings: {} }).success).toBe(false);
  });

  it("round-trips pane metadata without changing legacy pane defaults", () => {
    const metadata = defaultJobApplyPaneMetadata();
    expect(paneSchema.parse({ ...basePane, jobApplyMetadata: metadata }).jobApplyMetadata).toEqual(metadata);
    expect(paneSchema.parse(basePane).jobApplyMetadata ?? null).toBeNull();
  });

  it("lets a Job Applications pane carry its CLI runtime and accepts it in a room batch", () => {
    expect(createPaneInputSchema.safeParse({ roomId: "room:owned123", title: "Jobs", mode: "JOB_APPLY", terminalRuntimeId: "cli:opencode" }).success).toBe(true);
    expect(createPaneInputSchema.safeParse({ roomId: "room:owned123", title: "Chat", mode: "CHAT", terminalRuntimeId: "cli:opencode" }).success).toBe(false);
    expect(createRoomPanesRequestSchema.parse({ panes: [{ mode: "JOB_APPLY" }, { mode: "JOB_APPLY", terminalRuntimeId: " cli:claude " }] }))
      .toEqual({ panes: [{ mode: "JOB_APPLY" }, { mode: "JOB_APPLY", terminalRuntimeId: "cli:claude" }] });
    expect(createRoomPanesRequestSchema.safeParse({ panes: [{ mode: "JOB_APPLY", cwd: "/root" }] }).success).toBe(false);
  });

  // The Browser Host parses pane rows with the contracts it loaded at start (ADR-011 item 13): a key added to the
  // pane metadata breaks its browser starts until a guarded host restart (an `agent` key did on 2026-10-13).
  it("keeps the pane metadata shape the running Browser Host accepts", () => {
    expect(Object.keys(jobApplyPaneMetadataSchema.shape).sort()).toEqual(["settings", "version"]);
    expect(jobApplyPaneMetadataSchema.safeParse({ ...defaultJobApplyPaneMetadata(), agent: { runtimeId: "cli:claude", accountProfileId: "work" } }).success).toBe(false);
    // The launch's account travels in the room batch request, never in the pane row.
    expect(createRoomPanesRequestSchema.parse({ panes: [{ mode: "JOB_APPLY", terminalRuntimeId: "cli:claude", accountProfileId: "space-gateway" }] }).panes[0])
      .toMatchObject({ accountProfileId: "space-gateway" });
  });

  it("keeps an optional postal address on the candidate profile", () => {
    expect(jobApplyCandidateSchema.parse({ fullName: "Nikolaos Theodoropoulos" }).address).toBeNull();
    const address = { line1: "99 Sukhumvit Road", city: "Bangkok", postalCode: "10110", country: "Thailand" };
    expect(jobApplyCandidateSchema.parse({ address }).address).toEqual({ ...address, line2: null, region: null });
    expect(jobApplyCandidateSchema.safeParse({ address: { ...address, apartment: "4B" } }).success).toBe(false);
    expect(jobApplyCandidateSchema.safeParse({ address: { ...address, postalCode: "x".repeat(41) } }).success).toBe(false);
  });

  it("counts an application only through allowed tracker transitions", () => {
    const application = jobApplicationSchema.parse({
      id: "jobapp:abc123", ownerUserId: "user:1", paneId: "pane:owned123", company: "Acme", role: "Backend Engineer", ats: "greenhouse",
      url: "https://boards.greenhouse.io/acme/jobs/1", status: "QUEUED", createdAt: basePane.createdAt, updatedAt: basePane.updatedAt
    });
    expect(application.evidenceArtifactIds).toEqual([]);
    expect(canTransitionJobApplication("FILLING", "SUBMITTED")).toBe(true);
    expect(canTransitionJobApplication("SUBMITTED", "VERIFIED")).toBe(true);
    expect(canTransitionJobApplication("QUEUED", "VERIFIED")).toBe(false);
    expect(canTransitionJobApplication("VERIFIED", "FAILED")).toBe(false);
    expect(jobApplicationSchema.safeParse({ ...application, evidenceArtifactIds: ["not-an-artifact"] }).success).toBe(false);
  });
});

describe("jobPostingFromUrl", () => {
  it("derives board, company and posting placeholders from ATS URLs", () => {
    expect(jobPostingFromUrl("https://boards.greenhouse.io/acme/jobs/4567890")).toEqual({ url: "https://boards.greenhouse.io/acme/jobs/4567890", ats: "greenhouse", company: "Acme", role: "Posting 4567890" });
    expect(jobPostingFromUrl("https://job-boards.greenhouse.io/embed/job_app?for=globex-corp&token=12345")).toMatchObject({ ats: "greenhouse", company: "Globex Corp", role: "Posting 12345" });
    expect(jobPostingFromUrl("https://jobs.ashbyhq.com/initech/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d")).toMatchObject({ ats: "ashby", company: "Initech", role: "Posting 0a1b2c3d" });
    expect(jobPostingFromUrl("https://jobs.lever.co/hooli/77aa-bb")).toMatchObject({ ats: "lever", company: "Hooli" });
    expect(jobPostingFromUrl("https://www.linkedin.com/jobs/view/senior-backend-engineer-at-acme-4123456789/")).toMatchObject({ ats: "linkedin", role: "Senior Backend Engineer At Acme" });
    expect(jobPostingFromUrl("https://acme.wd5.myworkdayjobs.com/en-US/External/job/Athens/Backend-Engineer_R-1234")).toMatchObject({ ats: "workday", company: "Acme", role: "Backend Engineer" });
    expect(jobPostingFromUrl("https://careers.example.com/positions/staff-engineer")).toMatchObject({ ats: "other", company: "Example", role: "Staff Engineer" });
  });
  it("rejects anything that is not an http(s) URL", () => {
    expect(jobPostingFromUrl("not a url")).toBeNull();
    expect(jobPostingFromUrl("javascript:alert(1)")).toBeNull();
    expect(jobPostingFromUrl("ftp://example.com/job")).toBeNull();
  });
});
