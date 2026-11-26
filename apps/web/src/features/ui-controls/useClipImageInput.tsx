import { useMemo, useRef, type RefObject } from "react";

// One element for the owner's life (PERF-001 C-2 pattern): React 19 rewrites name and type of a re-created <input> on every commit.
export function useClipImageInput(inputRef: RefObject<HTMLInputElement | null>, onSelect: (file: File | null) => void) {
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  return useMemo(() => (
    <input
      ref={inputRef}
      type="file"
      name="clip-tool-image"
      accept="image/png,image/jpeg,image/webp"
      hidden
      onChange={(event) => {
        const file = event.currentTarget.files?.[0] ?? null;
        event.currentTarget.value = "";
        onSelectRef.current(file);
      }}
    />
  ), [inputRef]);
}
