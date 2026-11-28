/** Nous Cloud telemetry (operator 27/11: «θέλω τηλεμετρία θέλω τα πάντα»): one row per install, read from oll4.com's cloud-stats; ADMIN only. */
export interface NousCloudDay {
  d: string;
  sandboxSeconds: number;
  sandboxCostUsd: number | null;
  requests: number;
  errors: number;
  tokens: number;
  modelCostUsd: number;
  events: Record<string, number>;
}

export interface NousCloudModel {
  model: string;
  source: "nous" | "cli";
  requests: number;
  errors: number;
  tokens: number;
  costUsd: number;
  free: boolean;
}

export interface NousCloudInstall {
  person: number;
  name: string;
  email: string;
  status: "running" | "asleep" | "revoked";
  revokedAt: string | null;
  lastSeen: string | null;
  app: { version: string | null; device: string | null; at: string | null; build: number | null };
  sandbox: {
    at: string;
    uptimeSeconds: number | null;
    version: string | null;
    usdPerHour: number | null;
    dbBytes: number | null;
    disk: { size: number; used: number } | null;
    memory: { total: number; used: number } | null;
  } | null;
  lastTurn: string | null;
  lastError: { at: string; text: string; source: "sandbox" | "app" } | null;
  logins: number | null;
  lastLogin: string | null;
  models: NousCloudModel[];
  days: NousCloudDay[];
  totals: { sandboxSeconds: number; sandboxCostUsd: number | null; requests: number; errors: number; tokens: number; modelCostUsd: number };
}

export interface NousCloudReport {
  at: string;
  days: number;
  installs: NousCloudInstall[];
}
