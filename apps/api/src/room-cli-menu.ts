import { SpaceConflictError } from "@space/runtime";

export interface RoomCliScreen { text: string; revision: number }

/**
 * Moves a CLI menu's highlight down to the row naming `selection` and picks it with Enter.
 * `observe` re-checks the pane's session before reading the screen. When the row never
 * appears, the menu `command` opened is closed so the pane is not left waiting on it.
 */
export async function selectRoomCliMenuRow(input: {
  screen: RoomCliScreen;
  selection: string;
  command?: string;
  send: (data: string, step: string) => Promise<unknown>;
  observe: () => Promise<RoomCliScreen>;
  wait?: (ms: number) => Promise<unknown>;
}): Promise<RoomCliScreen> {
  const wait = input.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let screen = input.screen;
  for (let attempt = 0; attempt < 32; attempt++) {
    const highlighted = screen.text.split("\n").filter((line) => /^\s*[❯›>●]/u.test(line));
    if (highlighted.some((line) => line.includes(input.selection))) {
      const revision = screen.revision;
      await input.send("\r", "select");
      for (let poll = 0; poll < 20; poll++) {
        await wait(100);
        screen = await input.observe();
        if (screen.revision !== revision) break;
      }
      if (screen.revision === revision) throw new SpaceConflictError("The CLI did not acknowledge the menu selection.");
      return screen;
    }
    if (!screen.text.includes(input.selection)) break;
    await input.send("\u001b[B", `selection:${attempt}`);
    await wait(150);
    screen = await input.observe();
  }
  if (input.command?.startsWith("/")) await input.send("\u001b", "selection:escape").catch(() => {});
  throw new SpaceConflictError("The requested menu selection could not be verified; inspect the pane's current menu.");
}

/**
 * Resumes `source` through the CLI's native /resume menu. A task already running in the pane's live session needs
 * no menu: Hermes even leaves the current session out of its numbered /resume list.
 */
export async function resumeRoomCliFromMenu(input: {
  paneId: string;
  ready: { sessionId: string; status: string };
  source: { title: string; session: { sessionId: string } } | null;
  command: (selection: string | undefined) => Promise<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  if (input.source?.session.sessionId === input.ready.sessionId) return { paneId: input.paneId, sessionId: input.ready.sessionId, state: input.ready.status };
  return { ...await input.command(input.source?.title), phase: "NATIVE_RESUME_MENU", verification: "Inspect the selected native task before reporting resume complete." };
}
