import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { councilRunSchema, jobApplicationSchema, mailCopilotRunViewSchema, mailThreadSchema, marketingPostSchema, taskItemSchema } from "@space/contracts";
import { DemoStore } from "../src/demo/DemoStore.js";
import { createCurrentMockFixture } from "../src/demo/mock-fixture.js";
import { COPILOTS_ROOM_ID, MAIL_PANE_ID, PUBLIC_MOCK_MODULES } from "../src/demo/mock-copilots.js";
import { installMockStorage } from "../src/demo/mock-storage.js";

const store = () => new DemoStore(createCurrentMockFixture());

describe("public mock Copilots room", () => {
  it("shows Mail, Job and Marketing Copilot panes with contract-valid demo data", async () => {
    const api = store().api;
    const panes = (await api.panes(COPILOTS_ROOM_ID)).data.sort((a, b) => a.order - b.order);
    expect(panes.map(pane => pane.mode)).toEqual(["MAIL_COPILOT", "JOB_APPLY", "MARKETING_COPILOT"]);
    const run = mailCopilotRunViewSchema.parse(await api.mailCopilotRun(MAIL_PANE_ID));
    expect(run.pending.map(item => item.kind)).toEqual(["REVIEW"]);
    expect((await api.mailHabits(MAIL_PANE_ID)).habits).toHaveLength(1);
    expect(mailThreadSchema.safeParse((await api.mailThread(MAIL_PANE_ID, "avery@example.com", "demo-thread-1")).thread).success).toBe(true);
    const applications = (await api.jobApplications()).applications;
    for (const application of applications) jobApplicationSchema.parse(application);
    expect(applications.filter(application => application.status === "QUEUED").length).toBeGreaterThan(0);
    const posts = (await api.marketingPosts()).posts;
    for (const post of posts) marketingPostSchema.parse(post);
    expect(posts.some(post => post.status === "IN_REVIEW")).toBe(true);
    const tasks = (await api.taskItems()).data.filter(task => task.roomId === COPILOTS_ROOM_ID);
    for (const task of tasks) taskItemSchema.parse(task);
    expect(tasks.length).toBeGreaterThanOrEqual(3);
  });

  it("shows a finished Research Council run with its Top 3, and keeps asking local", async () => {
    const api = store().api;
    const [summary] = (await api.councilRuns()).runs;
    const { run } = await api.councilRun(summary!.id);
    expect(councilRunSchema.parse(run).final?.top).toHaveLength(3);
    await expect(api.createCouncilRun({ question: "A new question" })).rejects.toMatchObject({ code: "DEMO_LOCAL_ONLY" });
  });

  it("leaves out what the public release does not have: Freelance Copilot, room sharing, Nous", async () => {
    expect(PUBLIC_MOCK_MODULES).not.toContain("freelance-copilot");
    expect(PUBLIC_MOCK_MODULES).toEqual(expect.arrayContaining(["mail-copilot", "job-copilot", "marketing-copilot"]));
    const api = store().api;
    await expect(api.roomShares(COPILOTS_ROOM_ID)).rejects.toMatchObject({ status: 404 });
    await expect(api.nous()).rejects.toMatchObject({ status: 404 });
    installMockStorage();
    expect(JSON.parse(window.localStorage.getItem("space:docks-hidden:v1") ?? "[]")).toContain("nous");
  });

  it("uses invented addresses only", () => {
    const source = readFileSync(path.join(process.cwd(), "src/demo/mock-copilots.ts"), "utf8");
    const addresses = [...source.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map(match => match[0]);
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.filter(address => !/@example\.(?:com|org)$/.test(address))).toEqual([]);
  });
});
