export const SPACE_TASK_ITEM_MIME = "application/x-space-task-item-id";
export const SPACE_TASK_UPDATED_EVENT = "space:tasks-updated";

export function notifyTasksUpdated(): void {
  window.dispatchEvent(new Event(SPACE_TASK_UPDATED_EVENT));
}