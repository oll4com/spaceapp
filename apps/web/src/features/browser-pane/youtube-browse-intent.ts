const pendingUrls = new Map<string, string>();

export function registerYouTubeBrowseIntent(paneId: string, url: string) {
  pendingUrls.set(paneId, url);
}

export function takeYouTubeBrowseIntent(paneId: string): string | undefined {
  const url = pendingUrls.get(paneId);
  pendingUrls.delete(paneId);
  return url;
}
