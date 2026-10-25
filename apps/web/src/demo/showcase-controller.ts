export const showcaseChapters = {
  layouts: [
    "Choose your layout",
    "Two columns",
    "One column",
    "Focus on one pane",
    "Adjust pane height",
    "Back to your overview",
  ],
  docks: [
    "Room Agent",
    "Clipboard & plans",
    "Agent Files",
    "Tasks",
    "Agent Session History",
  ],
  rooms: ["Build", "Research", "Create", "Remote", "Back to Build"],
  panes: [
    "Choose your tools",
    "Your coding agents",
    "More agent runtimes",
    "Research tools",
    "Create & talk",
    "Remote tools",
  ],
} as const;
export type ShowcaseChapter = keyof typeof showcaseChapters;
const explanations: Record<ShowcaseChapter, readonly string[]> = {
  layouts: [
    "Use the real Pane layout menu to shape your workspace.",
    "Keep four panes together in a 2 × 2 view.",
    "Stack panes in one column and scroll through your work.",
    "Give one pane the whole workspace, then return to the rest.",
    "Change pane height without rebuilding your room.",
    "Your agents stay in place as you change the view.",
  ],
  docks: [
    "Give the room direction and keep the conversation beside your work.",
    "Keep notes, reusable text and plans within reach.",
    "Find the files and outputs your agents have published.",
    "Track work and review what needs attention.",
    "Find earlier agent sessions and pick up their context.",
  ],
  rooms: [
    "Coding agents, side by side in their own panes.",
    "Chat, browser, YouTube and files in one research room.",
    "Demo Projects, live audio, Harness and project files together.",
    "A remote desktop, browser, terminal and notes in one view.",
    "Return to the same room with its panes and layout preserved.",
  ],
  panes: [
    "Add chat, browser, files, demos, video, VNC, Live or Harness.",
    "Choose your CLI from the actual SpaceApp agent catalog.",
    "Different runtimes. The same workspace controls.",
    "Mix research tools instead of opening another workspace.",
    "Bring project demos, conversation and files into your room.",
    "Use remote desktop and coding tools alongside each other.",
  ],
};
const isShown = (el: HTMLElement) =>
  el.getBoundingClientRect().width > 0 &&
  el.getBoundingClientRect().height > 0 &&
  !el.closest('[aria-hidden="true"]');
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.getAttribute("aria-label") === label && isShown(b),
  );
