import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

const spaceRepository = SPACE_INSTALL_ROOT;
const queueDefaultTargetFile = `${SPACE_INSTALL_ROOT}/var/merge-queue/default-target`;

/**
 * New worktrees of the Space repository start from the branch the merge queue
 * deploys to by default: dev once the operator has switched submits to the dev
 * instance, main otherwise. Other repositories always start from main.
 */
export function defaultWorktreeBaseBranch(repoPath: string, targetFile = queueDefaultTargetFile): "dev" | "main" {
  if (resolve(repoPath) !== spaceRepository) return "main";
  try {
    return readFileSync(targetFile, "utf8").trim() === "dev" ? "dev" : "main";
  } catch {
    return "main";
  }
}
