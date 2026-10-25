import { createContext, useContext } from "react";

export const DockActiveContext = createContext<boolean>(true);

/**
 * Hook to determine if the enclosing dock is currently active and visible to the user.
 * Cached/hidden docks receive `false`, allowing them to pause interval polling and animations.
 */
export function useIsDockActive(): boolean {
  return useContext(DockActiveContext);
}
