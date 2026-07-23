export interface CliHostIdentity {
  cliSessionId: string;
  paneId: string;
  roomId: string;
  runtimeId: string;
  codexThreadId: string | null;
  modelId: string | null;
  reasoningEffort: string | null;
}

export interface CliHostSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
}

export interface CliHostPty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
}

export interface CliHostOutputEvent {
  type: "output";
  generationId: string;
  sequence: number;
  stream: "stdout" | "stderr";
  data: string;
}

export interface CliHostStatusEvent {
  type: "status";
  status: "EXITED" | "ERROR";
  statusReason: string;
  exitCode: number;
  signal: number | null;
}

export type CliHostEvent = CliHostOutputEvent | CliHostStatusEvent;

export interface CliHostSessionSummary extends CliHostIdentity {
  generationId: string;
  pid: number;
  status: "RUNNING" | "EXITED" | "ERROR";
  statusReason: string | null;
  exitCode: number | null;
  signal: number | null;
  nextOutputSequence: number;
  attachmentCount: number;
  startedAt: string;
  detachedAt: string | null;
  endedAt: string | null;
}

export interface CliHostReapResult {
  killedSessions: CliHostSessionSummary[];
  skippedCount: number;
}

export interface CliHostAttachInput {
  identity: CliHostIdentity;
  spawn?: CliHostSpawnSpec;
  afterSequence?: number;
}

export interface CliHostAttachResult {
  attachmentId: string;
  session: CliHostSessionSummary;
  replay: CliHostOutputEvent[];
}

export interface CliHostInputResult {
  accepted: boolean;
  acceptedAtMs: number;
}

export type CliHostEventListener = (event: CliHostEvent) => void;

export type CliHostSpawn = (spec: CliHostSpawnSpec) => CliHostPty | Promise<CliHostPty>;
