import type { Artifact } from "@space/contracts";
import { api } from "../../api.js";

/** The newest page of Agent Files and the total count. */
export const fetchAgentFilesHead = () => api.artifacts({ collection: "AGENT_FILES", pageSize: 100, sortOrder: "desc" });

/** Every Agent File of every room, newest first; the API pages by 100. The dock keeps its own copy inside its load sequence. */
export async function fetchAllAgentFiles(firstPage?: Awaited<ReturnType<typeof fetchAgentFilesHead>>): Promise<Artifact[]> {
  firstPage ??= await fetchAgentFilesHead();
  const loaded = [...firstPage.data];
  if (firstPage.pagination.totalPages > 1) {
    const remainingPages = await Promise.all(
      Array.from({ length: firstPage.pagination.totalPages - 1 }, (_, i) =>
        api.artifacts({
          collection: "AGENT_FILES",
          page: i + 2,
          pageSize: 100,
          sortOrder: "desc"
        })
      )
    );
    for (const payload of remainingPages) {
      loaded.push(...payload.data);
    }
  }
  return loaded;
}

/** The file name Agent Files shows, or null when the record has none. */
export function agentFileName(artifact: Artifact): string | null {
  for (const key of ["originalFilename", "storedFilename"]) {
    const value = artifact.metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
