/**
 * Replay bundle for recorded workflow histories (temporal-replay.test.ts).
 *
 * Identical to test-workflows.ts except the legacy supervisor history maps to
 * the CURRENT dispatcher: recorded pre-patch histories contain no patch
 * marker, so patched("room-background-continuation-v1") returns false during
 * replay and the dispatcher routes into the legacy branch. Replay must pass
 * without a determinism violation; that is exactly what the CI gate proves.
 */
export {
  dotGoalWorkflow,
  dummyTurnWorkflow,
  codexAppServerTurnWorkflow,
  roomAgentSupervisorWorkflow,
  roomAgentSupervisorWorkflow as legacyRoomAgentSupervisorWorkflow,
  roomAgentActionWorkflow
} from "../../src/workflows.js";
export { memoryMaintenanceWorkflow, memoryConsolidationWorkflow } from "../../src/memory-maintenance-workflows.js";
export { memoryMutationWorkflow } from "../../src/memory-mutation-workflows.js";
