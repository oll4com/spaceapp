import { expect } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

/** Follow the user-visible menu; never invoke application action callbacks. */
export async function workspaceAction(name: string | RegExp, category: string, admin = false) {
  const navigation = await screen.findByRole("navigation", { name: "Workspace navigation" });
  if (admin) {
    const mode = within(navigation).getByRole("button", { name: "Admin mode" });
    if (mode.getAttribute("aria-pressed") === "false") fireEvent.click(mode);
  }
  const trigger = within(navigation).getByRole("button", { name: "Workspace" });
  if (trigger.getAttribute("aria-expanded") === "true") {
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull());
  }
  fireEvent.click(trigger);
  const menu = await screen.findByRole("dialog", { name: "Workspace" });
  fireEvent.click(within(menu).getByRole("tab", { name: category }));
  return within(menu).findByRole("button", { name });
}
