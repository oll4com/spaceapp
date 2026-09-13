export interface YouTubeAccounts {
  selectedProfileId: string | null;
  profiles: Array<{ profileId: string; displayName: string }>;
}
export interface YouTubeAccountSelection {
  selectedProfileId: string | null;
  targetUrl: string;
}
