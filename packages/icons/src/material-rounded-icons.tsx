import { forwardRef } from "react";
import { appIconMaterialSymbols, type AppIconName } from "./app-icon-map.js";
import type { LucideIcon, LucideProps } from "lucide-react";
import { materialRoundedPaths, type MaterialSymbolName } from "./material-symbol-paths.js";

// Material Rounded app icons, loaded only when the Material icon pack is selected.
function createMaterialSymbol(name: MaterialSymbolName): LucideIcon {
  const definition = materialRoundedPaths[name];
  const Component = forwardRef<SVGSVGElement, LucideProps>(function MaterialRoundedSymbol(
    {
      absoluteStrokeWidth: _absoluteStrokeWidth,
      children: _children,
      color = "currentColor",
      fill: _fill,
      size = 24,
      stroke: _stroke,
      strokeWidth: _strokeWidth,
      ...props
    },
    ref
  ) {
    return (
      <svg
        ref={ref}
        {...props}
        width={size}
        height={size}
        viewBox={definition.viewBox}
        fill="currentColor"
        color={color}
        stroke="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {definition.paths.map((path, index) => <path d={path} key={index} />)}
      </svg>
    );
  });
  Component.displayName = `MaterialRounded(${name})`;
  return Component as LucideIcon;
}

const materialRoundedIcons = Object.fromEntries(
  (Object.keys(materialRoundedPaths) as MaterialSymbolName[])
    .map((name) => [name, createMaterialSymbol(name)])
) as Record<MaterialSymbolName, LucideIcon>;

export const materialRoundedAppIcons: Partial<Record<AppIconName, LucideIcon>> = Object.fromEntries(
  (Object.keys(appIconMaterialSymbols) as AppIconName[])
    .map((name) => [name, materialRoundedIcons[appIconMaterialSymbols[name] as MaterialSymbolName]] as const)
    .filter(([, icon]) => Boolean(icon))
);
