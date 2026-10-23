// Match the canonical root build order for the source services. Vite already
// serves web source; production web bundling and demo generation belong to the
// unchanged complete startup/stock build, not each service hot reload.
export const sourceReloadWorkspaces = Object.freeze([
  '@space/contracts', '@space/icons', '@space/streaming',
  '@space/opencode-control', '@space/memory-graph', '@space/browser-host',
  '@space/cli-host', '@space/codex-app-server', '@space/runtime', '@space/db',
  '@space/gateway', '@space/api', '@space/worker',
]);
export const sourceReloadBuildPlan = Object.freeze([
  ...sourceReloadWorkspaces.map(name => Object.freeze({ executable: 'npm', args: Object.freeze(['run', 'build', '-w', name]) })),
  Object.freeze({ executable: 'node', args: Object.freeze(['scripts/fix-build-permissions.mjs']) }),
]);

export async function buildSourceServices(invoke, isStopping) {
  for (const step of sourceReloadBuildPlan) {
    if (isStopping()) throw new Error('Source rebuild cancelled before relaunch.');
    await invoke(step.executable, step.args);
  }
  if (isStopping()) throw new Error('Source rebuild cancelled before relaunch.');
}
