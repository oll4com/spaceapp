import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { HistoryPeriodSettingsCard } from "../src/features/history-period/HistoryPeriodSettingsCard.js";

// Settings → Personal → History (operator 1/11 03:37 BKK): one period for every history, 7 to 90 days, 90 by default.
describe("History period setting", () => {
  beforeEach(() => installSpaceRuntime(liveRuntime));
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("shows 90 days when unset and saves the chosen period", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/csrf") return Response.json({ csrfToken: "csrf:history", headerName: "x-space-csrf-token" });
      if (url === "/api/user-settings" && init?.method === "PATCH") { patches.push(JSON.parse(String(init.body))); return Response.json({}); }
      if (url === "/api/user-settings") return Response.json({ uiTheme: "modern" });
      return Response.json({});
    }));
    render(<HistoryPeriodSettingsCard />);
    const select = await screen.findByRole("combobox", { name: "History period" }) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("90"));
    expect([...select.options].map((option) => option.textContent)).toEqual(["7 days", "14 days", "30 days", "60 days", "90 days"]);
    fireEvent.change(select, { target: { value: "30" } });
    await waitFor(() => expect(patches).toEqual([{ history: { periodDays: 30 } }]));
    expect(select.value).toBe("30");
  });
});
