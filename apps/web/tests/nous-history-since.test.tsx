import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NousMessage } from "@space/contracts";

const api = vi.hoisted(() => ({ nousMessages: vi.fn() }));
vi.mock("../src/api.js", () => ({ api }));

import { mergeMessages, useNousHistory } from "../src/features/nous/nous-history.js";

const row = (id: string, createdAt: string, content = id) =>
  ({ id, ownerUserId: "user:operator", turnId: null, kind: "ANSWER", status: "DONE", content, meta: {}, createdAt, updatedAt: createdAt }) as NousMessage;

// Desktop start-up 10/11: the dock re-read the whole 2.2 MB conversation every poll; now it sends the server's cursor back.
describe("Nous dock history since cursor", () => {
  it("keeps the same rows when a since read brings nothing, and merges the changed rows into place", () => {
    const current = [row("m1", "2026-11-10T10:00:00.000Z"), row("m2", "2026-11-10T10:01:00.000Z")];
    expect(mergeMessages(current, [])).toBe(current);
    expect(mergeMessages(current, [row("m1", "2026-11-10T10:00:00.000Z", "edited"), row("m3", "2026-11-10T10:02:00.000Z")]).map((message) => [message.id, message.content]))
      .toEqual([["m1", "edited"], ["m2", "m2"], ["m3", "m3"]]);
  });

  it("sends the last cursor on the next latest read and none after Clear conversation", async () => {
    api.nousMessages.mockResolvedValueOnce({ messages: [row("m1", "2026-11-10T10:00:00.000Z")], cursor: "2026-11-10T10:00:05.000Z", attachments: {} })
      .mockResolvedValueOnce({ messages: [], cursor: "2026-11-10T10:00:08.000Z", attachments: {} })
      .mockResolvedValueOnce({ messages: [], cursor: "2026-11-10T10:00:11.000Z", attachments: {} });
    const { result } = renderHook(() => useNousHistory());
    await act(async () => { await result.current.latest(); });
    const first = result.current.messages;
    await act(async () => { await result.current.latest(); });
    expect(result.current.messages).toBe(first);
    act(() => result.current.cleared());
    await act(async () => { await result.current.latest(); });
    expect(api.nousMessages.mock.calls).toEqual([[{}], [{ since: "2026-11-10T10:00:05.000Z" }], [{}]]);
  });
});
