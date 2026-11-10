// EXT-C-F8: every child Space starts gets an env without Space's credentials (childProcessEnv, the API's
// safe-child-process wrapper, or an allowlist built from scratch). Shared by apps/worker/tests/child-process-env.test.ts
// and scripts/tests/child-process-env-guard.test.mjs, which the merge queue runs in npm run test:deploy.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-api";

export const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const childModule = /^(?:node:)?child_process$|^node-pty$/;
// The API's wrapper fills a missing env itself, but passes an explicit one through, so its calls are checked for a raw env.
const wrapperModule = /(?:^|\/)safe-child-process(?:\.js)?$/;
// Where each function takes its options; spawn and execFile may also omit the args array.
const optionsAt = { spawn: 2, spawnSync: 2, execFile: 2, execFileSync: 2, fork: 2, exec: 1, execSync: 1 };
// Every host child passes its own env now (EXT-C-F8); an entry here must name an exact `<file>: <command>`.
export const hostExceptions = [];

// Every runtime source that starts a child: discovered, so a new file is checked without editing this list.
function runtimeSources(root) {
  const dirs = readdirSync(resolve(root, "apps")).filter((app) => app !== "desktop") // the operator's own computer: no server credentials
    .map((app) => `apps/${app}/src`).concat(readdirSync(resolve(root, "packages")).filter((pkg) => pkg !== "run-spaceapp").map((pkg) => `packages/${pkg}/src`));
  const files = existsSync(resolve(root, "apps/web/server.mjs")) ? ["apps/web/server.mjs"] : [];
  for (const dir of dirs.filter((d) => existsSync(resolve(root, d)))) {
    for (const entry of readdirSync(resolve(root, dir), { recursive: true })) {
      if (/\.(?:ts|tsx|mts|mjs|js)$/.test(entry) && !entry.endsWith(".d.ts") && !/__tests__|\.test\./.test(entry)) files.push(`${dir}/${entry}`);
    }
  }
  // The API's wrapper fills env itself (apps/api/tests/safe-child-process.test.ts proves it).
  return files.filter((file) => file !== "apps/api/src/safe-child-process.ts" && /child_process|node-pty|safe-child-process/.test(readFileSync(resolve(root, file), "utf8")));
}

