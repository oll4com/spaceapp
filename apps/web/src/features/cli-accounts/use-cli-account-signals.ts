import { useCallback, useEffect, useState } from "react";
import type { CliAccountIdentitiesResponse, CliAccountIdentity } from "@space/contracts";
import {
  fetchSharedQuotaMetrics,
  peekSharedQuotaMetrics,
  subscribeSharedQuota,
  type SharedQuotaCache,
} from "../desktop-widgets/shared-quota-cache.js";
import {
  fetchCliAccountIdentities,
  peekCliAccountIdentities,
  subscribeCliAccountIdentities,
} from "./cli-account-identities.js";

export interface CliAccountSignals {
  quota: SharedQuotaCache | null;
  identities: CliAccountIdentity[] | null;
  // Reads both shared samples; each is deduplicated and cached across every consumer.
  load: (options?: { forceIdentities?: boolean; refreshIdentities?: boolean; forceQuota?: boolean }) => void;
}

export function useCliAccountSignals(
  identitiesLoader?: (refresh: boolean) => Promise<CliAccountIdentitiesResponse>,
): CliAccountSignals {
  const [quota, setQuota] = useState<SharedQuotaCache | null>(peekSharedQuotaMetrics);
  const [identities, setIdentities] = useState<CliAccountIdentity[] | null>(peekCliAccountIdentities);

  useEffect(() => {
    setQuota(peekSharedQuotaMetrics());
    setIdentities(peekCliAccountIdentities());
    const stopQuota = subscribeSharedQuota(setQuota);
    const stopIdentities = subscribeCliAccountIdentities(setIdentities);
    return () => {
      stopQuota();
      stopIdentities();
    };
  }, []);

  const load = useCallback((options: { forceIdentities?: boolean; refreshIdentities?: boolean; forceQuota?: boolean } = {}) => {
    void fetchSharedQuotaMetrics(Boolean(options.forceQuota)).catch(() => undefined);
    void fetchCliAccountIdentities({
      force: options.forceIdentities,
      refresh: options.refreshIdentities,
      loader: identitiesLoader,
    }).catch(() => undefined);
  }, [identitiesLoader]);

  return { quota, identities, load };
}
