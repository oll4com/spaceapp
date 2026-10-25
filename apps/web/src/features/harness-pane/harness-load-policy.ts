export type HarnessRoomPresentationState = "hidden" | "preparing" | "held" | "displayed";

export function shouldLoadHarnessPane(
  presentationState: HarnessRoomPresentationState,
  terminalPrefillReady: boolean
): boolean {
  return presentationState !== "hidden" || terminalPrefillReady;
}
