import { useEffect, useState, useCallback } from "react";
import type { CliProviderSetting, CliProviderSettingsResponse } from "@space/contracts";
import { api } from "../../api.js";
import { SettingsDisclosure } from "../settings/SettingsDisclosure.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { Boxes, RefreshCw } from "../ui-theme/app-icons.js";
import { DockButton, DockIconButton, DockNotice } from "../dock-kit/DockKit.js";
import "./cli-providers-settings.css";

export interface CliProvidersClient {
  cliProviderSettings?: () => Promise<CliProviderSettingsResponse>;
  updateCliProviderSetting?: (providerId: string, enabled: boolean) => Promise<CliProviderSettingsResponse>;
  updateAllCliProviders?: (enabled: boolean) => Promise<CliProviderSettingsResponse>;
}

export interface CliProvidersSettingsCardProps {
  canManage: boolean;
  client?: CliProvidersClient;
  initialOpen?: boolean;
}

export function CliProvidersSettingsCard({ canManage, client, initialOpen = false }: CliProvidersSettingsCardProps) {
  const [providers, setProviders] = useState<CliProviderSetting[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pendingBulk, setPendingBulk] = useState(false);

  const fetchProviders = useCallback(async () => {
    if (client?.cliProviderSettings) return client.cliProviderSettings();
    return api.cliProviderSettings();
  }, [client]);

  const updateProvider = useCallback(async (providerId: string, enabled: boolean) => {
    if (client?.updateCliProviderSetting) return client.updateCliProviderSetting(providerId, enabled);
    return api.updateCliProviderSetting(providerId, enabled);
  }, [client]);

  const updateAll = useCallback(async (enabled: boolean) => {
    if (client?.updateAllCliProviders) return client.updateAllCliProviders(enabled);
    return api.updateAllCliProviders(enabled);
  }, [client]);

  // A reload after a failed update keeps that error visible instead of clearing it at once.
  const loadProviders = useCallback(async (keepError = false) => {
    setLoading(true);
    if (!keepError) setError(null);
    try {
      const response = await fetchProviders();
      setProviders(response.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load CLI providers.");
    } finally {
      setLoading(false);
    }
  }, [fetchProviders]);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const handleToggle = async (providerId: string, enabled: boolean) => {
    if (!canManage) return;
    setPendingId(providerId);
    setError(null);

    // Optimistic update
    setProviders((current) =>
      current.map((p) => (p.id === providerId ? { ...p, enabled } : p))
    );

    try {
      const response = await updateProvider(providerId, enabled);
      setProviders(response.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to update provider ${providerId}.`);
      void loadProviders(true);
    } finally {
      setPendingId(null);
    }
  };

  const handleToggleAll = async (enabled: boolean) => {
    if (!canManage) return;
    setPendingBulk(true);
    setError(null);

    // Optimistic update
    setProviders((current) => current.map((p) => ({ ...p, enabled })));

    try {
      const response = await updateAll(enabled);
      setProviders(response.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${enabled ? "enable" : "disable"} all providers.`);
      void loadProviders(true);
    } finally {
      setPendingBulk(false);
    }
  };

  const enabledCount = providers.filter((p) => p.enabled).length;

  return (
    <SettingsDisclosure
      title="CLI providers"
      description="Choose which model providers OpenCode and the CLI tools can use."
      scope="Installation"
      icon={Boxes}
      initialOpen={initialOpen}
    >
      <section className="agent-settings-card settings-flat-card cli-providers-settings-card" aria-label="CLI provider settings">
        <div className="agent-settings-section-title settings-flat-heading">
          <Boxes aria-hidden="true" />
          <span>
            <strong>CLI providers</strong>
            <small>
              {loading && providers.length === 0
                ? "Loading providers…"
                : `${enabledCount} of ${providers.length} providers enabled.`}
            </small>
          </span>
          <div className="settings-flat-heading-actions">
            <DockIconButton
              label="Refresh providers"
              icon={RefreshCw}
              busy={loading}
              disabled={loading || Boolean(pendingId) || pendingBulk}
              onClick={() => void loadProviders()}
            />
          </div>
        </div>

        <div className="cli-providers-toolbar">
          <DockButton
            disabled={!canManage || loading || Boolean(pendingId) || pendingBulk}
            onClick={() => void handleToggleAll(true)}
            title="Enable all providers"
            aria-label="Enable all providers"
          >
            Enable all
          </DockButton>
          <DockButton
            disabled={!canManage || loading || Boolean(pendingId) || pendingBulk}
            onClick={() => void handleToggleAll(false)}
            title="Disable all providers"
            aria-label="Disable all providers"
          >
            Disable all
          </DockButton>
        </div>

        {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}

        {providers.map((provider) => (
          <SpaceToggle
            key={provider.id}
            className="settings-flat-row settings-flat-toggle-row"
            name={`cli-provider-${provider.id}`}
            ariaLabel={`Enable ${provider.name}`}
            label={
              <span className="cli-provider-row-label">
                {provider.name}
                {provider.modelsCount !== undefined && provider.modelsCount > 0 ? (
                  <span className="cli-provider-badge">
                    {provider.modelsCount} {provider.modelsCount === 1 ? "model" : "models"}
                  </span>
                ) : null}
              </span>
            }
            detail={provider.description ?? provider.id}
            checked={provider.enabled}
            disabled={!canManage || loading || pendingBulk || pendingId === provider.id}
            onChange={(checked) => void handleToggle(provider.id, checked)}
          />
        ))}

        {providers.length === 0 && !loading && !error ? (
          <p className="settings-flat-note">No providers discovered.</p>
        ) : null}

        <p className="settings-flat-note">
          Changes update OpenCode configuration and immediately refresh the shared CLI model catalog.
        </p>
      </section>
    </SettingsDisclosure>
  );
}
