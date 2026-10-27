import { describe, expect, it } from "vitest";
import { roomTerminalMode, roomTerminalState } from "../src/room-terminal-screen.js";

// Rails captured from the installed TUIs (omp 18.6.3, qodercli 1.1.58, droid 0.234.0).
describe("Room Agent mode readback for Oh My Pi, Qoder and Droid", () => {
  it("reads Oh My Pi Plan from its status rail and nothing from prose", () => {
    const build = " π > ⟳ GPT-6 Sol > 📁 /etc ▶─1%────┃──1.1M─\n╰─                     ⇧⇥ to change thinking effort";
    const plan = " Plan mode paused.\n π > ⟳ GPT-6 Sol > 🗺 Plan ⏸ > 📁 /etc ▶─1%────┃──1.1M─\n╰─    ⇧⇥ to change thinking effort";
    expect(roomTerminalMode("cli:omp", build, ["build", "plan"])).toBe("build");
    expect(roomTerminalMode("cli:omp", plan, ["build", "plan"])).toBe("plan");
    expect(roomTerminalMode("cli:omp", "I will switch to plan mode now.", ["build", "plan"])).toBeNull();
  });

  it("reads an Oh My Pi turn from its spinner rail, whatever activity line it shows (omp 18.12.1)", () => {
    expect(roomTerminalState("  ⎋ Running requested shell command\n ⠋ 3s > ◔ GPT-6 Sol > 🌳 …c8ec ▶─3%────┃──1.1M─\n╰─")).toBe("RUNNING");
    expect(roomTerminalState(" π > ◔ GPT-6 Sol > 🌳 …c8ec ▶─3%────┃──1.1M─\n╰─                     ⇧⇥ to change thinking effort")).toBe("IDLE");
  });

  it("reads Qoder's permission mode and its separate Plan flag", () => {
    const rail = (mode: string) => `──────\n ${mode}        1 AGENTS.md file · 2 MCP servers · 55 skills\n──────\n >   Type your message\n──────\n Qwen3.8-Flash Model · ctx 0% · /etc`;
    expect(roomTerminalMode("cli:qoder", rail("YOLO Shift+Tab to Auto Mode"))).toBe("yolo");
    expect(roomTerminalMode("cli:qoder", rail("Auto Mode Shift+Tab to Don't Ask"))).toBe("auto mode");
    expect(roomTerminalMode("cli:qoder", rail("Don't Ask Shift+Tab to Default"))).toBe("don't ask");
    expect(roomTerminalMode("cli:qoder", rail("Shift+Tab to Accept Edits"))).toBe("default");
    expect(roomTerminalMode("cli:qoder", rail("Accept Edits Shift+Tab to YOLO"))).toBe("accept edits");
    expect(roomTerminalMode("cli:qoder", rail("YOLO Shift+Tab to Auto Mode | plan on"))).toBe("plan");
  });

  it("reads Droid Spec mode from its composer title", () => {
    const screen = (title: string) => ` Auto (High) · allow all commands        GPT-6.1 Sol (High)\n╭${title}──────╮\n│ > Try something │\n╰──────────────╯\n? for help`;
    expect(roomTerminalMode("cli:droid", screen("── Spec ─"), ["build", "plan"])).toBe("plan");
    expect(roomTerminalMode("cli:droid", screen("────────"), ["build", "plan"])).toBe("build");
  });

  it("reads Droid in a narrow pane (rail \"Auto…\") and the running turns of Droid, Qoder and Cursor", () => {
    const idle = " Auto… Claude Opus 5.5 API credits (High)\n╭──────╮\n│ >    │\n╰──────╯\n[⏱ 2m 36s] ? for help        MCP ✓ | IDE ◌";
    expect(roomTerminalMode("cli:droid", idle, ["build", "plan"])).toBe("build");
    expect(roomTerminalState(idle)).toBe("IDLE");
    expect(roomTerminalState(" ⠙ Thinking… (esc to interrupt)\n──────\n >   Type your message\n──────\n Qwen3.8-Flash Model · ctx 0% · /etc")).toBe("RUNNING");
    expect(roomTerminalState("──────\n >   Type your message\n──────\n Qwen3.8-Flash Model · ctx 0% · /etc")).toBe("IDLE");
    expect(roomTerminalState("  ⬢ Generating..  ctrl+c to stop\n → Add a follow-up")).toBe("RUNNING");
    expect(roomTerminalState(` ⠋ Executing...  (Press ESC to stop)\n${idle.replace("│ >    │", "│ > Enter to steer · Ctrl+Enter to queue │")}`)).toBe("RUNNING");
  });
});
