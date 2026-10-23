#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = join(WORKER_ROOT, "tests/fixtures/workflow-histories");

function payload(value) {
  return {
    metadata: { encoding: Buffer.from("json/plain").toString("base64") },
    data: Buffer.from(JSON.stringify(value)).toString("base64")
  };
}

function patchMarkerEvent(eventId, sec, completedEventId, patchId) {
  return {
    eventId,
    eventTime: { seconds: 1700000000 + sec, nanos: 0 },
    eventType: "EVENT_TYPE_MARKER_RECORDED",
    markerRecordedEventAttributes: {
      markerName: "core_patch",
      details: {
        "patch-data": {
          payloads: [payload({ id: patchId, deprecated: false })]
        }
      },
      workflowTaskCompletedEventId: completedEventId
    }
  };
}

function buildSingleActivityHistory({
  workflowType,
  taskQueue,
  input,
  activityType,
  activityInput,
  activityResult,
  workflowResult,
  patchId = null
}) {
  let id = 1;
  const ts = (s) => ({ seconds: 1700000000 + s, nanos: 0 });
  const events = [
    {
      eventId: id++,
      eventTime: ts(0),
      eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED",
      workflowExecutionStartedEventAttributes: {
        workflowType: { name: workflowType },
        taskQueue: { name: taskQueue },
        input: { payloads: [payload(input)] },
        workflowTaskTimeout: { seconds: 10, nanos: 0 },
        originalExecutionRunId: `run-${workflowType}-1`,
        firstExecutionRunId: `run-${workflowType}-1`
      }
    },
    {
      eventId: id++,
      eventTime: ts(1),
      eventType: "EVENT_TYPE_WORKFLOW_TASK_SCHEDULED",
      workflowTaskScheduledEventAttributes: { taskQueue: { name: taskQueue } }
    },
    {
      eventId: id++,
      eventTime: ts(2),
      eventType: "EVENT_TYPE_WORKFLOW_TASK_STARTED",
      workflowTaskStartedEventAttributes: { scheduledEventId: 2 }
    },
    {
      eventId: id++,
      eventTime: ts(3),
      eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED",
      workflowTaskCompletedEventAttributes: { scheduledEventId: 2, startedEventId: 3 }
    }
  ];

  if (patchId) {
    events.push(patchMarkerEvent(id++, 3, 4, patchId));
  }

  const actSchedId = id++;
  const actStartId = id++;
  const actCompId = id++;
  const wt2SchedId = id++;
  const wt2StartId = id++;
  const wt2CompId = id++;
  const wfCompId = id++;

  events.push(
    {
      eventId: actSchedId,
      eventTime: ts(4),
      eventType: "EVENT_TYPE_ACTIVITY_TASK_SCHEDULED",
      activityTaskScheduledEventAttributes: {
        activityId: "1",
        activityType: { name: activityType },
        taskQueue: { name: taskQueue },
        input: { payloads: [payload(activityInput)] },
        workflowTaskCompletedEventId: 4
      }
    },
    {
      eventId: actStartId,
      eventTime: ts(5),
      eventType: "EVENT_TYPE_ACTIVITY_TASK_STARTED",
      activityTaskStartedEventAttributes: { scheduledEventId: actSchedId }
    },
    {
      eventId: actCompId,
      eventTime: ts(6),
      eventType: "EVENT_TYPE_ACTIVITY_TASK_COMPLETED",
      activityTaskCompletedEventAttributes: {
        scheduledEventId: actSchedId,
        startedEventId: actStartId,
        result: { payloads: [payload(activityResult)] }
      }
    },
    {
      eventId: wt2SchedId,
      eventTime: ts(7),
      eventType: "EVENT_TYPE_WORKFLOW_TASK_SCHEDULED",
      workflowTaskScheduledEventAttributes: { taskQueue: { name: taskQueue } }
    },
    {
      eventId: wt2StartId,
      eventTime: ts(8),
      eventType: "EVENT_TYPE_WORKFLOW_TASK_STARTED",
      workflowTaskStartedEventAttributes: { scheduledEventId: wt2SchedId }
    },
    {
      eventId: wt2CompId,
      eventTime: ts(9),
      eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED",
      workflowTaskCompletedEventAttributes: { scheduledEventId: wt2SchedId, startedEventId: wt2StartId }
    },
    {
      eventId: wfCompId,
      eventTime: ts(10),
      eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED",
      workflowExecutionCompletedEventAttributes: {
        workflowTaskCompletedEventId: wt2CompId,
        result: { payloads: [payload(workflowResult)] }
      }
    }
  );

  return {
    workflowType,
    workflowId: `replay:${workflowType}`,
    bundle: workflowType.startsWith("memoryMaintenance") || workflowType.startsWith("memoryConsolidation")
      ? "memory-maintenance-workflows"
      : workflowType === "memoryMutationWorkflow"
        ? "memory-mutation-workflows"
        : "workflows",
    events
  };
}

