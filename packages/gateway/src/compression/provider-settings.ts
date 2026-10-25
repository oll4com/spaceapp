import type { GatewayCompressionProviderId, GatewayOutputPolicy, GatewaySettings } from "@space/contracts";

/** Compression and output policy for one provider: the global settings overlaid by the provider's own entry. */
export interface EffectiveCompression {
  mode: GatewaySettings["compressionMode"];
  profile: GatewaySettings["compressionProfile"];
  codeText: GatewaySettings["compressionCodeText"];
  timeBudgetMs: number;
  outputPolicy: GatewayOutputPolicy;
}

export function effectiveCompression(settings: GatewaySettings, provider: GatewayCompressionProviderId): EffectiveCompression {
  const entry = settings.compressionProviders?.[provider] ?? {};
  return {
    mode: entry.mode ?? settings.compressionMode,
    profile: entry.profile ?? settings.compressionProfile,
    codeText: entry.codeText ?? settings.compressionCodeText,
    timeBudgetMs: entry.timeBudgetMs ?? settings.compressionTimeBudgetMs,
    outputPolicy: entry.outputPolicy ?? "OFF"
  };
}

/** A request's compression mode: `x-space-gateway-compression: off` wins, then the key's override, then the provider. */
export function requestCompressionMode(effective: EffectiveCompression, keyOverride: GatewaySettings["compressionMode"] | null | undefined,
  headerValue: string | null | undefined): GatewaySettings["compressionMode"] {
  return headerValue?.toLowerCase() === "off" ? "OFF" : keyOverride ?? effective.mode;
}
