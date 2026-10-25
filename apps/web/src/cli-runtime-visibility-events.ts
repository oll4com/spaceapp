import { cliToggleRuntimeIdSchema, type CliToggleRuntimeId } from "@space/contracts";

export const CLI_RUNTIME_VISIBILITY_EVENT = "space:cli-runtime-visibility-changed";

export interface CliRuntimeVisibilityChange {
  runtimeId?: CliToggleRuntimeId;
  enabled?: boolean;
  source: "server" | "settings-card";
}

export function dispatchCliRuntimeVisibilityChange(detail: CliRuntimeVisibilityChange): void {
  window.dispatchEvent(new CustomEvent<CliRuntimeVisibilityChange>(CLI_RUNTIME_VISIBILITY_EVENT, { detail }));
}

export function readCliRuntimeVisibilityChange(event: Event): CliRuntimeVisibilityChange | null {
  if (!(event instanceof CustomEvent) || !event.detail || typeof event.detail !== "object") return null;
  const detail = event.detail as Partial<CliRuntimeVisibilityChange>;
  if (detail.source !== "server" && detail.source !== "settings-card") return null;
  const runtimeId = detail.runtimeId === undefined
    ? undefined
    : cliToggleRuntimeIdSchema.safeParse(detail.runtimeId);
  if (runtimeId && !runtimeId.success) return null;
  if (detail.enabled !== undefined && typeof detail.enabled !== "boolean") return null;
  return {
    runtimeId: runtimeId?.data,
    enabled: detail.enabled,
    source: detail.source
  };
}
