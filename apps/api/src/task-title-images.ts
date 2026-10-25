import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathInside, safeStorageSegment } from "./artifact-storage.js";

/**
 * Images a user attached to a task request, so the title model can see what
 * "fix this" refers to. Only this pane's own CLI uploads qualify: the room and
 * pane path segments must match the pane, and the resolved file must stay in
 * that directory. Paths typed by anyone else, symlinks and oversized files are
 * never read.
 */
export const taskTitleImagesMax = 2;
export const taskTitleImageMaxBytes = 8 * 1024 * 1024;

export interface TaskImageScope {
  artifactRoot: string;
  roomId: string;
  paneId: string;
  /** Session workspace, for Reasonix's `@.reasonix/attachments/...` references. */
  cwd?: string | null;
}

const imageExtension = "(?:png|jpe?g|webp|gif)";
// Upload layout: cli-uploads/<room>/<pane>/<session>/<YYYY-MM-DD>/<upload>-<name>.<ext>
const uploadSource =
  `/cli-uploads/([A-Za-z0-9._-]{1,140})/([A-Za-z0-9._-]{1,140})/([A-Za-z0-9._-]{1,140})/(\\d{4}-\\d{2}-\\d{2})/([\\w.@-]{1,200}\\.${imageExtension})(?![\\w.@-])`;
const reasonixSource =
  `@\\.reasonix/attachments/(clipboard-\\d{8}-\\d{6}\\.\\d{3}\\.${imageExtension})(?![\\w.@-])`;
// Global expressions carry lastIndex state, so every scan builds its own.
const pattern = (source: string, flags: string) => new RegExp(source, flags);

export function hasTaskImageReference(raw: string): boolean {
  return pattern(uploadSource, "i").test(raw) || pattern(reasonixSource, "i").test(raw);
}

/** Candidate image paths named in a raw request, latest last; no filesystem access. */
export function taskImageReferences(raw: string, scope: TaskImageScope): string[] {
  const room = safeStorageSegment(scope.roomId);
  const pane = safeStorageSegment(scope.paneId);
  const uploads = join(scope.artifactRoot, "cli-uploads");
  const paths: string[] = [];
  for (const match of raw.slice(-20_000).matchAll(pattern(uploadSource, "gi"))) {
    const [, roomSegment, paneSegment, session, day, file] = match;
    if (roomSegment !== room || paneSegment !== pane) continue;
    if ([session, file].some((part) => !part || part === "." || part === "..")) continue;
    paths.push(join(uploads, room, pane, session!, day!, file!));
  }
  if (scope.cwd) {
    for (const match of raw.slice(-20_000).matchAll(pattern(reasonixSource, "gi")))
      paths.push(join(scope.cwd, ".reasonix", "attachments", match[1]!));
  }
  return [...new Set(paths)].slice(-taskTitleImagesMax);
}

/** Re-validate at read time: a regular file inside this pane's upload directory. */
export async function readableTaskImages(paths: readonly string[], scope: TaskImageScope): Promise<string[]> {
  const roots = [
    join(scope.artifactRoot, "cli-uploads", safeStorageSegment(scope.roomId), safeStorageSegment(scope.paneId)),
    ...(scope.cwd ? [join(scope.cwd, ".reasonix", "attachments")] : []),
  ];
  const readable: string[] = [];
  for (const path of paths.slice(-taskTitleImagesMax)) {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size <= 0 || info.size > taskTitleImageMaxBytes) continue;
      const real = await realpath(path);
      const realRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => null)));
      if (realRoots.some((root) => root && pathInside(root, real))) readable.push(real);
    } catch {}
  }
  return readable;
}

export function taskImageMimeType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return extension === "jpg" || extension === "jpeg" ? "image/jpeg"
    : extension === "webp" ? "image/webp"
      : extension === "gif" ? "image/gif"
        : "image/png";
}
