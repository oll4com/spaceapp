import { createContext } from "react";
import type { Artifact } from "@space/contracts";

// Its own module so ChatMarkdown can read it without importing AgentFileLinks, which lazily imports the Agent Files preview (a cycle).
export type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] };

export interface AgentFileMentionLinks {
  remark: () => (tree: MarkdownNode) => void;
  artifact(href: string): Artifact | undefined;
  open(artifact: Artifact): void;
  /** An Agent File or workspace path link of this module: true, and its preview opens (a path is filed in Agent Files first). */
  openHref(href: string): boolean;
}

export const AgentFileMentionContext = createContext<AgentFileMentionLinks | null>(null);
