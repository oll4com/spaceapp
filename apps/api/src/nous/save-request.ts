/**
 * The texts of a finished pane's memory save (standing orders, operator orders 2026-10-21), on their own so tools.ts (which records
 * what Nous sent) and standing-orders.ts (which verifies and lists it) share them without a dependency cycle.
 */
/** The web quick action's exact text: the CLI runs /opt/spaceapp/bin/space-memory-save on it (bootstrap "Memory parity"). */
export const NOUS_SAVE_TEXT = "save to memory";
export const NOUS_SAVE_RETRY_TEXT = "Run /opt/spaceapp/bin/space-memory-save with a title, tags and a body of what you learned in this pane, then print the returned id.";
/** What counts as asking a pane to save: the quick action's exact text, or the script by name. */
export const NOUS_SAVE_REQUEST = /^\s*save to memory[.!]?\s*$|space-memory-save/i;
