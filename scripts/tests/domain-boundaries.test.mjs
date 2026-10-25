import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeDependencies, checkPolicy, readDependencyGraph } from '../domain-boundaries.mjs';

const graph = (entries) => new Map(Object.entries(entries).map(([key, edges]) => [key, new Set(edges)]));

test('reports transitive cycles deterministically while allowing acyclic shared dependencies', () => {
  assert.deepEqual(analyzeDependencies(graph({a:['b'], b:['c'], c:['a'], d:['b']})), [['a','b','c']]);
  assert.deepEqual(analyzeDependencies(graph({a:['b','c'], b:['c'], c:[]})), []);
});

test('new cyclic components fail even when they contain an existing allowed cycle', () => {
  const policy = { allowedCyclicEdges: ['a -> b', 'b -> a'], domainFiles: [], compositionRoots: [] };
  assert.deepEqual(checkPolicy(graph({a:['b'], b:['a']}), policy), []);
  assert.match(checkPolicy(graph({a:['b'], b:['a','c'], c:['a']}), policy).join('\n'), /New dependency cycle/);
  assert.match(checkPolicy(graph({a:['a']}), policy).join('\n'), /New dependency cycle/);
});

test('extracted domains cannot reach application roots through a helper', () => {
  const policy = { allowedCyclicEdges: [], domainFiles: ['feature'], compositionRoots: ['app'] };
  assert.match(checkPolicy(graph({feature:['helper'], helper:['app'], app:[]}), policy).join('\n'), /feature -> helper -> app/);
  assert.deepEqual(checkPolicy(graph({app:['feature'], feature:['helper'], helper:[]}), policy), []);
});

test('resolves source extensions and includes imports, re-exports and dynamic imports', async () => {
  const source = new Map([
    ['src/entry.ts', 'import type { X } from "./types.js"; export { x } from "./shared.js"; void import("./lazy.js");'],
    ['src/types.ts', 'export type X = string;'],
    ['src/shared.tsx', 'export const x = 1;'],
    ['src/lazy/index.ts', 'export {};']
  ]);
  const result = await readDependencyGraph(source);
  assert.deepEqual([...result.get('src/entry.ts')].sort(), ['src/lazy/index.ts', 'src/shared.tsx', 'src/types.ts']);
});


test('rejects a new cycle edge even when the component members are unchanged', () => {
  const policy = { allowedCyclicEdges: ['a -> b', 'b -> c', 'c -> a'], domainFiles: [], compositionRoots: [] };
  assert.deepEqual(checkPolicy(graph({a:['b'], b:['c'], c:['a']}), policy), []);
  assert.match(checkPolicy(graph({a:['b'], b:['c','a'], c:['a']}), policy).join('\n'), /b -> a/);
});