function buildTwoActivityHistory({
  workflowType,
  taskQueue,
  input,
  act1Type,
  act1Input,
  act1Result,
  act2Type,
  act2Input,
  act2Result,
  workflowResult
}) {
  const ts = (s) => ({ seconds: 1700000000 + s, nanos: 0 });
  return {
    workflowType,
    workflowId: `replay:${workflowType}`,
    bundle: "workflows",
    events: [
      {
        eventId: 1,
        eventTime: ts(0),
        eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED",
        workflowExecutionStartedEventAttributes: {
          workflowType: { name: workflowType },
          taskQueue: { name: taskQueue },
          input: { payloads: [payload(input)] },
          workflowTaskTimeout: { seconds: 10, nanos: 0 },
          originalExecutionRunId: `run-${workflowType}-1`,
          firstExecutionRunId: `run-${workflowType}-1`
        }
      },
      { eventId: 2, eventTime: ts(1), eventType: "EVENT_TYPE_WORKFLOW_TASK_SCHEDULED", workflowTaskScheduledEventAttributes: { taskQueue: { name: taskQueue } } },
      { eventId: 3, eventTime: ts(2), eventType: "EVENT_TYPE_WORKFLOW_TASK_STARTED", workflowTaskStartedEventAttributes: { scheduledEventId: 2 } },
      { eventId: 4, eventTime: ts(3), eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED", workflowTaskCompletedEventAttributes: { scheduledEventId: 2, startedEventId: 3 } },
      {
        eventId: 5,
        eventTime: ts(4),
        eventType: "EVENT_TYPE_ACTIVITY_TASK_SCHEDULED",
        activityTaskScheduledEventAttributes: {
          activityId: "1",
          activityType: { name: act1Type },
          taskQueue: { name: taskQueue },
          input: { payloads: [payload(act1Input)] },
          workflowTaskCompletedEventId: 4
        }
      },
      { eventId: 6, eventTime: ts(5), eventType: "EVENT_TYPE_ACTIVITY_TASK_STARTED", activityTaskStartedEventAttributes: { scheduledEventId: 5 } },
      {
        eventId: 7,
        eventTime: ts(6),
        eventType: "EVENT_TYPE_ACTIVITY_TASK_COMPLETED",
        activityTaskCompletedEventAttributes: { scheduledEventId: 5, startedEventId: 6, result: { payloads: [payload(act1Result)] } }
      },
      { eventId: 8, eventTime: ts(7), eventType: "EVENT_TYPE_WORKFLOW_TASK_SCHEDULED", workflowTaskScheduledEventAttributes: { taskQueue: { name: taskQueue } } },
      { eventId: 9, eventTime: ts(8), eventType: "EVENT_TYPE_WORKFLOW_TASK_STARTED", workflowTaskStartedEventAttributes: { scheduledEventId: 8 } },
      { eventId: 10, eventTime: ts(9), eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED", workflowTaskCompletedEventAttributes: { scheduledEventId: 8, startedEventId: 9 } },
      {
        eventId: 11,
        eventTime: ts(10),
        eventType: "EVENT_TYPE_ACTIVITY_TASK_SCHEDULED",
        activityTaskScheduledEventAttributes: {
          activityId: "2",
          activityType: { name: act2Type },
          taskQueue: { name: taskQueue },
          input: { payloads: [payload(act2Input)] },
          workflowTaskCompletedEventId: 10
        }
      },
      { eventId: 12, eventTime: ts(11), eventType: "EVENT_TYPE_ACTIVITY_TASK_STARTED", activityTaskStartedEventAttributes: { scheduledEventId: 11 } },
      {
        eventId: 13,
        eventTime: ts(12),
        eventType: "EVENT_TYPE_ACTIVITY_TASK_COMPLETED",
        activityTaskCompletedEventAttributes: { scheduledEventId: 11, startedEventId: 12, result: { payloads: [payload(act2Result)] } }
      },
      { eventId: 14, eventTime: ts(13), eventType: "EVENT_TYPE_WORKFLOW_TASK_SCHEDULED", workflowTaskScheduledEventAttributes: { taskQueue: { name: taskQueue } } },
      { eventId: 15, eventTime: ts(14), eventType: "EVENT_TYPE_WORKFLOW_TASK_STARTED", workflowTaskStartedEventAttributes: { scheduledEventId: 14 } },
      { eventId: 16, eventTime: ts(15), eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED", workflowTaskCompletedEventAttributes: { scheduledEventId: 14, startedEventId: 15 } },
      {
        eventId: 17,
        eventTime: ts(16),
        eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED",
        workflowExecutionCompletedEventAttributes: { workflowTaskCompletedEventId: 16, result: { payloads: [payload(workflowResult)] } }
      }
    ]
  };
}

function buildSupervisorHistory({ patchedBranch }) {
  const ts = (s) => ({ seconds: 1700000000 + s, nanos: 0 });
  const item = {
    missionId: "mission:replay-1",
    turn: {
      roomId: "room:replay",
      paneId: "pane:replay",
      prompt: "Synthetic replay prompt",
      artifactIds: [],
      agentRunId: "agent_run:replay-1",
      permissionMode: null,
      collaborationMode: "default",
      traceId: "req:replay123456"
    }
  };
  const input = {
    roomId: "room:replay",
    pending: [],
    monitoringMissionIds: ["mission:replay-1"],
    interrupted: [],
    processedCount: 0
  };
  const events = [
    {
      eventId: 1,
      eventTime: ts(0),
      eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED",
      workflowExecutionStartedEventAttributes: {
        workflowType: { name: "roomAgentSupervisorWorkflow" },
        taskQueue: { name: "space-default" },
        input: { payloads: [payload(input)] },
        workflowTaskTimeout: { seconds: 10, nanos: 0 },
        originalExecutionRunId: "run-sup-1",
        firstExecutionRunId: "run-sup-1"
      }
    },
    { eventId: 2, eventTime: ts(1), eventType: "EVENT_TYPE_WORKFLOW_TASK_SCHEDULED", workflowTaskScheduledEventAttributes: { taskQueue: { name: "space-default" } } },
    { eventId: 3, eventTime: ts(2), eventType: "EVENT_TYPE_WORKFLOW_TASK_STARTED", workflowTaskStartedEventAttributes: { scheduledEventId: 2 } },
    { eventId: 4, eventTime: ts(3), eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED", workflowTaskCompletedEventAttributes: { scheduledEventId: 2, startedEventId: 3 } }
  ];
  let nextId = 5;
  if (patchedBranch) {
    events.push(patchMarkerEvent(nextId++, 3, 4, "room-background-continuation-v1"));
  }
  events.push({
    eventId: nextId++,
    eventTime: ts(4),
    eventType: "EVENT_TYPE_TIMER_STARTED",
    timerStartedEventAttributes: {
      timerId: "1",
      workflowTaskCompletedEventId: 4,
      startToFireTimeout: { seconds: 1, nanos: 0 }
    }
  });
  return {
    workflowType: "roomAgentSupervisorWorkflow",
    workflowId: patchedBranch ? "replay:roomAgentSupervisorWorkflow:current" : "replay:roomAgentSupervisorWorkflow:legacy",
    bundle: "workflows",
    events
  };
}

function buildMemoryMaintenanceHistory() {
  const ts = (s) => ({ seconds: 1700000000 + s, nanos: 0 });
  const input = { trigger: "scheduled", traceId: "req:mem123456789" };
  return {
    workflowType: "memoryMaintenanceWorkflow",
    workflowId: "replay:memoryMaintenanceWorkflow",
    bundle: "memory-maintenance-workflows",
    events: [
      {
        eventId: 1,
        eventTime: ts(0),
        eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED",
        workflowExecutionStartedEventAttributes: {
          workflowType: { name: "memoryMaintenanceWorkflow" },
          taskQueue: { name: "space-memory-maintenance" },
          input: { payloads: [payload(input)] },
          workflowTaskTimeout: { seconds: 10, nanos: 0 },
          originalExecutionRunId: "run-mm-1",
          firstExecutionRunId: "run-mm-1"
        }
      },
      { eventId: 2, eventTime: ts(1), eventType: "EVENT_TYPE_WORKFLOW_TASK_SCHEDULED", workflowTaskScheduledEventAttributes: { taskQueue: { name: "space-memory-maintenance" } } },
      { eventId: 3, eventTime: ts(2), eventType: "EVENT_TYPE_WORKFLOW_TASK_STARTED", workflowTaskStartedEventAttributes: { scheduledEventId: 2 } },
      { eventId: 4, eventTime: ts(3), eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED", workflowTaskCompletedEventAttributes: { scheduledEventId: 2, startedEventId: 3 } },
      {
        eventId: 5,
        eventTime: ts(4),
        eventType: "EVENT_TYPE_ACTIVITY_TASK_SCHEDULED",
        activityTaskScheduledEventAttributes: {
          activityId: "1",
          activityType: { name: "refreshMemoryGraphSnapshot" },
          taskQueue: { name: "space-memory-maintenance" },
          input: { payloads: [payload(input)] },
          workflowTaskCompletedEventId: 4
        }
      }
    ]
  };
}

export async function recordAllFixtures() {
  await mkdir(FIXTURES_DIR, { recursive: true });
  const dummyInput = {
    roomId: "room:1",
    paneId: "pane:1",
    prompt: "Synthetic test prompt",
    artifactIds: [],
    agentRunId: "agent_run:1",
    permissionMode: null,
    collaborationMode: "default",
    traceId: "req:1234567890ab"
  };

  const fixtures = {
    "dotGoalWorkflow.json": buildSingleActivityHistory({
      workflowType: "dotGoalWorkflow",
      taskQueue: "space-default",
      input: { goalId: "goal:1" },
      activityType: "dotGoalStep",
      activityInput: "goal:1",
      activityResult: { state: "DONE", goalStatus: "COMPLETED", runId: null },
      workflowResult: { goalStatus: "COMPLETED" }
    }),
    "dummyTurnWorkflow.json": buildTwoActivityHistory({
      workflowType: "dummyTurnWorkflow",
      taskQueue: "space-default",
      input: dummyInput,
      act1Type: "recordDummyTurnStarted",
      act1Input: dummyInput,
      act1Result: { ok: true },
      act2Type: "recordDummyTurnCompleted",
      act2Input: dummyInput,
      act2Result: { status: "COMPLETED", message: "ok" },
      workflowResult: { status: "COMPLETED", message: "ok" }
    }),
    "codexAppServerTurnWorkflow.json": buildSingleActivityHistory({
      workflowType: "codexAppServerTurnWorkflow",
      taskQueue: "space-default",
      input: { ...dummyInput, providerId: "opencode" },
      activityType: "runOpenCodeAgentTurn",
      activityInput: { ...dummyInput, providerId: "opencode" },
      activityResult: { status: "COMPLETED", message: "done" },
      workflowResult: { status: "COMPLETED", message: "done" }
    }),
    "roomAgentSupervisorWorkflow-current.json": buildSupervisorHistory({ patchedBranch: true }),
    "roomAgentSupervisorWorkflow-legacy.json": buildSupervisorHistory({ patchedBranch: false }),
    "roomAgentActionWorkflow.json": buildSingleActivityHistory({
      workflowType: "roomAgentActionWorkflow",
      taskQueue: "space-default",
      input: { actionId: "action:1", traceId: "req:1234567890ab", bridge: { roomId: "room:1", missionId: "mission:1" } },
      activityType: "runRoomAgentBackgroundAction",
      activityInput: { actionId: "action:1", traceId: "req:1234567890ab", bridge: { roomId: "room:1", missionId: "mission:1" } },
      activityResult: { status: "COMPLETED" },
      workflowResult: { status: "COMPLETED" }
    }),
    "memoryMaintenanceWorkflow.json": buildMemoryMaintenanceHistory(),
    "memoryConsolidationWorkflow.json": buildSingleActivityHistory({
      workflowType: "memoryConsolidationWorkflow",
      taskQueue: "space-memory-maintenance",
      input: { runId: "mc_run:1", traceId: "req:1234567890ab" },
      activityType: "prepareMemoryConsolidation",
      activityInput: { runId: "mc_run:1", traceId: "req:1234567890ab" },
      activityResult: { changeSetId: null, run: { id: "mc_run:1", status: "NO_CHANGES" } },
      workflowResult: { id: "mc_run:1", status: "NO_CHANGES" }
    }),
    "memoryMutationWorkflow.json": buildSingleActivityHistory({
      workflowType: "memoryMutationWorkflow",
      taskQueue: "space-memory-mutation",
      input: { changeSetId: "cs:1", traceId: "req:1234567890ab" },
      activityType: "executePersistedMemoryChangeSet",
      activityInput: { changeSetId: "cs:1", traceId: "req:1234567890ab" },
      activityResult: { status: "APPLIED", changeSetId: "cs:1" },
      workflowResult: { status: "APPLIED", changeSetId: "cs:1" }
    })
  };

  for (const [name, data] of Object.entries(fixtures)) {
    await writeFile(join(FIXTURES_DIR, name), JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  await writeFile(
    join(FIXTURES_DIR, "README.md"),
    [
      "# Temporal Workflow Replay History Fixtures",
      "",
      "These synthetic JSON histories are replayed in CI via `Worker.runReplayHistories` (`apps/worker/tests/workflow-replay-determinism.test.ts`) to guarantee that workflow changes remain replay-compatible with running executions.",
      "",
      "## Re-recording histories",
      "",
      "```sh",
      "npm run temporal:record-histories -w @space/worker",
      "```",
      "",
      "**Policy:** Re-recording histories is allowed **only** when adding a new workflow or introducing a replay-safe `patched(\"<patch-id>\")` branch alongside both pre-patch and post-patch fixtures. Never re-record histories to make a failing determinism check pass.",
      ""
    ].join("\n"),
    "utf8"
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await recordAllFixtures();
}
