import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";
import { localArtifactFilePath } from "../src/artifact-storage.js";
import { cvPdf, sampleJpeg } from "./fixtures/cv-photo-pdf.js";
import { buildCliAgentBootstrapMarkdown, buildJobCopilotPersonaMarkdown } from "../src/agent-bootstrap.js";
import type { MailboxFactory } from "../src/job-apply/mailbox.js";
import { matchAnswerMemory, type JobApplyGoogleAccess } from "../src/job-apply/service.js";
import { fetchPublicUrl } from "../src/public-url-fetch.js";

// Salary research reads public pages through fetchPublicUrl; here it answers trimmed copies of them, never the network.
vi.mock("../src/public-url-fetch.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/public-url-fetch.js")>(), fetchPublicUrl: vi.fn() }));

// The attachment reader's compiled worker does not exist under vitest; run its source like job-apply.test.ts does.
vi.mock("../src/attachment-readers.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/attachment-readers.js")>();
  return { ...original, readAttachment: (input: Parameters<typeof original.readAttachment>[0], options: Parameters<typeof original.readAttachment>[1]) =>
    original.readAttachment(input, { ...options, workerPath: new URL("../src/attachment-reader-worker.ts", import.meta.url).pathname }) };
});

vi.setConfig({ testTimeout: 30_000 });
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const mailboxes: MailboxFactory = {
  async open() {
    const messages = [{ uid: 1, from: "no-reply@us.greenhouse-mail.io", subject: "Your security code", receivedAt: null, snippet: "code" }];
    return {
      async recent() { return messages; },
      async texts() { return messages.map((message) => ({ ...message, text: "Enter this security code field on your application: ZX98ab76\nhttps://boards.greenhouse.io/confirm?token=xyz" })); },
      async close() { /* nothing */ }
    };
  }
};

