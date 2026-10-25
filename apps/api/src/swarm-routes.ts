import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  claimSwarmLockInputSchema, createSwarmReconcileInputSchema, createSwarmTaskInputSchema, idSchema,
  listSwarmTasksQuerySchema, postSwarmMessageInputSchema, releaseSwarmLockInputSchema, runSwarmTaskInputSchema,
  runSwarmTaskResponseSchema, swarmStateSchema, updateSwarmTaskInputSchema, workerReadinessSchema,
  type Pane, type SwarmState, type SwarmTask
} from "@space/contracts";
import {
  SpaceConflictError, SpaceFeatureDisabledError, SpaceNotFoundError, redactMemoryText,
  type SpaceEventBus, type SpaceStore
} from "@space/runtime";
import type { SpaceApiConfig } from "./config.js";
import type { AuditRecorder } from "./request-audit.js";
import type { SpaceAgentAdapter } from "./space-agent.js";
import type { WorkerReadinessChecker } from "./worker-readiness.js";
import { assertAgentPaneCompatible } from "./pane-guards.js";

const idParamSchema = z.object({ id: idSchema });
const swarmStateQuerySchema = z.object({ roomId: idSchema.optional() });

async function getSwarmTaskById(store: SpaceStore, taskId: string): Promise<SwarmTask> {
  const task = (await store.listSwarmTasks({ page: 1, pageSize: 1000, sortOrder: "desc" })).find(
    (candidate) => candidate.id === taskId
  );
  if (!task) {
    throw new SpaceNotFoundError(`Swarm task ${taskId} was not found.`);
  }
  return task;
}

function swarmExecutionGate(config: SpaceApiConfig): string | null {
  if (!config.swarmExecutionEnabled) {
    return "Swarm execution is disabled. Set SPACE_SWARM_EXECUTION_ENABLED=true only after worker/agent smoke is approved.";
  }
  if (!config.agentPaneEnabled) return "SPACE_AGENT_PANE_ENABLED must be true before swarm tasks can run.";
  if (!config.enableCodexTurns) return "SPACE_ENABLE_CODEX_TURNS must be true before swarm tasks can run.";
  if (!config.codexAppServerEnabled) return "SPACE_CODEX_APP_SERVER_ENABLED must be true before swarm tasks can run.";
  if (config.codexAppServerTransport !== "stdio") return "Swarm task execution currently supports only stdio Codex App Server turns.";
  if (!config.codexAppServerAllowStdioSpawn) return "SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN must be true before swarm tasks can run.";
  if (!config.codexAppServerAllowTurnExecution) return "SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION must be true before swarm tasks can run.";
  return null;
}

function swarmStateForResponse(state: SwarmState, config: SpaceApiConfig): SwarmState {
  const gate = swarmExecutionGate(config);
  return swarmStateSchema.parse({
    ...state,
    executionStatus: gate ? "DISABLED" : "READY",
    statusReason: gate ?? "Swarm execution is ready to queue tasks into Space CHAT panes."
  });
}

async function selectSwarmAgentPane(store: SpaceStore, task: SwarmTask, paneId?: string): Promise<Pane> {
  if (paneId) {
    const pane = await store.getPane(paneId);
    if (pane.roomId !== task.roomId) {
      throw new SpaceNotFoundError(`Pane ${paneId} was not found in task room ${task.roomId}.`);
    }
    assertAgentPaneCompatible(pane);
    return pane;
  }
  const pane = (await store.listPanes(task.roomId, false)).find((candidate) => candidate.mode === "CHAT" && !candidate.isClosed);
  if (!pane) {
    throw new SpaceConflictError("Create or open a CHAT pane in this room before running a swarm task.");
  }
  return pane;
}

async function assertSwarmDependenciesDone(store: SpaceStore, task: SwarmTask): Promise<void> {
  if (!task.dependsOnTaskIds.length) return;
  const tasks = await store.listSwarmTasks({ page: 1, pageSize: 1000, sortOrder: "desc", roomId: task.roomId });
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  const incomplete = task.dependsOnTaskIds.filter((taskId) => byId.get(taskId)?.status !== "DONE");
  if (incomplete.length) {
    throw new SpaceConflictError(`Swarm task dependencies are not done: ${incomplete.join(", ")}.`);
  }
}

