import { describe, expect, it } from "vitest";
import { inspectDemoBundleBoundary } from "../vite.demo-boundary.js";

type TestChunk = {
  type: "chunk";
  fileName: string;
  imports: string[];
  dynamicImports: string[];
  modules: Record<string, unknown>;
};

function chunk(
  fileName: string,
  modules: string[],
  imports: string[] = [],
  dynamicImports: string[] = []
): TestChunk {
  return {
    type: "chunk",
    fileName,
    imports,
    dynamicImports,
    modules: Object.fromEntries(modules.map((moduleId) => [moduleId, {}]))
  };
}

describe("demo production bundle boundary", () => {
  it("walks only the demo static dependency closure and ignores the sibling live dynamic entry", () => {
    const result = inspectDemoBundleBoundary({
      "main.js": chunk("main.js", ["/repo/apps/web/src/main.tsx"], [], ["demo.js", "live.js"]),
      "demo.js": chunk("demo.js", ["/repo/apps/web/src/demo/DemoSpaceApp.tsx"], ["shared.js"]),
      "shared.js": chunk("shared.js", ["/repo/apps/web/src/App.tsx"]),
      "live.js": chunk("live.js", [
        "/repo/apps/web/src/live/LiveSpaceApp.tsx",
        "/repo/apps/web/src/live/live-runtime.ts",
        "/repo/apps/web/src/live-api.ts"
      ])
    });

    expect(result.demoChunks).toEqual(["demo.js", "shared.js"]);
    expect(result.forbiddenModules).toEqual([]);
  });

  it("fails closed when live runtime or API modules enter the demo static dependency closure", () => {
    const result = inspectDemoBundleBoundary({
      "demo.js": chunk("demo.js", ["/repo/apps/web/src/demo/DemoSpaceApp.tsx"], ["shared.js"]),
      "shared.js": chunk("shared.js", [
        "/repo/apps/web/src/App.tsx",
        "/repo/apps/web/src/live/live-runtime.ts",
        "/repo/apps/web/src/live-api.ts"
      ])
    });

    expect(result.forbiddenModules).toEqual([
      "/repo/apps/web/src/live-api.ts",
      "/repo/apps/web/src/live/live-runtime.ts"
    ]);
  });

  it("fails closed when the demo entry chunk cannot be identified", () => {
    expect(() => inspectDemoBundleBoundary({
      "main.js": chunk("main.js", ["/repo/apps/web/src/main.tsx"])
    })).toThrow("DemoSpaceApp entry chunk was not emitted");
  });
});
