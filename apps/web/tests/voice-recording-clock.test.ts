import { describe, expect, it } from "vitest";
import { formatRecordingClock, previewTail } from "../src/features/voice-input/recording-clock.js";

describe("voice recording clock", () => {
  it("shows elapsed time and counts down the last ten seconds before the automatic stop", () => {
    expect(formatRecordingClock(0, 60_000)).toBe("0:00");
    expect(formatRecordingClock(42_400, 60_000)).toBe("0:42");
    expect(formatRecordingClock(50_000, 60_000)).toBe("Stops in 10s");
    expect(formatRecordingClock(52_100, 60_000)).toBe("Stops in 8s");
    expect(formatRecordingClock(61_000, 60_000)).toBe("Stops in 0s");
    expect(formatRecordingClock(75_000, null)).toBe("1:15");
  });

  it("keeps the newest words of a long live preview visible", () => {
    expect(previewTail("short text")).toBe("short text");
    const long = `${"παλιό ".repeat(30)}τελευταίες λέξεις`;
    const tail = previewTail(long, 40);
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("τελευταίες λέξεις")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(40);
  });
});
