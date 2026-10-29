import type { SecurityAction, SecurityCopilotPaneMetadata, SecurityEvent, SecurityFinding, SecurityHost, SecurityRunStatus } from "@space/contracts";

// The shapes /api/panes/:id/security-copilot/state answers (apps/api/src/security-copilot/service.ts findingView, hostList, summary).
export interface SecurityFindingView {
  id: string; hostId: string; advisoryId: string; package: string; installedVersion: string; fixedVersion: string | null; priority: SecurityFinding["priority"];
  status: SecurityFinding["status"]; sources: string[]; severity: string; cvss: number | null; kev: boolean; aliases: string[]; title: string; references: string[];
  confirmedBy: string | null; firstSeenAt: string;
}
export type SecurityHostView = Omit<SecurityHost, "inventory"> & { packages: number; pendingSecurity: number; rebootRequired: boolean; openFindings: number };
export interface SecurityRunView { status: SecurityRunStatus; paused: boolean; autonomy: "ASSIST" | "FULL"; openQuestions: number; openReviews: number; pendingBriefs: number }
export interface SecuritySummary {
  openFindings: Record<"P0" | "P1" | "P2" | "P3", number>;
  hosts: { total: number; active: number; inventoried: number; rebootRequired: string[] };
  feeds: Record<string, { lastOkAt: string | null; lastError: string | null }>;
}
export interface SecurityCopilotState {
  metadata: SecurityCopilotPaneMetadata; run: SecurityRunView; summary: SecuritySummary; hosts: SecurityHostView[]; findings: SecurityFindingView[]; actions: SecurityAction[]; events: SecurityEvent[];
}
