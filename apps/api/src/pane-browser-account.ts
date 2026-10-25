/** The Google account and profile a browser/YouTube pane opens with (moved verbatim from the composition root). */
import type { GoogleAccount } from "@space/runtime";

export interface PaneBrowserAccount { selectedProfileId: string | null; account?: GoogleAccount; profileKey: string | null; sharedProfileKey?: string }
