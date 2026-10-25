export const consolidatedResourceActions = new Set(["system-resources", "system-analytics", "token-usage", "surface-health"]);
export const consolidatedManageActions = new Set(["system-services", "setup-connections"]);
export function canonicalSystemAction(id: string): string {
  return consolidatedResourceActions.has(id) ? "resources" : consolidatedManageActions.has(id) ? "server-restart" : id;
}
export function openManage(action?: string) {
  window.dispatchEvent(new CustomEvent("space:manage", { detail: { action } }));
}
