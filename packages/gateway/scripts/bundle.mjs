// Bundles the gateway with @space/contracts and @space/db (the code it runs on) into one file, so the deploy
// can restart space-gateway only when this file's content changes. Everything else stays external (node_modules).
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "space-gateway.mjs");
const workerFile = join(root, "dist", "compression-worker.mjs");
const supervisorFile = join(root, "dist", "space-gateway-supervisor.mjs");

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  logLevel: "warning",
  plugins: [{
    name: "external-dependencies",
    setup(context) {
      const bundled = new Set(["@space/contracts", "@space/db"]);
      context.onResolve({ filter: /^[^./]/ }, (args) => (bundled.has(args.path) ? undefined : { path: args.path, external: true }));
    }
  }]
};
await build({ ...common, entryPoints: [join(root, "src", "main.ts")], outfile });
await build({ ...common, entryPoints: [join(root, "src", "compression", "worker.ts")], outfile: workerFile });
await build({ ...common, entryPoints: [join(root, "src", "supervisor-main.ts")], outfile: supervisorFile });

// The gateway (and its compression worker, with the tree-sitter grammars it loads from ../grammars) is handed over
// by a reload when this hash changes; the supervisor, which holds the listening socket, restarts only when its own
// hash changes.
const hash = createHash("sha256").update(await readFile(outfile)).update(await readFile(workerFile));
const grammars = join(root, "grammars");
for (const file of (await readdir(grammars)).filter((name) => name.endsWith(".wasm")).sort()) hash.update(file).update(await readFile(join(grammars, file)));
// The local embedding worker runs from the sources (providers/local), so a change to it also hands the gateway over.
hash.update(await readFile(join(root, "src", "providers", "local", "space-local-embeddings.py")));
const digest = hash.digest("hex");
await writeFile(`${outfile}.sha256`, `${digest}\n`);
const supervisorDigest = createHash("sha256").update(await readFile(supervisorFile)).digest("hex");
await writeFile(`${supervisorFile}.sha256`, `${supervisorDigest}\n`);