// INT5-C-F5: a spread-only guard missed children with no env at all.
// The privileged run-with-space-env -> maintenance runner is intentionally excluded.
export function scanChildProcessEnv(root = repositoryRoot) {
  const files = [
    ...runtimeSources(root),
    // Private host scripts: the public export ships none of them, so they are checked only in the source tree.
    ...(existsSync(resolve(root, "scripts/space-queue.mjs")) ? [
      "scripts/space-video-engine.mjs", "scripts/space-video-tools-setup.mjs",
      "scripts/space-media-capture.mjs", "scripts/lib/space-chrome-render.mjs",
      "scripts/space-queue.mjs",
      "scripts/space-codex-nous-turn.mjs", "scripts/space-gemini-nous-turn.mjs",
      "scripts/cli-maintenance-runner.mjs", "scripts/cli-maintenance-dispatcher.mjs",
      "scripts/cli-maintenance-adapters.mjs", "scripts/cli-maintenance-update-all.mjs",
      "scripts/space-vault-broker-reinstall.mjs", "scripts/cli-launch-admission.mjs",
      "scripts/space-db-cleanup.mjs" // space-db-cleanup.service loads /opt/spaceapp/.env
    ] : [])
  ];
  const offenders = [];
  const excepted = [];
  for (const file of files) {
    const contents = readFileSync(resolve(root, file), "utf8");
    // API queue commands use the git helper; deploy/resolver children belong to the separate queue daemon.
    const text = file === "scripts/space-queue.mjs" ? contents.match(/function git\([\s\S]*?\n\}/)[0] : contents;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const calls = new Map();
    const bindings = new Map();
    const typedEnv = new Set();
    const visit = (node, action) => {
      action(node); ts.forEachChild(node, (child) => { visit(child, action); });
    };
    visit(source, (node) => {
      if (ts.isImportDeclaration(node) && wrapperModule.test(node.moduleSpecifier.text) && !node.importClause?.isTypeOnly) {
        const imports = node.importClause?.namedBindings;
        if (imports && ts.isNamedImports(imports)) for (const item of imports.elements) {
          const name = (item.propertyName ?? item.name).text;
          if (!item.isTypeOnly && name in optionsAt) calls.set(item.name.text, `wrapped:${name}`);
        }
      }
      if (ts.isImportDeclaration(node) && childModule.test(node.moduleSpecifier.text) && !node.importClause?.isTypeOnly) {
        const imports = node.importClause?.namedBindings;
        const pty = node.moduleSpecifier.text === "node-pty";
        if (imports && ts.isNamedImports(imports)) for (const item of imports.elements) {
          const name = (item.propertyName ?? item.name).text;
          if (!item.isTypeOnly && name in optionsAt) calls.set(item.name.text, pty ? "pty" : name);
        }
        if (node.importClause?.name || (imports && ts.isNamespaceImport(imports))) {
          offenders.push(`${file}: import its functions by name so each call can be checked`);
        }
      }
      // import("node:child_process") or require("child_process") hides every call from this check.
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require") &&
          node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && childModule.test(node.arguments[0].text)) {
        offenders.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: import its functions by name (a static import) so each call can be checked`);
      }
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && node.initializer) {
        bindings.set(node.name.text, node.initializer);
      }
      // A parameter typed with a required env (an allowlist builder's output) carries its env with it.
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type && ts.isTypeLiteralNode(node.type) &&
          node.type.members.some((m) => m.name?.getText(source) === "env" && !m.questionToken)) typedEnv.add(node.name.text);
    });
    for (const [name, value] of bindings) {
      if (ts.isIdentifier(value) && calls.has(value.text)) calls.set(name, calls.get(value.text));
      if (ts.isCallExpression(value) && value.expression.getText(source) === "promisify" && calls.has(value.arguments[0]?.getText(source) ?? "")) {
        calls.set(name, calls.get(value.arguments[0].getText(source)));
      }
    }
    if (file === "scripts/space-queue.mjs") calls.set("execFileSync", "execFileSync");
    visit(source, (node) => {
      if ((ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) && node.expression.getText(source) === "process.env") {
        offenders.push(`${file}: raw process.env spread`);
      }
      if (!ts.isCallExpression(node) || !calls.has(node.expression.getText(source))) return;
      const wrapped = calls.get(node.expression.getText(source)).startsWith("wrapped:");
      const kind = calls.get(node.expression.getText(source)).replace("wrapped:", "");
      const index = kind === "pty" ? 2 : optionsAt[kind];
      let options = node.arguments[index];
      if (!options && index === 2 && kind !== "pty" && node.arguments[1] && !ts.isArrayLiteralExpression(node.arguments[1])) options = node.arguments[1];
      if (options && ts.isIdentifier(options) && typedEnv.has(options.text)) return;
      if (options && ts.isIdentifier(options)) options = bindings.get(options.text);
      const env = options && ts.isObjectLiteralExpression(options) && options.properties.find((p) => p.name?.getText(source) === "env");
      if (wrapped && !env) return;
      if (!env || ts.isPropertyAssignment(env) && /^(process\.env|undefined)$/.test(env.initializer.getText(source))) {
        const command = node.arguments[0];
        const exception = `${file}: ${command && ts.isStringLiteral(command) ? command.text : "?"}`;
        if (hostExceptions.includes(exception)) excepted.push(exception);
        else offenders.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: missing or raw env`);
      }
    });
  }
  return { offenders, excepted: excepted.sort(), expectedExceptions: hostExceptions.filter((e) => existsSync(resolve(root, e.split(":")[0]))).sort() };
}
