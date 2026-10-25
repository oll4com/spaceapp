// @vitest-environment node

import { describe, expect, it } from "vitest";
import { manualChunkForModule } from "../vite.config.js";

describe("web bundle chunk policy", () => {
  it("isolates React and xterm while leaving feature modules available for lazy chunks", () => {
    expect(manualChunkForModule("/workspace/node_modules/react-dom/client.js")).toBe("vendor-react");
    expect(manualChunkForModule("/workspace/node_modules/react/jsx-runtime.js")).toBe("vendor-react");
    expect(manualChunkForModule("/workspace/node_modules/scheduler/index.js")).toBe("vendor-react");
    expect(manualChunkForModule("/workspace/node_modules/@xterm/xterm/lib/xterm.js")).toBe("vendor-xterm");
    expect(manualChunkForModule("/workspace/node_modules/@xterm/addon-fit/lib/addon-fit.js")).toBe("vendor-xterm");
    expect(manualChunkForModule("/workspace/node_modules/lucide-react/dist/esm/icons/terminal.js")).toBe("vendor-icons");
    expect(manualChunkForModule("/workspace/node_modules/zod/v4/core/index.js")).toBe("vendor-validation");
    expect(manualChunkForModule("/workspace/node_modules/graphology/dist/graphology.js")).toBeUndefined();
    expect(manualChunkForModule("/workspace/src/features/browser-pane/BrowserPane.tsx")).toBeUndefined();
  });
});
