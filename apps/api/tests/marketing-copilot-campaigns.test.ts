import { describe, expect, it, vi } from "vitest";
import { defaultMarketingCopilotPaneMetadata, MARKETING_CAMPAIGN_TEMPLATES, type Pane, type Room } from "@space/contracts";
import { InMemoryMarketingCopilotRepository } from "@space/db";
import { createMarketingCopilotScheduler } from "../src/marketing-copilot/scheduler.js";
import { createMarketingCopilotService } from "../src/marketing-copilot/service.js";

const owner = "user:operator";
function pane(releaseCampaigns = true): Pane {
  const metadata = defaultMarketingCopilotPaneMetadata();
  return { id: "pane:mkt000001", roomId: "room:mkt000001", mode: "MARKETING_COPILOT", title: "Marketing Copilot", isClosed: false,
    marketingCopilotMetadata: { ...metadata, settings: { ...metadata.settings, releaseCampaigns } } } as Pane;
}

describe("marketing campaign templates and the release hook", () => {
  it("starts a campaign from a template: its goal, channels and plan become the copilot's brief", async () => {
    const repository = new InMemoryMarketingCopilotRepository();
    const service = createMarketingCopilotService({ repository });
    const campaign = await service.createCampaign(owner, pane(), { templateId: "show-hn", name: "Show HN", channels: [] }, "USER");
    expect(campaign).toMatchObject({ status: "ACTIVE", channels: ["HACKER_NEWS"], goal: MARKETING_CAMPAIGN_TEMPLATES.find((entry) => entry.id === "show-hn")!.goal, payload: { templateId: "show-hn" } });
    const [brief] = await repository.listEvents(owner, { types: ["BRIEF"], limit: 5 });
    expect(brief?.message).toContain("Draft a Show HN submission");
    await expect(service.createCampaign(owner, pane(), { templateId: "billboard", name: "Billboard", channels: [] }, "USER")).rejects.toThrow(/template billboard/);
  });

  it("proposes one release campaign per new version, never when the pane turned it off", async () => {
    const repository = new InMemoryMarketingCopilotRepository();
    const service = createMarketingCopilotService({ repository });
    expect(await service.proposeReleaseCampaign(owner, pane(false), "0.2.6")).toBeNull();
    const proposed = await service.proposeReleaseCampaign(owner, pane(), "0.2.6");
    expect(proposed).toMatchObject({ name: "SpaceApp 0.2.6 release", status: "PROPOSED", proposedBy: "RELEASE", channels: ["X", "LINKEDIN", "GITHUB", "DEVTO"], payload: { version: "0.2.6", templateId: "release" } });
    expect(await service.proposeReleaseCampaign(owner, pane(), "0.2.6")).toBeNull();
    // Declined stays declined; the next version proposes again.
    await service.decideCampaign(owner, pane(), proposed!.id, "cancel");
    expect(await service.proposeReleaseCampaign(owner, pane(), "0.2.6")).toBeNull();
    expect((await service.proposeReleaseCampaign(owner, pane(), "0.3.0"))?.name).toBe("SpaceApp 0.3.0 release");
    // Approving it hands the release plan, with the version, to the copilot.
    const next = (await service.listCampaigns(owner, ["PROPOSED"]))[0]!;
    await service.decideCampaign(owner, pane(), next.id, "approve");
    const [brief] = await repository.listEvents(owner, { types: ["BRIEF"], limit: 5 });
    expect(brief?.message).toContain("Plan a release announcement");
    expect(brief?.message).toContain("Version: 0.3.0.");
  });

  it("lets the scheduler propose the running version's campaign on its tick", async () => {
    const service = createMarketingCopilotService({ repository: new InMemoryMarketingCopilotRepository() });
    const scheduler = createMarketingCopilotScheduler({ service, version: "0.2.6", log: { warn: vi.fn() },
      store: { listRooms: () => [{ id: "room:mkt000001", ownerUserId: owner } as Room], listPanes: () => [pane()] },
      hasAgent: async () => false, hasActiveRun: async () => false, startRun: vi.fn(), notifyDue: vi.fn() });
    await scheduler.tick();
    await scheduler.tick();
    expect((await service.listCampaigns(owner)).map((campaign) => campaign.name)).toEqual(["SpaceApp 0.2.6 release"]);
  });
});
