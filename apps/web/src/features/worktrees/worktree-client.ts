import type {
  CreateWorktreeInput,
  MergeWorktreeInput,
  SpaceWorktree,
  WorktreeOperationResult
} from "@space/contracts";

let csrfCache: { token: string; headerName: string; expiresAt: number } | null = null;

async function getCsrfHeader(signal?: AbortSignal): Promise<Record<string, string>> {
  if (csrfCache && csrfCache.expiresAt > Date.now()) {
    return { [csrfCache.headerName]: csrfCache.token };
  }
  try {
    const res = await fetch("/api/auth/csrf", { credentials: "same-origin", signal });
    if (res.ok) {
      const data = (await res.json()) as { csrfToken: string; headerName?: string };
      const headerName = data.headerName || "x-space-csrf-token";
      csrfCache = { token: data.csrfToken, headerName, expiresAt: Date.now() + 60_000 };
      return { [headerName]: data.csrfToken };
    }
  } catch {}
  return {};
}

export async function fetchWorktrees(repoPath = "/opt/spaceapp"): Promise<SpaceWorktree[]> {
  const res = await fetch(`/api/worktrees?repoPath=${encodeURIComponent(repoPath)}`, {
    credentials: "same-origin"
  });
  if (!res.ok) throw new Error("Failed to load worktrees");
  const json = await res.json();
  return json.data ?? [];
}
export const listWorktrees = fetchWorktrees;

export async function createWorktree(input: CreateWorktreeInput): Promise<SpaceWorktree> {
  const csrf = await getCsrfHeader();
  const res = await fetch("/api/worktrees", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...csrf
    },
    body: JSON.stringify(input)
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) csrfCache = null;
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error?.message || "Failed to create worktree");
  }
  const json = await res.json();
  return json.data;
}

export async function mergeWorktree(
  path: string,
  input: MergeWorktreeInput = { strategy: "merge", deleteBranchAfter: true }
): Promise<WorktreeOperationResult> {
  const csrf = await getCsrfHeader();
  const res = await fetch("/api/worktrees/merge", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...csrf
    },
    body: JSON.stringify({ path, ...input })
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) csrfCache = null;
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error?.message || "Failed to merge worktree");
  }
  return res.json();
}

export async function removeWorktree(path: string, force = false): Promise<void> {
  const csrf = await getCsrfHeader();
  const res = await fetch(`/api/worktrees?path=${encodeURIComponent(path)}&force=${force}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: {
      ...csrf
    }
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) csrfCache = null;
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error?.message || "Failed to remove worktree");
  }
}
