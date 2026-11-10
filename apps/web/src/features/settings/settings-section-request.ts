import { useEffect, useState } from "react";

/** The shell opens the Settings dock on it; the dock opens the section (a SettingsDisclosure's sectionKey). */
export const OPEN_SETTINGS_SECTION_EVENT = "space:open-settings-section";
export interface SettingsSectionRequest { key: string; nonce: number }

// Kept for a Settings dock that mounts after the request; claimSettingsRequest opens each nonce once.
let pending: SettingsSectionRequest | null = null;

/** Opens SpaceApp Settings at one section, from any surface. */
export function openSettingsSection(key: string): void {
  pending = { key, nonce: Date.now() };
  window.dispatchEvent(new CustomEvent<SettingsSectionRequest>(OPEN_SETTINGS_SECTION_EVENT, { detail: pending }));
}

/** The newest section request, including one made before the Settings dock mounted. */
export function useSettingsSectionRequest(): SettingsSectionRequest | null {
  const [request, setRequest] = useState(pending);
  useEffect(() => {
    const take = () => setRequest(pending);
    window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, take);
    return () => window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, take);
  }, []);
  return request;
}
