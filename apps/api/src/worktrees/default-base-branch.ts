import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const spaceRepository = "/opt/spaceapp";
const queueDefaultTargetFile = "/opt/spaceapp/var/merge-queue/default-target";

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
