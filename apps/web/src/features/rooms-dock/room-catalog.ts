import type { Room } from "@space/contracts";
import { api } from "../../api.js";

// The room catalog: its display order, a manual reorder and a bounded full read.

export function sortRoomsByOrder(rooms: Room[]): Room[] {
  return [...rooms].sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    const leftCreatedAt = Date.parse(left.createdAt);
    const rightCreatedAt = Date.parse(right.createdAt);
    if (!Number.isNaN(leftCreatedAt) && !Number.isNaN(rightCreatedAt) && leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }
    return left.id.localeCompare(right.id);
  });
}

const ROOM_CATALOG_PAGE_SIZE = 100;
const ROOM_CATALOG_MAX_PAGES = 20;

export async function loadBoundedRoomCatalog(): Promise<Room[]> {
  const firstPage = await api.rooms({ page: 1, pageSize: ROOM_CATALOG_PAGE_SIZE, all: true });
  const reportedPageCount = firstPage.pagination.totalPages;
  const pageCount = Number.isSafeInteger(reportedPageCount) && reportedPageCount > 1
    ? Math.min(reportedPageCount, ROOM_CATALOG_MAX_PAGES)
    : 1;
  if (pageCount === 1) return firstPage.data;

  const remainingPages = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) =>
      api.rooms({ page: index + 2, pageSize: ROOM_CATALOG_PAGE_SIZE, all: true })
    )
  );
  return [firstPage, ...remainingPages].flatMap((page) => page.data);
}

export function reorderRoomsById(rooms: Room[], draggedRoomId: string, targetRoomId: string): Room[] {
  if (draggedRoomId === targetRoomId) return rooms;
  const draggedIndex = rooms.findIndex((room) => room.id === draggedRoomId);
  const targetIndex = rooms.findIndex((room) => room.id === targetRoomId);
  if (draggedIndex === -1 || targetIndex === -1) return rooms;
  const next = [...rooms];
  const [draggedRoom] = next.splice(draggedIndex, 1);
  if (!draggedRoom) return rooms;
  const insertionIndex = draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
  next.splice(insertionIndex, 0, draggedRoom);
  return next.map((room, index) => (room.order === index ? room : { ...room, order: index }));
}

/** Creates the project folder before a room points at it; best effort. */
export async function ensureProjectFolder(targetPath: string) {
  if (!targetPath || !targetPath.trim()) return;
  try {
    // The shared client attaches the CSRF token that this mutation requires.
    await api.ensureProject({ path: targetPath.trim() });
  } catch {}
}
