import type { Plugin } from "vite";

type BundleChunk = {
  type: "chunk";
  fileName: string;
  imports: string[];
  dynamicImports: string[];
  modules: Record<string, unknown>;
};

type BundleItem = BundleChunk | { type: string; fileName?: string };

export type DemoBundleBoundaryResult = {
  demoChunks: string[];
  moduleCount: number;
  forbiddenModules: string[];
};

const demoEntrySuffix = "/apps/web/src/demo/DemoSpaceApp.tsx";
const forbiddenModuleSuffixes = [
  "/apps/web/src/live-api.ts",
  "/apps/web/src/live/LiveSpaceApp.tsx",
  "/apps/web/src/live/live-runtime.ts"
] as const;

function normalizeModuleId(moduleId: string): string {
  return moduleId.replaceAll("\\", "/").split("?")[0] ?? moduleId;
}

function isChunk(item: BundleItem): item is BundleChunk {
  return item.type === "chunk";
}

export function inspectDemoBundleBoundary(bundle: Record<string, BundleItem>): DemoBundleBoundaryResult {
  const chunks = Object.values(bundle).filter(isChunk);
  const chunksByFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const demoEntry = chunks.find((chunk) =>
    Object.keys(chunk.modules).some((moduleId) => normalizeModuleId(moduleId).endsWith(demoEntrySuffix))
  );
  if (!demoEntry) throw new Error("DemoSpaceApp entry chunk was not emitted.");

  const pending = [demoEntry.fileName];
  const visited = new Set<string>();
  const modules = new Set<string>();
  while (pending.length > 0) {
    const fileName = pending.shift()!;
    if (visited.has(fileName)) continue;
    const chunk = chunksByFileName.get(fileName);
    if (!chunk) throw new Error(`Demo bundle imports missing chunk ${fileName}.`);
    visited.add(fileName);
    for (const moduleId of Object.keys(chunk.modules)) modules.add(normalizeModuleId(moduleId));
    pending.push(...chunk.imports);
  }

  const forbiddenModules = [...modules]
    .filter((moduleId) => forbiddenModuleSuffixes.some((suffix) => moduleId.endsWith(suffix)))
    .sort();
  return {
    demoChunks: [...visited].sort((left, right) => {
      if (left === demoEntry.fileName) return -1;
      if (right === demoEntry.fileName) return 1;
      return left.localeCompare(right);
    }),
    moduleCount: modules.size,
    forbiddenModules
  };
}

function publicModuleName(moduleId: string): string {
  const normalized = normalizeModuleId(moduleId);
  const marker = "/apps/web/";
  const index = normalized.lastIndexOf(marker);
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export function demoBundleBoundaryPlugin(): Plugin {
  return {
    name: "space-demo-bundle-boundary",
    apply: "build",
    generateBundle(_options, bundle) {
      const result = inspectDemoBundleBoundary(bundle as Record<string, BundleItem>);
      if (result.forbiddenModules.length > 0) {
        this.error(`Demo bundle contains forbidden live modules: ${result.forbiddenModules.map(publicModuleName).join(", ")}`);
      }
      this.emitFile({
        type: "asset",
        fileName: "demo-bundle-boundary.json",
        source: `${JSON.stringify({
          version: "space-demo-bundle-boundary-v1",
          ok: true,
          demoChunks: result.demoChunks,
          moduleCount: result.moduleCount,
          forbiddenModules: []
        }, null, 2)}\n`
      });
    }
  };
}
