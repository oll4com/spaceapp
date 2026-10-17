import { useCallback, useState } from "react";
import { readLiquidGlassTint, writeLiquidGlassTint } from "../../ui-theme.js";
import { saveUserSettingDebounced } from "../user-settings/user-settings-save-queue.js";

/** The Liquid Glass tint (0 ultra clear, 100 fully tinted): applied live and saved to the account, no reload, like the UI zoom. */
export function useLiquidGlassTint(storage: Storage): [number, (tint: number) => void] {
  const [tint, setTint] = useState(() => readLiquidGlassTint(storage));
  const changeTint = useCallback((next: number) => {
    setTint(writeLiquidGlassTint(storage, next));
    saveUserSettingDebounced("liquidGlassTint", next);
  }, [storage]);
  return [tint, changeTint];
}
