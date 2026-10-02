// Independent of the application modules, so a blocked or interrupted bundle has a recovery UI.
(() => {
  for (const link of document.querySelectorAll("link[data-space-mock-style]")) {
    if (link.sheet) link.media = "all";
    else link.addEventListener("load", () => { link.media = "all"; }, { once: true });
  }
  const loading = document.getElementById("space-mock-loading");
  const message = document.getElementById("space-mock-loading-message");
  const retry = document.getElementById("space-mock-retry");
  if (!loading || !message || !retry) return;
  const showRetry = (failed = false) => {
    if (!loading.isConnected) return;
    message.textContent = failed
      ? "Space demo could not load. Please try again."
      : "Loading is taking longer than expected. You can wait or try again.";
    retry.hidden = false;
  };
  retry.addEventListener("click", () => {
    const url = new URL(location.href);
    url.searchParams.set("reload", Date.now().toString());
    location.replace(url.href);
  });
  const timeout = setTimeout(showRetry, 15000);
  const failed = () => showRetry(true);
  window.addEventListener("space-mock-load-error", failed);
  window.addEventListener("error", event => {
    if (event.target instanceof HTMLScriptElement || event.target instanceof HTMLLinkElement) failed();
  }, true);
  const observer = new MutationObserver(() => {
    if (loading.isConnected) return;
    clearTimeout(timeout);
    window.removeEventListener("space-mock-load-error", failed);
    observer.disconnect();
  });
  observer.observe(document.getElementById("root"), { childList: true });
})();
