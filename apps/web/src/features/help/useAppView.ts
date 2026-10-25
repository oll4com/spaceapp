import { useEffect, useState } from "react";
import { readAppView, type AppView } from "../../app-shell-utils.js";

// Which full page is shown (workspace, Help or the Asteroids benchmark), kept in
// sync with the browser history and the document title.

export interface AppViewController {
  appView: AppView;
  setAppView: (view: AppView) => void;
  openHelp: () => void;
  closeHelp: () => void;
  openBenchmark: () => void;
  closeBenchmark: () => void;
}

/** `onLeaveWorkspace` runs when browser navigation lands on Help or the benchmark. */
export function useAppView({ onLeaveWorkspace }: { onLeaveWorkspace: () => void }): AppViewController {
  const [appView, setAppView] = useState<AppView>(readAppView);

  useEffect(() => {
    const syncViewFromLocation = () => {
      const nextView = readAppView();
      if (nextView === "help" || nextView === "benchmark") onLeaveWorkspace();
      setAppView(nextView);
    };
    window.addEventListener("popstate", syncViewFromLocation);
    return () => window.removeEventListener("popstate", syncViewFromLocation);
  }, []);

  useEffect(() => {
    document.title = appView === "help" ? "Space Help" : appView === "benchmark" ? "Space Benchmark" : "Space";
  }, [appView]);

  function openHelp() {
    window.history.pushState({ spaceView: "help" }, "", "/help");
    setAppView("help");
  }

  function closeHelp() {
    window.history.replaceState({ spaceView: "workspace" }, "", "/");
    setAppView("workspace");
  }

  function openBenchmark() {
    window.history.pushState({ spaceView: "benchmark" }, "", "/benchmark");
    setAppView("benchmark");
  }

  function closeBenchmark() {
    window.history.replaceState({ spaceView: "workspace" }, "", "/");
    setAppView("workspace");
  }

  return { appView, setAppView, openHelp, closeHelp, openBenchmark, closeBenchmark };
}
