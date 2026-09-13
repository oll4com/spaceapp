import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";

// Open tabs can request lazy chunks from the previous build for up to a week.
export function retainOpenTabAssets(): Plugin {
  let outputDirectory = "";
  const currentAssets = new Set<string>();
  return {
    name: "retain-open-tab-assets",
    apply: "build",
    configResolved(config) { outputDirectory = path.resolve(config.root, config.build.outDir); },
    generateBundle(_options, bundle) {
      currentAssets.clear();
      for (const name of Object.keys(bundle)) currentAssets.add(name);
    },
    async closeBundle() {
      const assetsDirectory = path.join(outputDirectory, "assets");
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const entry of await readdir(assetsDirectory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const name = `assets/${entry.name}`;
        if (currentAssets.has(name.replace(/\.(br|gz)$/, ""))) continue;
        const file = path.join(assetsDirectory, entry.name);
        const source = file.replace(/\.(br|gz)$/, "");
        const sourceStats = await stat(source).catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!sourceStats || sourceStats.mtimeMs < cutoff) await unlink(file);
      }
    }
  };
}
