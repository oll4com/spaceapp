import { describe, expect, it, vi } from "vitest";
import { SpaceApiError } from "../src/api.js";
import { closeOrConfirm, type CloseConfirm } from "../src/features/marketing-copilot-pane/close-or-confirm.js";

const held = () => new SpaceApiError("held", { code: "PANE_WAITS_FOR_OPERATOR", status: 409, details: { needsYou: [{}] } });

describe("closeOrConfirm", () => {
  it("asks in the app, never window.confirm, and forces only on yes", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm");
    const close = vi.fn(async (force: boolean) => { if (!force) throw held(); return "closed"; });
    const confirm = vi.fn<CloseConfirm>(async () => true);
    await expect(closeOrConfirm(close, confirm)).resolves.toBe("closed");
    expect(confirm.mock.calls[0]?.[0].message).toContain("1 unanswered Needs you items");
    expect(close).toHaveBeenLastCalledWith(true);

    const refuse = vi.fn(async (force: boolean) => { if (!force) throw held(); return "closed"; });
    await expect(closeOrConfirm(refuse, async () => false)).rejects.toThrow("held");
    expect(refuse).not.toHaveBeenCalledWith(true);
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it("asks one question at a time", async () => {
    let open = 0, most = 0;
    const confirm = async () => { most = Math.max(most, ++open); await Promise.resolve(); open--; return true; };
    const close = async (force: boolean) => { if (!force) throw held(); return force; };
    await Promise.all([closeOrConfirm(close, confirm), closeOrConfirm(close, confirm)]);
    expect(most).toBe(1);
  });
});
