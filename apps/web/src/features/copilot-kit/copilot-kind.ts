import type { CopilotLaunchSettings, Pane, UserSettings } from "@space/contracts";

/**
 * A copilot pane kind: a pane mode that runs its agent in the pane's own CLI session, chosen once in the
 * launch dialog (CLI runtime + account, the Space Gateway pool first) and remembered in the user's settings.
 * The account lives in the pane's CLI session, never in the pane row (the Browser Host parses pane rows with
 * the contracts it loaded at start).
 */
export interface CopilotKind {
  id: "job" | "mail" | "marketing" | "freelance" | "design" | "app-studio" | "video" | "security";
  mode: "JOB_APPLY" | "MAIL_COPILOT" | "MARKETING_COPILOT" | "FREELANCE_COPILOT" | "DESIGN" | "APP_STUDIO" | "VIDEO" | "SECURITY_COPILOT";
  /** "Job Copilot", "Mail Copilot": the Create menu entry, dialog titles and notices. */
  label: string;
  /** The CLI recommended for this copilot (Claude Code: long, tool-heavy loops with native MCP and account profiles). */
  preferredRuntimeId: string;
  /** Why the recommended CLI is recommended, shown next to it in the launch dialog. */
  recommendedReason: string;
  /** Settings card: what the default agent does. */
  agentDescription: string;
  /** Launch dialog copy. */
  launchHeading: string;
  launchDescription: string;
  /** Where the default agent is changed, named in notices ("Settings → Job Copilot"). */
  settingsPlace: string;
  /** The user-settings key holding the remembered agent. */
  settingsKey: "jobCopilot" | "mailCopilot" | "marketingCopilot" | "freelanceCopilot" | "design" | "appStudio" | "video" | "securityCopilot";
  /** Prefix of the settings card's form control names ("job-copilot"). */
  controlPrefix: string;
  /** The remembered launch of this kind in the user's settings. */
  remembered(settings: Pick<UserSettings, "jobCopilot" | "mailCopilot" | "marketingCopilot" | "freelanceCopilot" | "design" | "appStudio" | "video" | "securityCopilot">): CopilotLaunchSettings | null;
}

export const JOB_COPILOT_KIND: CopilotKind = {
  id: "job",
  mode: "JOB_APPLY",
  label: "Job Copilot",
  preferredRuntimeId: "cli:claude",
  recommendedReason: "Recommended: native MCP, skills, account profiles",
  agentDescription: "The AI coding CLI that applies for you. Claude Code is recommended for long, tool-heavy application loops.",
  launchHeading: "Choose the agent that applies for you",
  launchDescription: "The copilot runs long, tool-heavy application loops in this pane's own CLI. Claude Code is recommended; any ready CLI works.",
  settingsPlace: "Settings → Job Copilot",
  settingsKey: "jobCopilot",
  controlPrefix: "job-copilot",
  remembered: (settings) => settings.jobCopilot ?? null
};

export const MAIL_COPILOT_KIND: CopilotKind = {
  id: "mail",
  mode: "MAIL_COPILOT",
  label: "Mail Copilot",
  preferredRuntimeId: "cli:claude",
  recommendedReason: "Recommended: native MCP, skills, account profiles",
  agentDescription: "The AI coding CLI that reads, triages and answers your mail. Claude Code is recommended for long, tool-heavy loops.",
  launchHeading: "Choose the agent that handles your mail",
  launchDescription: "The copilot reads your Gmail accounts, learns how you answer and triages mail in this pane's own CLI. Claude Code is recommended; any ready CLI works.",
  settingsPlace: "Settings → Mail Copilot",
  settingsKey: "mailCopilot",
  controlPrefix: "mail-copilot",
  remembered: (settings) => settings.mailCopilot ?? null
};

export const MARKETING_COPILOT_KIND: CopilotKind = {
  id: "marketing",
  mode: "MARKETING_COPILOT",
  label: "Marketing Copilot",
  preferredRuntimeId: "cli:claude",
  recommendedReason: "Recommended: native MCP, skills, account profiles",
  agentDescription: "The AI coding CLI that plans, writes and publishes posts that promote SpaceApp. Claude Code is recommended for long, tool-heavy loops.",
  launchHeading: "Choose the agent that markets SpaceApp",
  launchDescription: "The copilot plans campaigns, drafts posts and publishes them on your own accounts through this pane's browser once you approve. Claude Code is recommended; any ready CLI works.",
  settingsPlace: "Settings → Marketing Copilot",
  settingsKey: "marketingCopilot",
  controlPrefix: "marketing-copilot",
  remembered: (settings) => settings.marketingCopilot ?? null
};

