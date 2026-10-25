import { useEffect, useState } from "react";
import { peekSharedQuotaMetrics, subscribeSharedQuota } from "../desktop-widgets/shared-quota-cache.js";
import { OpenAiIcon } from "../ui-theme/OpenAiIcon.js";
import { CODEX_GATEWAY_PROFILE_ID } from "./cli-account-availability.js";
import { CliAccountPicker } from "./CliAccountPicker.js";

const gatewayProfiles = [{ profileId: CODEX_GATEWAY_PROFILE_ID, displayName: "Space Gateway" }];

// Codex panes run on Space Gateway, which picks one of its ChatGPT accounts for each thread, so the menu shows the
// gateway and the quota of its pool. Once the gateway reports no ChatGPT accounts, Codex signs in on its own and the
// button stays hidden.
export function CodexAccountPicker({ paneTitle, disabled = false }: { paneTitle: string; disabled?: boolean }) {
  const [quota, setQuota] = useState(peekSharedQuotaMetrics);
  useEffect(() => subscribeSharedQuota(setQuota), []);
  if (quota?.codex && !quota.codex.isStale && quota.codex.data.length === 0) return null;
  return (
    <CliAccountPicker
      runtimeId="cli:codex"
      providerLabel="ChatGPT"
      icon={<OpenAiIcon size={16} />}
      paneTitle={paneTitle}
      profiles={gatewayProfiles}
      selectedProfileId={CODEX_GATEWAY_PROFILE_ID}
      disabled={disabled}
      onSelect={() => undefined}
    />
  );
}