async function fixture(extra: { jobApplyGoogle?: JobApplyGoogleAccess } = {}) {
  const root = await mkdtemp(join(tmpdir(), "space-job-apply-agent-"));
  temporaryRoots.push(root);
  const wrapper = join(root, "codex-vscode-parity");
  await writeFile(wrapper, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(wrapper, 0o755);
  const config = getApiConfig({
    SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_HOST_SOCKET: join(root, "pane-host.sock"), SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
    SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces"), SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "internal-token-for-job-apply-tests",
    SPACE_ARTIFACT_ROOT: root, SPACE_CONNECTOR_KEY_FILE: join(root, "connector.key"),
    // The test's own Space Memory (none unless a test writes it), never the operator's.
    SPACE_MEMORY_MONTHLY_PATH: join(root, "space_memory_2026-11.md")
  });
  await writeFile(join(root, "connector.key"), "synthetic-connector-key-with-enough-length-0123456789\n");
  const store = new InMemorySpaceStore();
  const app = await createApp({ store, config: { ...config, jobApplyRoot: join(root, "job-apply") }, jobApplyMailboxes: mailboxes, ...extra,
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
  // Rooms created through the API carry the signed-in owner.
  const roomResponse = await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Jobs", initialPaneCount: 0 } });
  const room = roomResponse.json();
  const pane = store.createPane({ roomId: room.id, title: "Job Applications", mode: "JOB_APPLY", terminalRuntimeId: "cli:codex" });
  const cliSession = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
  const token = issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: pane.id, cliSessionId: cliSession.sessionId })!;
  const agent = { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" };
  return { app, store, room, pane, headers, agent, root };
}

describe("job copilot persona", () => {
  it("writes the run loop, memory discipline, truthfulness and handoff rules into AGENTS.md and CLAUDE.md", () => {
    const agents = buildCliAgentBootstrapMarkdown({ roomId: "room:jobs0001", paneId: "pane:jobs0001", cliSessionId: "cli_session:1", runtimeId: "cli:claude", paneMode: "JOB_APPLY" });
    expect(agents).toContain("Job Copilot pane:");
    for (const rule of ["job_next", "job_report", "memory_recall before asking", "fields_record on every step", "Other unsupported security checks keep their handoff rules with space_job_handoff_wait", "VERIFIED only with evidence"]) expect(agents).toContain(rule);
    expect(buildCliAgentBootstrapMarkdown({ paneMode: "TERMINAL" })).not.toContain("Job Copilot pane:");
    const persona = buildJobCopilotPersonaMarkdown({ roomId: "room:jobs0001", paneId: "pane:jobs0001", runtimeId: "cli:claude" });
    expect(persona.startsWith("# Job Copilot")).toBe(true);
    for (const rule of ["space_job_next", "space_job_report", "space_job_memory_recall", "space_job_memory_remember", "space_job_question_ask", "space_job_fields_record",
      "space_browser_request_handoff", "space_job_review_request", "not eligible", "never solve, bypass or retry", "space_job_salary_research"]) {
      expect(persona).toContain(rule);
    }
    expect(persona).toContain("pane:jobs0001");
    expect(persona).toContain("Runtime: cli:claude");
    expect(persona).not.toMatch(/password\s*[:=]/i);
  });
});

describe("job copilot Google account", () => {
  it("gives the pane agent Gmail and Calendar of the copilot's Google account, drafts only and no invitations", async () => {
    const calls: Array<{ toolId: string; args: Record<string, unknown> }> = [];
    const allowed: Array<{ email: string; capabilities: Array<"MAIL_READ" | "MAIL_COMPOSE" | "CALENDAR"> }> = [];
    const jobApplyGoogle: JobApplyGoogleAccess = {
      googleConfigured: true,
      async googleAccounts() { return allowed; },
      async googleCapabilities(_owner, email) { return email === "me@gmail.com" ? ["MAIL_READ", "MAIL_COMPOSE", "CALENDAR"] : []; },
      async googleAccessToken() { return "gmail-token"; },
      async tool(_owner, toolId, args) { calls.push({ toolId, args }); return { status: "COMPLETED", result: { toolId, ok: true } }; }
    };
    const { app, headers, agent } = await fixture({ jobApplyGoogle });
    try {
      expect((await app.inject({ method: "GET", url: "/api/cli/job-apply/profile", headers: agent })).json()).toMatchObject({ mailboxConnected: false, google: null, googleAccounts: [] });
      const unset = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/search", headers: agent, payload: { query: "interview" } });
      expect(unset.statusCode).toBe(409);
      expect(unset.json().error.message).toContain("No Google account has allowed reading email for Space");
      // The operator pressed Allow Gmail & Calendar for the account.
      allowed.push({ email: "me@gmail.com", capabilities: ["MAIL_READ", "MAIL_COMPOSE", "CALENDAR"] });

      const chosen = await app.inject({ method: "PUT", url: "/api/job-apply/google", headers, payload: { email: "Me@Gmail.com" } });
      expect(chosen.statusCode, chosen.body).toBe(200);
      expect(chosen.json().profile.google).toEqual({ email: "me@gmail.com", capabilities: ["MAIL_READ", "MAIL_COMPOSE", "CALENDAR"], available: true });
      expect((await app.inject({ method: "GET", url: "/api/job-apply/profile", headers })).json().profile.google.email).toBe("me@gmail.com");
      expect((await app.inject({ method: "GET", url: "/api/cli/job-apply/profile", headers: agent })).json()).toMatchObject({
        mailboxConnected: true, google: { email: "me@gmail.com", capabilities: ["MAIL_READ", "MAIL_COMPOSE", "CALENDAR"] },
        googleAccounts: [{ email: "me@gmail.com", capabilities: ["MAIL_READ", "MAIL_COMPOSE", "CALENDAR"] }] });
      const named = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/search", headers: agent, payload: { query: "x", account: "other@gmail.com" } });
      expect(named.statusCode).toBe(409);
      expect(named.json().error.message).toContain("other@gmail.com has not allowed reading email for Space");

      for (const [path, payload] of [
        ["mail/search", { query: "from:recruiter@example.com", limit: 5 }],
        ["mail/read", { messageId: "m1" }],
        ["mail/draft", { to: ["recruiter@example.com"], subject: "Re: Interview", body: "Tuesday works." }],
        ["calendar/list", {}],
        ["calendar/create", { title: "Interview: Acme", start: "2026-10-20T09:00:00Z", end: "2026-10-20T10:00:00Z" }]
      ] as const) {
        const response = await app.inject({ method: "POST", url: `/api/cli/job-apply/${path}`, headers: agent, payload });
        expect(response.statusCode, `${path}: ${response.body}`).toBe(200);
      }
      expect(calls).toEqual([
        { toolId: "mail.search", args: { query: "from:recruiter@example.com", limit: 5, account: "me@gmail.com" } },
        { toolId: "mail.read", args: { messageId: "m1", account: "me@gmail.com" } },
        { toolId: "mail.draft", args: { to: ["recruiter@example.com"], subject: "Re: Interview", body: "Tuesday works.", account: "me@gmail.com" } },
        { toolId: "calendar.list", args: { limit: 20, account: "me@gmail.com" } },
        { toolId: "calendar.create", args: { title: "Interview: Acme", start: "2026-10-20T09:00:00Z", end: "2026-10-20T10:00:00Z", account: "me@gmail.com" } }
      ]);
      // Events never invite anyone and mail is never sent from here.
      expect((await app.inject({ method: "POST", url: "/api/cli/job-apply/calendar/create", headers: agent,
        payload: { title: "Interview", start: "2026-10-20T09:00:00Z", end: "2026-10-20T10:00:00Z", attendees: ["someone@example.com"] } })).statusCode).toBe(422);
      expect((await app.inject({ method: "POST", url: "/api/cli/job-apply/calendar/create", headers: agent,
        payload: { title: "Interview", start: "2026-10-20T10:00:00Z", end: "2026-10-20T09:00:00Z" } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/send", headers: agent, payload: {} })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/search", payload: {} })).statusCode).toBe(401);
      expect(calls).toHaveLength(5);
    } finally {
      await app.close();
    }
  });
});

describe("job copilot first-run setup through the bridge", () => {
  it("bootstraps an empty profile once, imports the tracker CSV for the room owner, and leaves identity edits to the operator afterwards", async () => {
    const { app, headers, agent } = await fixture();
    try {
      const bootstrap = await app.inject({ method: "PATCH", url: "/api/cli/job-apply/profile/candidate", headers: agent,
        payload: { candidate: { fullName: "Nikolaos Theodoropoulos", email: "me@example.com", country: "Thailand", location: "Bangkok", workAuthorization: "EU citizen, no sponsorship needed", needsSponsorship: false, skills: ["Node.js"] } } });
      expect(bootstrap.statusCode).toBe(200);
      expect(bootstrap.json().candidate).toMatchObject({ fullName: "Nikolaos Theodoropoulos", country: "Thailand", needsSponsorship: false });
      expect((await app.inject({ method: "PATCH", url: "/api/cli/job-apply/profile/candidate", headers: agent, payload: { candidate: { fullName: "Other" } } })).statusCode).toBe(409);
      expect((await app.inject({ method: "GET", url: "/api/job-apply/profile", headers })).json().profile.candidate.fullName).toBe("Nikolaos Theodoropoulos");
      expect((await app.inject({ method: "POST", url: "/api/cli/job-apply/profile/files", headers: agent, payload: {} })).statusCode).toBe(422);
      expect((await app.inject({ method: "POST", url: "/api/cli/job-apply/profile/files", headers: agent, payload: { cvArtifactId: "artifact:missing0" } })).statusCode).toBe(404);

      const imported = await app.inject({ method: "POST", url: "/api/cli/job-apply/applications/import-csv", headers: agent,
        payload: { csv: ["id,company,board,role,geo,source,status,applied_date,notes,relevance",
          "T1,Quora,quberesearchandtechnologies,DevOps Engineer,HK,greenhouse,applied,2026-08-07,verified code DBapi1eA,match",
          "li_1,Snowflake,linkedin,Backend Engineer,APAC,linkedin,applied,2026-09-02,,match"].join("\n") } });
      expect(imported.statusCode).toBe(200);
      expect(imported.json()).toEqual({ imported: 2, skipped: 0, duplicates: 0 });
      const rows = (await app.inject({ method: "GET", url: "/api/cli/job-apply/applications?limit=10", headers: agent })).json().applications as Array<{ company: string; status: string; paneId: string | null }>;
      // The earlier tracker's "verified" is a claim; only evidence makes a row VERIFIED.
      expect(rows.map((row) => [row.company, row.status]).sort()).toEqual([["Quora", "SUBMITTED"], ["Snowflake", "SUBMITTED"]]);
      expect(rows.every((row) => row.paneId !== null)).toBe(true);
      expect((await app.inject({ method: "POST", url: "/api/cli/job-apply/applications/import-csv", headers: agent, payload: { csv: "id,company,board,role,geo,source,status,applied_date,notes\nT1,Quora,quberesearchandtechnologies,DevOps,HK,greenhouse,applied,2026-08-07,x" } })).json()).toEqual({ imported: 0, skipped: 0, duplicates: 1 });
    } finally {
      await app.close();
    }
  });
});

describe("job copilot CV replace (operator rule 04bdf65c, 31/10)", () => {
  it("replaces the CV only with replace: true, re-reads its text like Setup's Replace, logs a NOTE and an audit row, and refuses another owner's artifact", async () => {
    const { app, store, room, headers, agent, root } = await fixture();
    const textArtifact = async (roomId: string | null, name: string, text: string) => {
      const created = await store.createArtifact({ roomId, paneId: null, kind: "EXPORT", mimeType: "text/plain",
        storageUri: `space-artifact://agent-files/room_x/pane_y/session_z/2026-10-31/${name}`, sha256: name.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "a"), byteSize: text.length, metadata: { originalFilename: name } });
      const artifact = "artifact" in created ? created.artifact : created;
      const path = localArtifactFilePath({ artifactRoot: root, artifact });
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
      return artifact.id;
    };
    try {
      const v8 = await textArtifact(room.id, "cv-v8.txt", "CV v8: Node.js");
      const v81 = await textArtifact(room.id, "cv-v81.txt", "CV v8.1: Node.js, OpenAI credentials");
      const set = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/cli/job-apply/profile/files", headers: agent, payload });
      expect((await set({ cvArtifactId: v8 })).statusCode).toBe(200);
      const refused = await set({ cvArtifactId: v81 });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().message ?? refused.body).toContain("replace: true");

      const replaced = await set({ cvArtifactId: v81, replace: true });
      expect(replaced.statusCode).toBe(200);
      expect(replaced.json()).toMatchObject({ cvArtifactId: v81 });
      expect((await app.inject({ method: "GET", url: "/api/cli/job-apply/profile/cv-text", headers: agent })).json().text).toContain("OpenAI credentials");
      const events = (await app.inject({ method: "GET", url: "/api/job-apply/events?limit=20", headers })).json().events as Array<{ type: string; message: string }>;
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "NOTE", message: `Replaced CV ${v8} → ${v81}` })]));
      const audits = (await store.listAuditEvents()).filter((event) => event.action === "job_apply.agent.profile_files");
      expect(audits.map((event) => event.metadata)).toEqual(expect.arrayContaining([expect.objectContaining({ cvArtifactId: v81, replacedCvArtifactId: v8 })]));

      // An artifact of another owner's room is never read into this profile.
      const otherRoom = store.createRoom({ name: "Someone else" }, undefined, "user:someone-else");
      const foreign = await textArtifact(otherRoom.id, "cv-foreign.txt", "Someone else's CV");
      expect((await set({ cvArtifactId: foreign, replace: true })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/cli/job-apply/profile/cv-text", headers: agent })).json().text).toContain("OpenAI credentials");
    } finally {
      await app.close();
    }
  });
});

