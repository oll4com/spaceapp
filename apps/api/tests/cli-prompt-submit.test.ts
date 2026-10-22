import { describe, expect, it, vi } from "vitest";
import { submitCliPrompt } from "../src/cli-prompt-submit.js";

const rule = "─".repeat(60);
const empty = [rule, "❯ ", rule].join("\n");
const draft = (text: string) => [rule, `❯ ${text}`, rule].join("\n");
const kickoff = "Freelance Copilot run flrun:ASUITVBtk_Gq started in this pane. Read the space-freelance-copilot skill, then loop.";

/** A terminal whose composer shows `screens` in turn (the last one repeats); it records what was typed. */
function terminal(...screens: string[]) {
  const typed: string[] = [];
  let read = 0;
  return {
    typed,
    sendInput: vi.fn(async (_session: string, data: string) => { typed.push(data); return { turnMarker: null, markerAtMs: 0 }; }),
    observeRoomScreenUndimmed: vi.fn(async () => screens[Math.min(read++, screens.length - 1)]!)
  };
}

describe("typing a prompt into a CLI pane", () => {
  it("pastes the prompt bracketed and presses Enter once when the composer lets go", async () => {
    const cli = terminal(empty, empty);
    await submitCliPrompt(cli, "cli_session:1", kickoff, "trace:1", "trace:1:kickoff", { delayMs: 0 });
    expect(cli.typed).toEqual([`\u001b[200~${kickoff}\u001b[201~`, "\r"]);
  });

  // Bruno/Cody's run kickoff sat as an unsent draft from 00:20 to 01:36 UTC on 2026-10-20 until Enter was pressed.
  it("presses Enter again while the composer still holds the prompt, inline or as Claude's paste placeholder", async () => {
    const cli = terminal(empty, draft(kickoff), draft("[Pasted text #1]"), empty);
    await submitCliPrompt(cli, "cli_session:1", kickoff, "trace:1", "trace:1:kickoff", { delayMs: 0 });
    expect(cli.typed.slice(1)).toEqual(["\r", "\r", "\r"]);
  });

  it("fails instead of reporting a prompt sent that stays a draft", async () => {
    const cli = terminal(empty, draft(kickoff));
    await expect(submitCliPrompt(cli, "cli_session:1", kickoff, "trace:1", "trace:1:kickoff", { delayMs: 0 }))
      .rejects.toThrow(/unsent draft/);
    expect(cli.typed.filter((data) => data === "\r")).toHaveLength(3);
  });

  it("never presses Enter again when the composer was not empty before typing", async () => {
    const cli = terminal(draft("the operator's own note"), draft(`the operator's own note ${kickoff}`));
    await submitCliPrompt(cli, "cli_session:1", kickoff, "trace:1", "trace:1:kickoff", { delayMs: 0 });
    expect(cli.typed.filter((data) => data === "\r")).toHaveLength(1);
  });
});
