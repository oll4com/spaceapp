import type { OskCliCommand } from "../osk-keyboard/cli-shortcuts.js";

// TUI paste-burst detection can absorb an Enter delivered in the same input
// burst as command text. Let that burst settle before sending the real key.
export const CLI_SHORTCUT_ENTER_DELAY_MS = 250;

export async function submitCliShortcut(command: OskCliCommand, target: {
  isCurrent: () => boolean;
  prepare: () => Promise<void>;
  write: (text: string) => boolean;
  enter: () => boolean;
}) {
  const assertCurrent = () => {
    if (!target.isCurrent()) throw new Error("CLI connection or room changed. Shortcut cancelled.");
  };
  assertCurrent();
  await target.prepare();
  assertCurrent();
  if (!target.write(command.text)) throw new Error("CLI shortcut text could not be sent.");
  await new Promise<void>((resolve) => setTimeout(resolve, CLI_SHORTCUT_ENTER_DELAY_MS));
  assertCurrent();
  if (!target.enter()) throw new Error("CLI shortcut Enter could not be sent.");
}
