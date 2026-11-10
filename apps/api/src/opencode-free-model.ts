import { existsSync, readFileSync } from "node:fs";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

/** The daily picker's choice of free OpenCode Zen model (scripts/space-opencode-free-model-picker.mjs). */
export const OPENCODE_FREE_MODEL_STATE_FILE = `${SPACE_INSTALL_ROOT}/var/space-opencode-free-model.json`;

export function readActiveFreeOpenCodeModel(stateFile = OPENCODE_FREE_MODEL_STATE_FILE): string {
  try {
    if (existsSync(stateFile)) {
      const data = JSON.parse(readFileSync(stateFile, "utf8"));
      if (typeof data?.modelId === "string" && data.modelId.length > 0) {
        return data.modelId;
      }
    }
  } catch {}
  return "opencode/big-pickle";
}
