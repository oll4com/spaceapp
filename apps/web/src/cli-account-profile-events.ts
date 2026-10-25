export const CLI_ACCOUNT_PROFILES_EVENT = "space:cli-account-profiles-change";

export function dispatchCliAccountProfilesChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CLI_ACCOUNT_PROFILES_EVENT));
}
