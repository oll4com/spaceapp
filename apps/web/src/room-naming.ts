import { pickNextAvailableRoomName } from "@space/contracts";

export function nextGeneratedRoomName(roomNames: readonly string[]): string {
  return pickNextAvailableRoomName(roomNames);
}