function buildSwarmTaskPrompt(task: SwarmTask, operatorPrompt?: string): string {
  const prompt = redactMemoryText(operatorPrompt?.trim() ?? "");
  return [
    "Space swarm task execution request:",
    `- Task id: ${task.id}`,
    `- Role: ${task.role}`,
    `- Title: ${task.title}`,
    `- Goal: ${task.goal}`,
    task.dependsOnTaskIds.length ? `- Depends on: ${task.dependsOnTaskIds.join(", ")}` : "- Depends on: none",
    "",
    "Work inside the existing Space room context. Use available Space memory, MCP, skills, browser, and CLI tools only through mediated Space tools.",
    "Return concise progress, concrete evidence, and blockers. Do not claim external actions unless they were actually executed through Space.",
    prompt ? `\nOperator run notes:\n${prompt}` : ""
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 8000);
}

/** Swarm task/lock/message domain. The composition root keeps authentication,
 * CSRF, error envelopes and rate-limit policy; registration starts no timers. */
export function registerSwarmRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  eventBus: Pick<SpaceEventBus, "publish">;
  config: SpaceApiConfig;
  workerReadinessChecker: WorkerReadinessChecker;
  spaceAgentAdapter: Pick<SpaceAgentAdapter, "sendMessage">;
  recordAudit: AuditRecorder;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { store, eventBus, config, workerReadinessChecker, spaceAgentAdapter, recordAudit, routeOptions } = options;
  app.get("/api/swarm", routeOptions, async (request) => {
    const query = swarmStateQuerySchema.parse(request.query);
    return swarmStateForResponse(await store.getSwarmState(query.roomId), config);
  });
  app.get("/api/swarm/tasks", routeOptions, async (request) => {
    const page = listSwarmTasksQuerySchema.parse(request.query);
    const tasks = await store.listSwarmTasks(page);
    const start = (page.page - 1) * page.pageSize;
    return {
      data: tasks.slice(start, start + page.pageSize),
      pagination: {
        page: page.page,
        pageSize: page.pageSize,
        totalItems: tasks.length,
        totalPages: Math.ceil(tasks.length / page.pageSize)
      }
    };
  });
  app.post("/api/swarm/tasks", routeOptions, async (request) => {
    const input = createSwarmTaskInputSchema.parse(request.body);
    const record = await store.createSwarmTask(input, request.requestIdForSpace);
    eventBus.publish(record.event);
    await recordAudit(request, {
      action: "swarm.task.create",
      targetType: "swarm_task",
      targetId: record.task.id,
      metadata: {
        roomId: record.task.roomId,
        role: record.task.role,
        status: record.task.status,
        parentTaskId: record.task.parentTaskId,
        dependencyCount: record.task.dependsOnTaskIds.length
      }
    });
    return record.task;
  });
  app.patch("/api/swarm/tasks/:id", routeOptions, async (request) => {
    const params = idParamSchema.parse(request.params);
    const input = updateSwarmTaskInputSchema.parse(request.body);
    const record = await store.updateSwarmTask(params.id, input, request.requestIdForSpace);
    eventBus.publish(record.event);
    await recordAudit(request, {
      action: "swarm.task.update",
      targetType: "swarm_task",
      targetId: record.task.id,
      metadata: {
        roomId: record.task.roomId,
        role: record.task.role,
        status: record.task.status,
        lockCount: record.task.lockIds.length,
        dependencyCount: record.task.dependsOnTaskIds.length
      }
    });
    return record.task;
  });
  app.post("/api/swarm/tasks/:id/run", routeOptions, async (request) => {
    const params = idParamSchema.parse(request.params);
    const input = runSwarmTaskInputSchema.parse(request.body ?? {});
    const gate = swarmExecutionGate(config);
    if (gate) {
      throw new SpaceFeatureDisabledError("SWARM_EXECUTION_DISABLED", gate);
    }
    const worker = workerReadinessSchema.parse(await workerReadinessChecker());
    if (worker.status !== "RUNNING" || worker.pollerCount < 1) {
      throw new SpaceFeatureDisabledError("SWARM_EXECUTION_DISABLED", worker.statusReason);
    }

    const task = await getSwarmTaskById(store, params.id);
    if (task.status === "DONE" || task.status === "CANCELLED") {
      throw new SpaceConflictError(`Swarm task ${task.id} is ${task.status} and cannot be run.`);
    }
    await assertSwarmDependenciesDone(store, task);
    const pane = await selectSwarmAgentPane(store, task, input.paneId);
    const queuedSummary = `Queued to Space agent pane ${pane.title} (${pane.id}).`;
    const running = await store.updateSwarmTask(
      task.id,
      {
        status: "RUNNING",
        assignee: pane.title,
        resultSummary: queuedSummary
      },
      request.requestIdForSpace
    );
    eventBus.publish(running.event);

    let agentResult;
    try {
      agentResult = await spaceAgentAdapter.sendMessage({
        pane,
        content: buildSwarmTaskPrompt(running.task, input.prompt),
        operatorUserId: request.user!.id,
        traceId: request.requestIdForSpace
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Swarm task could not start a Space agent run.";
      const blocked = await store.updateSwarmTask(
        task.id,
        {
          status: "BLOCKED",
          resultSummary: redactMemoryText(message).slice(0, 4000)
        },
        request.requestIdForSpace
      );
      eventBus.publish(blocked.event);
      throw error;
    }

    const messageRecord = await store.postSwarmMessage(
      {
        roomId: running.task.roomId,
        taskId: running.task.id,
        fromRole: running.task.role,
        toRole: null,
        body: `Queued ${running.task.role.toLowerCase()} task to Space agent pane ${pane.title}.`
      },
      request.requestIdForSpace
    );
    eventBus.publish(messageRecord.event);
    await recordAudit(request, {
      action: "swarm.task.run",
      targetType: "swarm_task",
      targetId: running.task.id,
      metadata: {
        roomId: running.task.roomId,
        role: running.task.role,
        status: running.task.status,
        paneId: pane.id,
        agentSessionId: agentResult.binding.sessionId
      }
    });
    return runSwarmTaskResponseSchema.parse({
      task: running.task,
      agentSession: agentResult.session,
      message: messageRecord.message
    });
  });
  app.post("/api/swarm/locks", routeOptions, async (request) => {
    const input = claimSwarmLockInputSchema.parse(request.body);
    const record = await store.claimSwarmLock(input, request.requestIdForSpace);
    eventBus.publish(record.event);
    await recordAudit(request, {
      action: "swarm.lock.claim",
      targetType: "swarm_lock",
      targetId: record.lock.id,
      metadata: {
        roomId: record.lock.roomId,
        taskId: record.lock.taskId,
        resource: record.lock.resource,
        holder: record.lock.holder,
        status: record.lock.status
      }
    });
    return record.lock;
  });
  app.post("/api/swarm/locks/:id/release", routeOptions, async (request) => {
    const params = idParamSchema.parse(request.params);
    const input = releaseSwarmLockInputSchema.parse(request.body ?? {});
    const record = await store.releaseSwarmLock(params.id, input, request.requestIdForSpace);
    eventBus.publish(record.event);
    await recordAudit(request, {
      action: "swarm.lock.release",
      targetType: "swarm_lock",
      targetId: record.lock.id,
      metadata: {
        roomId: record.lock.roomId,
        taskId: record.lock.taskId,
        resource: record.lock.resource,
        holder: record.lock.holder,
        status: record.lock.status
      }
    });
    return record.lock;
  });
  app.post("/api/swarm/messages", routeOptions, async (request) => {
    const input = postSwarmMessageInputSchema.parse(request.body);
    const record = await store.postSwarmMessage(input, request.requestIdForSpace);
    eventBus.publish(record.event);
    await recordAudit(request, {
      action: "swarm.message.post",
      targetType: "swarm_message",
      targetId: record.message.id,
      metadata: {
        roomId: record.message.roomId,
        taskId: record.message.taskId,
        fromRole: record.message.fromRole,
        toRole: record.message.toRole
      }
    });
    return record.message;
  });
  app.post("/api/swarm/reconciles", routeOptions, async (request) => {
    const input = createSwarmReconcileInputSchema.parse(request.body);
    const record = await store.createSwarmReconcile(input, request.requestIdForSpace);
    eventBus.publish(record.event);
    await recordAudit(request, {
      action: "swarm.reconcile.create",
      targetType: "swarm_reconcile",
      targetId: record.reconcile.id,
      metadata: {
        roomId: record.reconcile.roomId,
        taskCount: record.reconcile.taskIds.length,
        decision: record.reconcile.decision
      }
    });
    return record.reconcile;
  });
}