export const FREELANCE_COPILOT_KIND: CopilotKind = {
  id: "freelance",
  mode: "FREELANCE_COPILOT",
  label: "Freelance Copilot",
  preferredRuntimeId: "cli:claude",
  recommendedReason: "Recommended: native MCP, skills, account profiles",
  agentDescription: "The AI coding CLI that finds clients for oll4.com, sends proposals and answers them until they are ready for you. Claude Code is recommended for long, tool-heavy loops.",
  launchHeading: "Choose the agent that finds your clients",
  launchDescription: "The copilot registers on the freelance platforms, qualifies leads, sends proposals and talks to clients through this pane's browser, and hands you every client who wants to go ahead. Claude Code is recommended; any ready CLI works.",
  settingsPlace: "Settings → Freelance Copilot",
  settingsKey: "freelanceCopilot",
  controlPrefix: "freelance-copilot",
  remembered: (settings) => settings.freelanceCopilot ?? null
};

/** The Design pane: a graphics studio whose designer runs in the pane's CLI (operator decision 2026-10-18: Claude Code). */
export const DESIGN_KIND: CopilotKind = {
  id: "design",
  mode: "DESIGN",
  label: "Design",
  preferredRuntimeId: "cli:claude",
  recommendedReason: "Recommended: native MCP, skills, image viewing",
  agentDescription: "The AI coding CLI that designs graphics for you and for other agents and panes. Claude Code is recommended.",
  launchHeading: "Choose the designer",
  launchDescription: "The designer makes social graphics, banners and short motion in this pane: images through Space Gateway, templates for exact text, your brand kits. Claude Code is recommended; any ready CLI works.",
  settingsPlace: "Settings → Design",
  settingsKey: "design",
  controlPrefix: "design",
  remembered: (settings) => settings.design ?? null
};

/** The App Studio pane: mobile apps (Expo) built by the pane's CLI agent, previewed per phone (plan clipboard:v7hyZ76ThCyv). */
export const APP_STUDIO_KIND: CopilotKind = {
  id: "app-studio",
  mode: "APP_STUDIO",
  label: "App Studio",
  preferredRuntimeId: "cli:claude",
  recommendedReason: "Recommended: native MCP, skills, image viewing",
  agentDescription: "The AI coding CLI that builds your mobile apps for Android and iOS. Claude Code is recommended.",
  launchHeading: "Choose the app builder",
  launchDescription: "The app builder makes Android and iOS apps with Expo in this pane and shows every screen on the most-used phones. Claude Code is recommended; any ready CLI works.",
  settingsPlace: "Settings → App Studio",
  settingsKey: "appStudio",
  controlPrefix: "app-studio",
  remembered: (settings) => settings.appStudio ?? null
};

/** The Video pane: a video studio whose editor runs in the pane's CLI (plan clipboard:-HpLbbtWKj53). */
export const VIDEO_KIND: CopilotKind = {
  id: "video",
  mode: "VIDEO",
  label: "Video",
  preferredRuntimeId: "cli:claude",
  recommendedReason: "Recommended: native MCP, skills, image viewing",
  agentDescription: "The AI coding CLI that cuts, captions, narrates and scores videos for you and for other agents and panes. Claude Code is recommended.",
  launchHeading: "Choose the editor",
  launchDescription: "The editor cuts your videos into every social format in this pane: automatic clipping, transitions, captions, narration and music. Claude Code is recommended; any ready CLI works.",
  settingsPlace: "Settings → Video",
  settingsKey: "video",
  controlPrefix: "video",
  remembered: (settings) => settings.video ?? null
};

/** The Security Copilot pane: keeps every Proxmox host and SpaceApp patched through the server's gate (plan clipboard:8ce8_URHW9Dk). */
export const SECURITY_COPILOT_KIND: CopilotKind = {
  id: "security",
  mode: "SECURITY_COPILOT",
  label: "Security Copilot",
  preferredRuntimeId: "cli:claude",
  recommendedReason: "Recommended: native MCP, skills, long tool-heavy loops",
  agentDescription: "The AI coding CLI that inventories your servers, triages new vulnerabilities and applies the fixes. Claude Code is recommended.",
  launchHeading: "Choose the security engineer",
  launchDescription: "The security engineer inventories every Proxmox host, triages what the vulnerability feeds find and fixes it through Space's gate: backup first, verify after, reboots and deletes wait for you. Claude Code is recommended; any ready CLI works.",
  settingsPlace: "Settings → Security Copilot",
  settingsKey: "securityCopilot",
  controlPrefix: "security-copilot",
  remembered: (settings) => settings.securityCopilot ?? null
};

export const COPILOT_KINDS: readonly CopilotKind[] = [JOB_COPILOT_KIND, MAIL_COPILOT_KIND, MARKETING_COPILOT_KIND, FREELANCE_COPILOT_KIND, DESIGN_KIND, APP_STUDIO_KIND, VIDEO_KIND, SECURITY_COPILOT_KIND];

export function copilotKindForMode(mode: Pane["mode"]): CopilotKind | null {
  return COPILOT_KINDS.find((kind) => kind.mode === mode) ?? null;
}
