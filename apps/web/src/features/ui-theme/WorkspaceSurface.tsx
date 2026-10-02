import { createContext, useContext, useLayoutEffect, type ReactNode, type RefObject } from "react";
import "./workspace-surface.css";

const WorkspaceSurfaceContext = createContext(false);

/** Keeps existing controls inside the Workspace navigation surface. */
export function WorkspaceSurface({ children }: { children: ReactNode }) {
  return <WorkspaceSurfaceContext.Provider value>{children}</WorkspaceSurfaceContext.Provider>;
}

export function useWorkspaceSurface() {
  return useContext(WorkspaceSurfaceContext);
}

/** Relocates a persistent player/keyboard panel without replacing its runtime. */
export function WorkspacePortalMount({ onTargetChange, onBack, onBackRef }: {
  onTargetChange: (target: HTMLDivElement | null) => void;
  onBack: () => void;
  onBackRef: RefObject<(() => void) | null>;
}) {
  useLayoutEffect(() => {
    onBackRef.current = onBack;
    return () => { onBackRef.current = null; };
  }, [onBack, onBackRef]);
  return <div className="workspace-persistent-panel" ref={onTargetChange} />;
}
