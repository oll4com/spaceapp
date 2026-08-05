export function nextGeneratedRoomName(roomNames: readonly string[]): string {
  const existingNames = new Set(roomNames.map((name) => name.trim()));
  let roomNumber = roomNames.length + 1;
  while (existingNames.has(`Room ${roomNumber}`)) roomNumber += 1;
  return `Room ${roomNumber}`;
}
