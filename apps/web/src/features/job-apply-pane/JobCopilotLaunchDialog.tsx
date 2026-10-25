import type { JobCopilotLaunchSettings } from "@space/contracts";
import { JOB_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import { CopilotLaunchDialog, type CopilotLaunchChoice } from "../copilot-kit/CopilotLaunchDialog.js";

export type JobCopilotLaunchChoice = CopilotLaunchChoice;

/** The copilot kit's launch dialog bound to Job Copilot (Claude Code recommended, remembered in settings.jobCopilot). */
export function JobCopilotLaunchDialog({ preselect = null, notice = null, onClose, onCreate }: {
  preselect?: JobCopilotLaunchSettings | null;
  notice?: string | null;
  onClose(): void;
  onCreate(choice: JobCopilotLaunchChoice): Promise<void>;
}) {
  return <CopilotLaunchDialog kind={JOB_COPILOT_KIND} preselect={preselect} notice={notice} onClose={onClose} onCreate={onCreate} />;
}
