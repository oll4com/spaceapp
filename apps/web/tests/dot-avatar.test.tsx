import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dotMoods, type DotCharacter, type DotFeedItem } from "@space/contracts";
import { DotAvatar, dotFace, statusMood, useDotMood } from "../src/features/agent-pane/DotAvatar.js";

const characters: DotCharacter[] = ["astronaut", "star", "robot", "comet", "moon", "planet"];
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("DotAvatar", () => {
  it("draws every Dot in every mood with ids of its own", () => {
    for (const character of characters) for (const mood of dotMoods) {
      const { container, unmount } = render(<><DotAvatar character={character} mood={mood} size={32} /><DotAvatar character={character} mood={mood} size={32} /></>);
      const [first, second] = [...container.querySelectorAll("svg")];
      const ids = (svg: Element) => [...svg.querySelectorAll("[id]")].map((node) => node.id);
      expect(ids(first!).some((id) => ids(second!).includes(id))).toBe(false);
      // Every url(#…) reference points at an id inside the same avatar.
      for (const svg of [first!, second!]) for (const node of svg.querySelectorAll("*")) for (const attribute of node.getAttributeNames()) {
        const ref = /url\(#([^)]+)\)/.exec(node.getAttribute(attribute) ?? "")?.[1];
        if (ref) expect(ids(svg)).toContain(ref);
      }
      expect(container.querySelector(".dot-avatar")?.getAttribute("data-mood")).toBe(mood);
      unmount();
    }
  });

  it("shows each mood in the Dot's own way", () => {
    const { container, rerender } = render(<DotAvatar character="star" mood="adoring" size={64} />);
    expect(container.querySelector('path[fill="#EC5B76"]')).not.toBeNull(); // heart eyes
    expect(container.querySelector(".dot-fx-rise")).not.toBeNull(); // floating hearts
    rerender(<DotAvatar character="star" mood="sleepy" size={64} />);
    expect(container.querySelectorAll(".dot-fx-rise.slow")).toHaveLength(3); // zzz
    expect(dotFace("moon", "idle").eyes).toBe("half"); // Luna's calm, half-lidded look
    expect(dotFace("robot", "working").fx).toBe("scan");
    expect(dotFace("planet", "thinking").fx).toBe("moon");
    rerender(<DotAvatar character="robot" mood="happy" size={64} />);
    expect(container.querySelector(".dot-av-blush")).toBeNull(); // Byte never blushes
    rerender(<DotAvatar character="star" mood="happy" size={64} />);
    expect(container.querySelectorAll(".dot-av-blush")).toHaveLength(2);
  });

  it("blinks only while its motion is on", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<DotAvatar character="robot" size={32} motion="off" />);
    const avatar = () => container.querySelector(".dot-avatar")!;
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(avatar().getAttribute("data-blink")).toBeNull();
    rerender(<DotAvatar character="robot" size={32} motion="on" />);
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(avatar().getAttribute("data-blink")).toBe("true");
    act(() => { vi.advanceTimersByTime(140); });
    expect(avatar().getAttribute("data-blink")).toBeNull();
    expect(avatar().getAttribute("aria-hidden")).toBe("true");
  });
});

describe("useDotMood", () => {
  const message = (author: "USER" | "DOT", content: string, status: DotFeedItem["status"] = "COMPLETED") =>
    ({ kind: "MESSAGE" as const, author, content, status });

  it("maps statuses to moods", () => {
    expect(statusMood("Working")).toBe("working");
    expect(statusMood("Waiting for approval")).toBe("waiting");
    expect(statusMood("Offline")).toBe("sleepy");
    expect(statusMood("Ready")).toBe("idle");
  });

  it("reacts in character to the tone of a new message, then to its reply, never to history", () => {
    vi.useFakeTimers();
    const history = [message("USER", "Fix it NOW!! This is wrong"), message("DOT", "Done.")];
    const { result, rerender } = renderHook(({ character, dotId, status, items }) => useDotMood(character, dotId, status, items),
      { initialProps: { character: "star" as DotCharacter, dotId: "dot:nova", status: "Ready", items: history } });
    expect(result.current).toBe("idle");
    // Nova sweetens a strict user.
    rerender({ character: "star", dotId: "dot:nova", status: "Working", items: [...history, message("USER", "Why didn't you do it?? Fix it immediately!!")] });
    expect(result.current).toBe("comforting");
    // A reply that starts streaming keeps the reaction; after it the status mood returns.
    rerender({ character: "star", dotId: "dot:nova", status: "Working",
      items: [...history, message("USER", "Why didn't you do it?? Fix it immediately!!"), message("DOT", "On it", "RUNNING")] });
    expect(result.current).toBe("comforting");
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(result.current).toBe("working");
    rerender({ character: "star", dotId: "dot:nova", status: "Ready",
      items: [...history, message("USER", "Why didn't you do it?? Fix it immediately!!"), message("DOT", "Fixed and checked.")] });
    expect(result.current).toBe("excited");
    // Luna keeps her distance from the same tone; switching Dots never replays history.
    rerender({ character: "moon", dotId: "dot:luna", status: "Ready", items: history });
    expect(result.current).toBe("idle");
    rerender({ character: "moon", dotId: "dot:luna", status: "Ready", items: [...history, message("USER", "THIS IS WRONG, fix it asap!!")] });
    expect(result.current).toBe("cool");
    rerender({ character: "moon", dotId: "dot:luna", status: "Ready",
      items: [...history, message("USER", "THIS IS WRONG, fix it asap!!"), message("DOT", "It failed.", "FAILED")] });
    expect(result.current).toBe("worried");
  });
});
