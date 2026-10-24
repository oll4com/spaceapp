import { condition } from "@temporalio/workflow";
import type { RoomAgentSupervisorInput } from "@space/contracts";

/**
 * Minimal pre-patch supervisor used only to produce a history without the
 * `room-background-continuation-v1` marker. The current supervisor must keep
 * replaying this waiting history through its legacy branch.
 */
export async function roomAgentSupervisorWorkflow(_input: RoomAgentSupervisorInput): Promise<never> {
  await condition(() => false);
  return roomAgentSupervisorWorkflow(_input);
}