async function until<T>(
  get: () => T | null | undefined | false,
  signal: AbortSignal,
): Promise<T> {
  for (let i = 0; i < 100; i++) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const v = get();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("The requested workspace control is not ready.");
}
async function click(label: string, signal: AbortSignal) {
  const el = await until(() => button(label), signal);
  if (el.disabled) await until(() => !el.disabled, signal);
  el.click();
  return el;
}
const settle = () => new Promise((r) => setTimeout(r, 250));
function closeMenu() {
  button("Close menu")?.click();
  document
    .querySelector<HTMLElement>(
      '[role="menu"][aria-label="Pane layout presets"]',
    )
    ?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
}
async function dock(surface: string, label: string, signal: AbortSignal) {
  closeMenu();
  const current = document.querySelector<HTMLElement>(
    `.side-surface[data-surface="${surface}"]`,
  );
  if (current && isShown(current)) return current;
  await click("Show docks", signal);
  await click(label, signal);
  return until(() => {
    const el = document.querySelector<HTMLElement>(
      `.side-surface[data-surface="${surface}"]`,
    );
    return el && isShown(el) ? el : null;
  }, signal);
}
async function room(name: string, signal: AbortSignal) {
  await dock("rooms", "Show rooms", signal);
  await click(`Open ${name}`, signal);
  await settle();
  return (
    document.querySelector<HTMLElement>(".pane-grid") ??
    document.querySelector<HTMLElement>(".workspace")!
  );
}
async function layout(label: string, signal: AbortSignal) {
  closeMenu();
  await click("Pane layout", signal);
  const el = await until(
    () =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="menuitemradio"]',
        ),
      ].find(
        (b) =>
          b.getAttribute("aria-label")?.startsWith(label + ",") && isShown(b),
      ),
    signal,
  );
  el.click();
  await settle();
}
async function apply(
  chapter: ShowcaseChapter,
  step: number,
  signal: AbortSignal,
) {
  document
    .querySelectorAll(".showcase-highlight")
    .forEach((e) => e.classList.remove("showcase-highlight"));
  let focus: HTMLElement | null = null;
  if (chapter === "layouts") {
    await room("Build", signal);
    if (step === 0) {
      await layout("Automatic", signal);
      await click("Pane layout", signal);
      focus = await until(
        () =>
          document.querySelector<HTMLElement>(
            '[role="menu"][aria-label="Pane layout presets"]',
          ),
        signal,
      );
    } else if (step === 1) await layout("2 columns", signal);
    else if (step === 2) await layout("1 column", signal);
    else if (step === 3) await layout("Fullscreen", signal);
    else if (step === 4) {
      await layout("2 columns", signal);
      await click("Pane layout", signal);
      await click("Height 2", signal);
      focus = document.querySelector(
        '[role="menu"][aria-label="Pane layout presets"]',
      );
    } else {
      await layout("2 columns", signal);
      await click("Pane layout", signal);
      await click("Height 1", signal);
      closeMenu();
    }
  } else if (chapter === "docks") {
    const entries = [
      ["room-agent", "Show room agent"],
      ["clipboard", "Show clipboard"],
      ["agent-files", "Open Agent Files"],
      ["tasks", "Show tasks"],
      ["agent-sessions", "Show agent session history"],
    ] as const;
    const [surface, label] = entries[step]!;
    focus = await dock(surface, label, signal);
  } else if (chapter === "rooms") {
    focus = await room(
      ["Build", "Research", "Create", "Remote", "Build"][step]!,
      signal,
    );
  } else if (step < 3) {
    await room("Build", signal);
    await click("Create", signal);
    const cli =
      step === 0 ? "Add chat pane" : step === 1 ? "Gemini CLI" : "Droid CLI";
    const item = await until(
      () =>
        [...document.querySelectorAll<HTMLElement>("button")].find(
          (e) => isShown(e) && e.textContent?.trim().startsWith(cli),
        ),
      signal,
    );
    item.scrollIntoView({
      block: step === 0 ? "start" : "center",
      behavior: "instant",
    });
    focus =
      item.closest<HTMLElement>(
        '[role="dialog"],.workspace-menu,.toolbar-floating-menu',
      ) ?? item.parentElement;
  } else
    focus = await room(["Research", "Create", "Remote"][step - 3]!, signal);
  await settle();
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  focus ??=
    document.querySelector<HTMLElement>(".pane-grid") ??
    document.querySelector<HTMLElement>(".workspace");
  // Highlight the real surface. Do not replace any of its content.
  focus?.classList.add("showcase-highlight");
  const rect = focus?.getBoundingClientRect();
  return {
    title: showcaseChapters[chapter][step],
    caption: explanations[chapter][step],
    focus: rect
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      : null,
  };
}
export function installShowcaseController() {
  let active: AbortController | null = null;
  const send = (payload: object) =>
    window.parent.postMessage(
      { type: "space-showcase:event", ...payload },
      location.origin,
    );
  const onMessage = (event: MessageEvent) => {
    if (
      event.origin !== location.origin ||
      event.source !== window.parent ||
      !event.data ||
      event.data.type !== "space-showcase:command"
    )
      return;
    const { command, scene, step, requestId } = event.data;
    if (command === "hello") {
      send({ event: "ready" });
      return;
    }
    if (command === "pause") {
      active?.abort();
      return;
    }
    if (
      command !== "step" ||
      !Object.hasOwn(showcaseChapters, scene) ||
      !Number.isInteger(step) ||
      step < 0 ||
      step >= showcaseChapters[scene as ShowcaseChapter].length ||
      typeof requestId !== "number"
    )
      return;
    active?.abort();
    active = new AbortController();
    const signal = active.signal;
    void apply(scene, step, signal)
      .then((result) => {
        if (!signal.aborted)
          send({ event: "step", scene, step, requestId, ...result });
      })
      .catch((error) => {
        if (!signal.aborted)
          send({ event: "error", requestId, message: String(error.message) });
      });
  };
  window.addEventListener("message", onMessage);
  send({ event: "ready" });
  return () => {
    active?.abort();
    window.removeEventListener("message", onMessage);
    document
      .querySelectorAll(".showcase-highlight")
      .forEach((e) => e.classList.remove("showcase-highlight"));
  };
}