describe("job copilot CV photo (operator rule 2026-10-17)", () => {
  it("copies the CV's photo into the copilot's own files, hands its path to the agent and records the standing rule", async () => {
    const { app, store, headers, agent, root } = await fixture();
    try {
      expect((await app.inject({ method: "POST", url: "/api/job-apply/profile/photo-from-cv", headers })).statusCode).toBe(409);
      const photo = sampleJpeg(48, 0x44);
      const pdf = cvPdf([{ width: 940, height: 1329, filter: "/FlateDecode", data: Buffer.alloc(60) }, { width: 600, height: 600, filter: "/DCTDecode", data: photo }]);
      const created = await store.createArtifact({ roomId: null, paneId: null, kind: "EXPORT", mimeType: "application/pdf",
        storageUri: "space-artifact://agent-files/room_x/pane_y/session_z/2026-10-17/cv.pdf", sha256: "0".repeat(64), byteSize: pdf.length, metadata: { originalFilename: "cv.pdf" } });
      const artifact = "artifact" in created ? created.artifact : created;
      const cvPath = localArtifactFilePath({ artifactRoot: root, artifact });
      await mkdir(dirname(cvPath), { recursive: true });
      await writeFile(cvPath, pdf);
      expect((await app.inject({ method: "PATCH", url: "/api/job-apply/profile", headers, payload: { cvArtifactId: artifact.id } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/cli/job-apply/profile", headers: agent })).json().photo).toBeNull();

      const saved = await app.inject({ method: "POST", url: "/api/job-apply/profile/photo-from-cv", headers });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().photo).toMatchObject({ width: 600, height: 600, bytes: photo.length });
      expect(saved.json().photo.path).toBeUndefined();
      const profile = (await app.inject({ method: "GET", url: "/api/cli/job-apply/profile", headers: agent })).json();
      expect(profile.photo).toMatchObject({ width: 600, height: 600 });
      expect(profile.photo.path.startsWith(join(root, "job-apply"))).toBe(true);
      expect((await readFile(profile.photo.path)).equals(photo)).toBe(true);
      const memories = (await app.inject({ method: "GET", url: "/api/job-apply/memory?kinds=FACT", headers })).json().memories;
      expect(memories).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "FACT", key: "photo", pinned: true, text: expect.stringContaining("photo.path") })]));
      expect((await store.listAuditEvents()).some((event) => event.action === "job_apply.profile.photo_from_cv")).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe("job apply agent routes", () => {
  it("queues for the agent's own Job Copilot pane, and for every Job Copilot pane when the agent works from another CLI pane", async () => {
    const { app, store, room, pane, headers, agent } = await fixture();
    try {
      const posting = { company: "OKX", role: "Principal Engineer", ats: "greenhouse", url: "https://job-boards.greenhouse.io/okx/jobs/7671576003" };
      const own = await app.inject({ method: "POST", url: "/api/cli/job-apply/applications", headers: agent, payload: posting });
      expect(own.statusCode).toBe(200);
      expect(own.json().application).toMatchObject({ status: "QUEUED", paneId: pane.id });

      const other = store.createPane({ roomId: room.id, title: "Worktree agent", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
      const otherSession = store.createPaneCliSession({ paneId: other.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", status: "RUNNING", purpose: "NORMAL" });
      const config = getApiConfig({ SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "internal-token-for-job-apply-tests" });
      const foreign = { [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: other.id, cliSessionId: otherSession.sessionId })!, "content-type": "application/json" };
      const shared = await app.inject({ method: "POST", url: "/api/cli/job-apply/applications", headers: foreign,
        payload: { company: "PlanetScale", role: "Software Engineer - Postgres", ats: "greenhouse", url: "https://job-boards.greenhouse.io/planetscale/jobs/4251150009" } });
      expect(shared.statusCode).toBe(200);
      expect(shared.json().application).toMatchObject({ status: "QUEUED", paneId: null });
      // Only queueing is open to other panes; the operator's tracker, profile and mail stay with the Job Copilot pane's agent.
      expect((await app.inject({ method: "GET", url: "/api/cli/job-apply/applications", headers: foreign })).statusCode).toBe(409);
      expect((await app.inject({ method: "GET", url: "/api/cli/job-apply/profile", headers: foreign })).statusCode).toBe(409);

      // The Job Copilot pane's queue lists its own row and the shared one, in queue order.
      const queue = await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(pane.id)}/job-apply/queue`, headers });
      expect(queue.statusCode).toBe(200);
      expect((queue.json().queue as Array<{ company: string }>).map((row) => row.company)).toEqual(["OKX", "PlanetScale"]);
    } finally {
      await app.close();
    }
  });

  it("matches stored answers exactly and by containment", () => {
    const memory = (key: string, text: string) => ({ id: `jobmem:${key.length}abcdef`, ownerUserId: "user:1", kind: "ANSWER" as const, key, text, site: null, company: null, tags: [],
      source: "USER" as const, confidence: 0.9, uses: 0, pinned: false, lastUsedAt: null, createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z" });
    const bank = [memory("how many years of node js experience do you have", "8"), memory("do you need visa sponsorship", "Yes")];
    expect(matchAnswerMemory(bank, "how many years of node.js experience do you have")?.text).toBe("8");
    expect(matchAnswerMemory(bank, "Will you now or in the future need visa sponsorship? Do you need visa sponsorship?")?.text).toBe("Yes");
    expect(matchAnswerMemory(bank, "Favourite colour?")).toBeNull();
  });

  it("never answers a question with the saved answer to a different topic", () => {
    const memory = (key: string, text: string) => ({ id: `jobmem:${key.length}abcdef`, ownerUserId: "user:1", kind: "ANSWER" as const, key, text, site: null, company: null, tags: [],
      source: "USER" as const, confidence: 0.9, uses: 0, pinned: false, lastUsedAt: null, createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z" });
    const bank = [memory("what are your pronouns", "Prefer not to say"), memory("legally authorized to work in australia", "No"),
      memory("years with kubernetes", "2"), memory("notice period", "None, available immediately"), memory("location", "Bangkok, Thailand"),
      memory("will you now or in the future need visa sponsorship", "Yes")];
    // 2026-10-15: "German proficiency" came back answered with the pronouns answer.
    expect(matchAnswerMemory(bank, "What is your language proficiency in German?")).toBeNull();
    expect(matchAnswerMemory(bank, "Are you legally authorized to work in the United States?")).toBeNull();
    expect(matchAnswerMemory(bank, "How many years of experience do you have with Python?")).toBeNull();
    expect(matchAnswerMemory(bank, "Which location do you prefer to work from, remote or office?")).toBeNull();
    // The same question in other words still finds its answer.
    expect(matchAnswerMemory(bank, "What are your pronouns?")?.text).toBe("Prefer not to say");
    expect(matchAnswerMemory(bank, "How many years of experience do you have with Kubernetes?")?.text).toBe("2");
    expect(matchAnswerMemory(bank, "What is your notice period?")?.text).toBe("None, available immediately");
    expect(matchAnswerMemory(bank, "Location")?.text).toBe("Bangkok, Thailand");
    expect(matchAnswerMemory(bank, "Will you now or in the future require visa sponsorship?")).toBeNull();
    expect(matchAnswerMemory(bank, "Will you, now or in the future, need visa sponsorship?")?.text).toBe("Yes");
  });

  it("gives the pane agent the postal address the operator saved in Setup, and nothing once it is cleared", async () => {
    const { app, headers, agent } = await fixture();
    try {
      const address = { line1: "99 Sukhumvit Road", line2: null, city: "Bangkok", region: null, postalCode: "10110", country: "Thailand" };
      expect((await app.inject({ method: "PATCH", url: "/api/job-apply/profile", headers, payload: { candidate: { fullName: "Nikolaos Theodoropoulos", address } } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/cli/job-apply/profile", headers: agent })).json().candidate.address).toEqual(address);
      expect((await app.inject({ method: "PATCH", url: "/api/job-apply/profile", headers, payload: { candidate: { fullName: "Nikolaos Theodoropoulos", address: { ...address, unit: "4B" } } } })).statusCode).toBe(422);
      expect((await app.inject({ method: "PATCH", url: "/api/job-apply/profile", headers, payload: { candidate: { fullName: "Nikolaos Theodoropoulos", address: null } } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/cli/job-apply/profile", headers: agent })).json().candidate.address).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("serves the owner's profile, answers, tracker, pacing, mail and handoff state to the pane agent only", async () => {
    const { app, store, pane, headers, agent } = await fixture();
    try {
      expect((await app.inject({ method: "GET", url: "/api/cli/job-apply/profile" })).statusCode).toBe(401);
      await app.inject({ method: "PATCH", url: "/api/job-apply/profile", headers, payload: { candidate: { fullName: "Nikolaos Theodoropoulos", needsSponsorship: true } } });
      await app.inject({ method: "PUT", url: "/api/job-apply/mailbox", headers, payload: { host: "imap.gmail.com", port: 993, secure: true, user: "me@gmail.com", password: "app-password" } });

      // First-run setup by the copilot is refused once the operator's identity is set.
      expect((await app.inject({ method: "PATCH", url: "/api/cli/job-apply/profile/candidate", headers: agent, payload: { candidate: { fullName: "Someone Else" } } })).statusCode).toBe(409);
      const profile = await app.inject({ method: "GET", url: "/api/cli/job-apply/profile", headers: agent });
      expect(profile.statusCode).toBe(200);
      expect(profile.json()).toMatchObject({ candidate: { fullName: "Nikolaos Theodoropoulos", needsSponsorship: true }, mailboxConnected: true, settings: { submitMode: "AUTO" } });
      expect(profile.body).not.toContain("app-password");

      const recorded = await app.inject({ method: "POST", url: "/api/cli/job-apply/profile/answers", headers: agent, payload: { question: "Years of Node.js?", answer: "8" } });
      expect(recorded.json()).toMatchObject({ recorded: true, entry: { source: "AGENT" } });
      const answer = await app.inject({ method: "POST", url: "/api/cli/job-apply/profile/answer", headers: agent, payload: { question: "years of node.js" } });
      expect(answer.json()).toMatchObject({ found: true, answer: "8" });

      const started = await app.inject({ method: "POST", url: "/api/cli/job-apply/applications", headers: agent,
        payload: { company: "Acme", role: "Backend", ats: "greenhouse", url: "https://boards.greenhouse.io/acme/jobs/7" } });
      expect(started.json()).toMatchObject({ created: true, application: { paneId: pane.id, status: "QUEUED" } });
      const id = started.json().application.id as string;
      expect((await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${id}`, headers: agent, payload: { status: "FILLING" } })).statusCode).toBe(200);
      // A submission without its form snapshot is refused; recording the final step's fields unlocks it.
      expect((await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${id}`, headers: agent, payload: { status: "SUBMITTED" } })).statusCode).toBe(409);
      const recordedFields = await app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${id}/fields`, headers: agent, payload: { fields: [
        { stepIndex: 0, stepTitle: "Application", label: "Full name", fieldType: "text", value: "Nikolaos Theodoropoulos", source: "PROFILE" },
        { stepIndex: 0, stepTitle: "Application", label: "Resume", fieldType: "file", value: "/tmp/uploads/cv.pdf", source: "PROFILE" },
        { stepIndex: 0, stepTitle: "Application", label: "How many years of TypeScript experience do you have?", fieldType: "text", value: "6", source: "CV" }
      ] } });
      expect(recordedFields.statusCode).toBe(200);
      expect(recordedFields.json()).toMatchObject({ recorded: 3 });
      expect(recordedFields.json().fields.find((field: { label: string }) => field.label === "Resume").value).toBe("cv.pdf");
      expect((await app.inject({ method: "GET", url: `/api/cli/job-apply/applications/${id}/fields`, headers: agent })).json().fields).toHaveLength(3);
      expect((await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${id}`, headers: agent, payload: { status: "SUBMITTED" } })).statusCode).toBe(200);
      const verified = await app.inject({ method: "PATCH", url: `/api/cli/job-apply/applications/${id}`, headers: agent, payload: { status: "VERIFIED", externalConfirmation: "code ZX98ab76" } });
      expect(verified.json().application.status).toBe("VERIFIED");
      expect((await app.inject({ method: "GET", url: "/api/cli/job-apply/applications?status=VERIFIED", headers: agent })).json().applications).toHaveLength(1);

      const pacing = await app.inject({ method: "GET", url: "/api/cli/job-apply/pacing?site=greenhouse", headers: agent });
      expect(pacing.json()).toMatchObject({ site: "greenhouse", todayCount: 1, dailyCap: 60 });

      const code = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/wait-code", headers: agent,
        payload: { fromContains: "greenhouse", pattern: "security code field on your application[:\\s]*([A-Za-z0-9]{8})", timeoutMs: 1000 } });
      expect(code.json()).toMatchObject({ code: "ZX98ab76" });
      const link = await app.inject({ method: "POST", url: "/api/cli/job-apply/mail/find-link", headers: agent, payload: { urlContains: "confirm", timeoutMs: 1000 } });
      expect(link.json().link).toBe("https://boards.greenhouse.io/confirm?token=xyz");
      const recent = await app.inject({ method: "GET", url: "/api/cli/job-apply/mail/recent?limit=2", headers: agent });
      expect(recent.json().messages[0]).toMatchObject({ from: "no-reply@us.greenhouse-mail.io" });

      const idle = await app.inject({ method: "GET", url: "/api/cli/job-apply/handoff/status", headers: agent });
      expect(idle.json()).toMatchObject({ paneId: pane.id, browserRunning: false, held: false });
      const session = store.createPaneBrowserSession({ paneId: pane.id, roomId: pane.roomId, agentNumber: 1, profileId: "profile:test", profilePath: "/tmp/profile", viewport: "desktop" });
      store.createBrowserControlLease({ sessionId: session.sessionId, paneId: pane.id, roomId: pane.roomId, holderType: "OPERATOR", holderId: "user:operator", reason: "captcha", ttlSeconds: 30 });
      const held = await app.inject({ method: "GET", url: "/api/cli/job-apply/handoff/status", headers: agent });
      expect(held.json()).toMatchObject({ browserRunning: true, held: true, lease: { holderType: "OPERATOR" } });
    } finally {
      await app.close();
    }
  });
});

describe("job copilot salary research (operator rule 2026-10-25)", () => {
  it("shows the agent the memories holding a question's words before anything is asked; afterMemory asks (queue item 34)", async () => {
    const { app, agent } = await fixture();
    try {
      for (const [key, text] of [["open to being on an on call rotation", "Yes"], ["years with terraform", "0"], ["favourite colour", "blue"]]) {
        expect((await app.inject({ method: "POST", url: "/api/cli/job-apply/memory", headers: agent, payload: { kind: "ANSWER", key, text, source: "USER" } })).statusCode).toBe(200);
      }
      const started = await app.inject({ method: "POST", url: "/api/cli/job-apply/applications", headers: agent,
        payload: { company: "Acme", role: "SRE", ats: "greenhouse", url: "https://boards.greenhouse.io/acme/jobs/9" } });
      const id = started.json().application.id as string;
      const ask = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${id}/question`, headers: agent, payload });
      const first = (await ask({ question: "Are you open to on-call duty?" })).json();
      expect(first).toMatchObject({ questionId: null, answered: false, note: expect.stringContaining("afterMemory: true") });
      expect(first.memoryHits.map((hit: { key: string }) => hit.key)).toEqual(["open to being on an on call rotation"]);
      expect((await ask({ question: "Kafka, Snowflake or Terraform?" })).json().memoryHits.map((hit: { text: string }) => hit.text)).toEqual(["0"]);
      // Nothing was asked: the posting is not parked for the operator.
      const parked = async () => (await app.inject({ method: "GET", url: "/api/cli/job-apply/applications?status=NEEDS_USER", headers: agent })).json().applications.length;
      expect(await parked()).toBe(0);
      const asked = (await ask({ question: "Are you open to on-call duty?", afterMemory: true })).json();
      expect(asked).toMatchObject({ answered: false, questionId: expect.stringMatching(/^jobq:/) });
      expect(await parked()).toBe(1);
      // A question no memory holds a word of is asked at once.
      expect((await ask({ question: "Do you hold a Thai work permit?" })).json()).toMatchObject({ questionId: expect.stringMatching(/^jobq:/) });
    } finally {
      await app.close();
    }
  });

  it("answers a question from the operator's rule instead of parking it: Job memory's grades rule and Space Memory (plan clipboard:7L5KyWp3kQsP step 3)", async () => {
    const { app, agent, root } = await fixture();
    try {
      // jobq:Tcoa0D_0Vp3t (1/11 17:10 UTC): Heritage Holdings asked for the GPA and sat 9.5 h in Needs you while Job memory held the grades rule.
      const rule = (await app.inject({ method: "POST", url: "/api/cli/job-apply/memory", headers: agent, payload: { kind: "LESSON", key: "grades",
        text: "Never ask the operator for school or university grades or GPA; grades are never invented. Skip a posting that requires one.", source: "USER" } })).json().memory;
      await writeFile(join(root, "space_memory_2026-11.md"), ["<!-- space-memory:id=space_memory:rulesal0001 -->", "## 2026-10-29 - Space canonical memory: Salary floor",
        "- created_at=2026-10-29T08:00:00.000Z", "- Tags: operator-rule", "Never ask the operator about salary: expect at least EUR 36,000 gross a year.", "",
        "<!-- space-memory:id=space_memory:factcty0001 -->", "## 2026-10-20 - Space canonical memory: Citizenship", "- created_at=2026-10-20T08:00:00.000Z",
        "- Tags: operator-fact", "Citizenship: Greek, EU work permit, no visa sponsorship needed.", ""].join("\n"));
      const started = await app.inject({ method: "POST", url: "/api/cli/job-apply/applications", headers: agent,
        payload: { company: "Heritage Holdings", role: "Engineer", ats: "greenhouse", url: "https://boards.greenhouse.io/heritage/jobs/1" } });
      const id = started.json().application.id as string;
      const ask = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/cli/job-apply/applications/${id}/question`, headers: agent, payload });
      for (const question of ["Heritage Holdings asks for your GPA. What should I enter?", "What was your final grade (grade point average) for the BSc?"]) {
        const refused = await ask({ question, afterMemory: true });
        expect(refused.statusCode).toBe(409);
        expect(refused.json().error.message).toContain(`Not raised: Job Copilot memory ${rule.id} forbids it`);
      }
      const parked = async () => (await app.inject({ method: "GET", url: "/api/cli/job-apply/applications?status=NEEDS_USER", headers: agent })).json().applications.length;
      expect(await parked()).toBe(0);
      // The operator's pinned Space Memory entries holding the question's words come first too, marked rule or fact.
      const salary = (await ask({ question: "What are your expected salary requirements (gross a year)?" })).json();
      expect(salary).toMatchObject({ questionId: null, memoryHits: [expect.objectContaining({ id: "space_memory:rulesal0001", source: "SPACE_MEMORY_OPERATOR_RULE" })] });
      const visa = (await ask({ question: "Will you need visa sponsorship? What is your citizenship?" })).json();
      expect(visa).toMatchObject({ questionId: null, memoryHits: [expect.objectContaining({ id: "space_memory:factcty0001", source: "SPACE_MEMORY_OPERATOR_FACT" })] });
      // A question they hold too few words of is not shown them (the citizenship fact shares only "work" with a notice period).
      expect((await ask({ question: "What is your notice period at work?" })).json()).toMatchObject({ questionId: expect.stringMatching(/^jobq:/) });
      // The Space Memory rule never refuses a question: it is shown, and afterMemory asks.
      expect((await ask({ question: "What are your expected salary requirements (gross a year)?", afterMemory: true })).json()).toMatchObject({ questionId: expect.stringMatching(/^jobq:/) });
      expect(await parked()).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("answers the owner's percentage below the market and records why in the application's Activity", async () => {
    const pages: Record<string, string> = {
      "https://www.payscale.com/research/GR/Job=Senior_Software_Engineer/Salary": "payscale-gr-senior-software-engineer.html",
      "https://www.paylab.com/gr/salaryinfo/information-technology?lang=en&global_salary_period=monthly": "paylab-gr-information-technology.html",
      "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml": "ecb-eurofxref-daily.xml"
    };
    const requested: string[] = [];
    vi.mocked(fetchPublicUrl).mockImplementation(async (url) => {
      requested.push(url);
      const name = pages[url];
      const text = name ? await readFile(join(import.meta.dirname, "fixtures", "job-salary", name), "utf8") : "";
      return { url, status: name ? 200 : 404, ok: Boolean(name), headers: {}, text };
    });
    const { app, headers, agent } = await fixture();
    try {
      await app.inject({ method: "PATCH", url: "/api/cli/job-apply/profile/candidate", headers: agent, payload: { candidate: { fullName: "Candidate", salaryBelowMarketPercent: 20 } } });
      const posting = "https://job-boards.greenhouse.io/optasia/jobs/7012345";
      const application = (await app.inject({ method: "POST", url: "/api/cli/job-apply/applications", headers: agent,
        payload: { company: "Optasia", role: "Senior Software Engineer", ats: "greenhouse", url: posting } })).json().application as { id: string };

      const research = await app.inject({ method: "POST", url: "/api/cli/job-apply/salary-research", headers: agent,
        payload: { title: "Software Engineer", seniority: "Senior", city: "Athens", country: "Greece", applicationId: application.id } });
      expect(research.statusCode).toBe(200);
      const result = research.json();
      expect(result.recommended).toEqual({ yearly: 31_000, monthly: 2_200, currency: "EUR", belowPercent: 20, rule: "20% below the market median (EUR 38,932 a year), rounded down" });
      expect(result).toMatchObject({ confidence: "medium", askOperator: false, postingRange: null, market: { currency: "EUR", paymentsPerYear: 14, yearly: { median: 38_932 } } });
      // The application's own posting is read first; Greenhouse has no such job here, so it is skipped, not guessed.
      expect(requested).toContain("https://boards-api.greenhouse.io/v1/boards/optasia/jobs/7012345?pay_transparency=true");
      expect(result.skipped).toContainEqual({ source: "posting", url: "https://boards-api.greenhouse.io/v1/boards/optasia/jobs/7012345?pay_transparency=true", reason: "no page for this query" });

      const events = (await app.inject({ method: "GET", url: `/api/job-apply/events?applicationId=${encodeURIComponent(application.id)}&limit=20`, headers })).json().events as Array<{ type: string; message: string; payload: Record<string, any> }>;
      const note = events.find((event) => event.type === "NOTE" && event.message.startsWith("Salary research"));
      expect(note?.message).toContain("answer EUR 31,000 a year / EUR 2,200 a month x14");
      expect(note?.payload.salaryResearch.market.sources.map((row: { source: string }) => row.source)).toEqual(["payscale", "paylab"]);

      // Queue 29/10 (Tide Bulgaria asked the operator): no figures and no rule asks; the operator's salary rule in memory answers instead.
      const sofia = async () => (await app.inject({ method: "POST", url: "/api/cli/job-apply/salary-research", headers: agent,
        payload: { title: "Platform Engineer", seniority: "Staff", city: "Sofia", country: "Bulgaria", applicationId: application.id } })).json();
      expect(await sofia()).toMatchObject({ recommended: null, confidence: "low", askOperator: true });
      const rule = (await app.inject({ method: "POST", url: "/api/cli/job-apply/memory", headers: agent,
        payload: { kind: "PREFERENCE", key: "salary floor", text: "Salary: answer the higher of the researched recommendation and EUR 36,000 a year, without asking.", source: "USER" } })).json();
      expect(await sofia()).toMatchObject({ recommended: null, askOperator: false, salaryRules: [{ id: rule.memory.id, text: expect.stringContaining("EUR 36,000") }] });
      const sofiaNote = (await app.inject({ method: "GET", url: `/api/job-apply/events?applicationId=${encodeURIComponent(application.id)}&limit=20`, headers })).json().events
        .find((event: { message: string }) => event.message.includes("Sofia"));
      expect(sofiaNote.message).toContain(`Confidence low. Answer by the salary rule in memory (${rule.memory.id}).`);
      expect((await app.inject({ method: "POST", url: "/api/cli/job-apply/salary-research", headers: agent, payload: { title: "Engineer", city: "Atlantis", country: "Atlantis" } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: "/api/cli/job-apply/salary-research", headers: agent, payload: { title: "Engineer", country: "GR" } })).statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });
});
