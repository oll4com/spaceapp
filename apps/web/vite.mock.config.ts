import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { manualChunkForModule } from "./vite.config.js";
import { demoBundleBoundaryPlugin } from "./vite.demo-boundary.js";

// The public demo lives at /spaceappmock/; a review build can use another
// folder (for example /demonew/spaceappmock/) through SPACE_MOCK_BASE.
export const MOCK_BASE = normalizeMockBase(process.env.SPACE_MOCK_BASE ?? "/spaceappmock/");
export function normalizeMockBase(value: string): string {
  if (!/^\/(?:[a-z0-9-]+\/)+$/.test(value)) throw new Error(`SPACE_MOCK_BASE must look like /folder/ or /folder/sub/, got ${value}`);
  return value;
}

export default defineConfig({
  base: MOCK_BASE,
  plugins: [{
    name: "mock-local-media-adapter", enforce: "pre",
    resolveId(source, importer) {
      if (source.endsWith("YouTubeNativePlayer.js") && !importer?.endsWith("mock-video-player.tsx")) return resolve(import.meta.dirname, "src/demo/mock-video-player.tsx");
      if (source === "@novnc/novnc") return resolve(import.meta.dirname, "src/demo/mock-rfb.ts");
      return null;
    },
    transform(code, id) {
      if (id.endsWith("/src/App.tsx")) {
        const marker = "function detectUiThemeShellMode(width: number, uiTheme: UiTheme): ShellMode {";
        if (!code.includes(marker)) throw new Error("The canonical shell selector changed; update the public demo viewport adapter.");
        // The public preview uses a desktop canvas. Phone hardware hints must
        // not hide three panes inside an otherwise wide homepage iframe.
        const adapted = code.replace(marker, `${marker}\n  return detectShellMode(width, MOBILE_SHELL_MAX_WIDTH);`);
        return { code: adapted.replace(/(["'`])\/(brand|dots)\//g, `$1${MOCK_BASE}$2/`), map: null };
      }
      if (!id.endsWith("/features/live-pane/live-session.ts")) {
        const rebased = code.replace(/(["'`])\/(brand|dots)\//g, `$1${MOCK_BASE}$2/`);
        return rebased === code ? null : { code: rebased, map: null };
      }
      const marker = "  const provider = options.provider ?? inferProviderFromModel(options.model);";
      const factory = "export async function openLiveConversationSession(";
      const offset = code.indexOf(factory);
      if (offset < 0) throw new Error("Live session factory changed; update the mock transport.");
      const insertion = code.indexOf(marker, offset);
      if (insertion < 0) throw new Error("Live session entry changed; update the mock transport.");
      return { code: `import { openMockLiveSession } from '../../demo/mock-live-session.js';\n${code.slice(0, insertion)}  return openMockLiveSession(options, callbacks);\n${code.slice(insertion)}`, map: null };
    }
  }, react(), demoBundleBoundaryPlugin()],
  build: {
    emptyOutDir: true,
    minify: "terser",
    terserOptions: { compress: { passes: 2 }, mangle: true },
    rollupOptions: { input: { mock: resolve(import.meta.dirname, "mock.html"), feature: resolve(import.meta.dirname, "feature.html") }, output: { manualChunks: manualChunkForModule } }
  }
});
