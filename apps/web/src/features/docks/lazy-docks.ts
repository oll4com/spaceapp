import { lazyWithPreload } from "../../lazy-with-preload.js";

// Lazy dock components kept out of App.tsx (composition-root budget, docs/quality/composition-root-budget.json).
export const LazyTaskDock = lazyWithPreload(() =>
  import("../task-dock/TaskDock.js").then((module) => ({ default: module.TaskDock })),
  { idle: true }
);
export const LazyVaultDock = lazyWithPreload(() => import("../vault/VaultDock.js").then((module) => ({ default: module.VaultDock })));
