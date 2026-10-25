import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Source dependencies include type-only imports: these are architectural
// coupling even where TypeScript erases the runtime edge.
export async function readDependencyGraph(sources) {
  const graph = new Map();
  for (const [file, source] of sources) {
    const edges = new Set();
    const info = ts.preProcessFile(source, true, true);
    for (const { fileName: specifier } of info.importedFiles) {
      if (!specifier.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      const stem = target.replace(/\.[cm]?jsx?$/, '');
      const candidates = [target, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}/index.ts`, `${stem}/index.tsx`];
      const resolved = candidates.find(candidate => sources.has(candidate));
      if (resolved) edges.add(resolved);
    }
    graph.set(file, edges);
  }
  return graph;
}

// Tarjan's strongly connected components; self-imports count as cycles too.
export function analyzeDependencies(graph) {
  let index = 0;
  const indices = new Map(), low = new Map(), stack = [], active = new Set(), cycles = [];
  function visit(node) {
    indices.set(node, index); low.set(node, index++);
    stack.push(node); active.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) { visit(next); low.set(node, Math.min(low.get(node), low.get(next))); }
      else if (active.has(next)) low.set(node, Math.min(low.get(node), indices.get(next)));
    }
    if (low.get(node) !== indices.get(node)) return;
    const component = [];
    let current;
    do { current = stack.pop(); active.delete(current); component.push(current); } while (current !== node);
    if (component.length > 1 || graph.get(node)?.has(node)) cycles.push(component.sort());
  }
  for (const node of [...graph.keys()].sort()) if (!indices.has(node)) visit(node);
  return cycles.sort((a, b) => a.join('\n').localeCompare(b.join('\n')));
}

export function cyclicEdges(graph) {
  return analyzeDependencies(graph).flatMap(component => {
    const members = new Set(component);
    return component.flatMap(from => [...(graph.get(from) ?? [])]
      .filter(to => members.has(to)).map(to => `${from} -> ${to}`));
  }).sort();
}

export function checkPolicy(graph, policy) {
  const allowed = new Set(policy.allowedCyclicEdges);
  const violations = cyclicEdges(graph).filter(edge => !allowed.has(edge)).map(edge => `New dependency cycle edge: ${edge}`);
  const roots = new Set(policy.compositionRoots);
  for (const domain of policy.domainFiles) {
    if (!graph.has(domain)) { violations.push(`Missing domain entry: ${domain}`); continue; }
    const visited = new Set(), queue = [[domain]];
    for (let index = 0; index < queue.length; index++) {
      const chain = queue[index], current = chain.at(-1);
      if (visited.has(current)) continue;
      visited.add(current);
      if (roots.has(current)) { violations.push(`Domain depends on composition root: ${chain.join(' -> ')}`); continue; }
      for (const next of graph.get(current) ?? []) queue.push([...chain, next]);
    }
  }
  return violations;
}

export async function repositoryGraph(root) {
  const sources = new Map();
  async function scan(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await scan(name);
      else if (entry.isFile() && /\.[cm]?tsx?$/.test(name)) sources.set(name, await readFile(path.join(root, name), 'utf8'));
    }
  }
  await scan('apps/api/src');
  await scan('apps/web/src');
  return readDependencyGraph(sources);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const policy = JSON.parse(await readFile(path.join(root, 'docs/quality/domain-boundaries.json'), 'utf8'));
  const graph = await repositoryGraph(root);
  const violations = checkPolicy(graph, policy);
  if (violations.length) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Domain boundaries passed: ${graph.size} source modules; ${analyzeDependencies(graph).length} existing cyclic components; ${policy.domainFiles.length} protected domain entries.`);
  }
}
