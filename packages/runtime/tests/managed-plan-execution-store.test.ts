import { describe, expect, it } from "vitest";
import * as runtime from "../src/index.js";
const { InMemorySpaceStore } = runtime;
const steps = [
  {
    id: "build",
    order: 1,
    title: "Build",
    modelId: "gpt-6.1-sol",
    reasoningEffort: "high",
    instructions: "Build feature",
    completionCriteria: ["Tests pass"],
  },
];
function fixture() {
  const store = new InMemorySpaceStore();
  const plan = store.upsertClipboardItem({
    ownerUserId: "user:one",
    source: "PLAN",
    text: "Plan body",
    minimumModel: "gpt-6.1-sol",
    steps,
  });
  return {
    store,
    plan,
    input: {
      ownerUserId: "user:one",
      planId: plan.id,
      paneId: "pane:one",
      sessionId: "cli_session:one",
      threadId: "thread-one",
      cwd: "/project",
      requestId: "request-one",
      snapshot: { text: plan.text, title: plan.title, stages: steps },
    },
  };
}
describe("durable managed plan records", () => {
  it("preserves stage fields and immutable snapshot on reload", async () => {
    const { store, plan, input } = fixture();
    expect(plan.steps[0]).toMatchObject({
      modelId: "gpt-6.1-sol",
      instructions: "Build feature",
    });
    const execution = await store.planExecutions.create(input);
    execution.snapshot.stages[0]!.instructions = "Mutated";
    const reloaded = new runtime.InMemoryPlanExecutionRepository(
      store.planExecutions.snapshot(),
    );
    expect(
      (await reloaded.get("user:one", execution.id))?.snapshot.stages[0]
        ?.instructions,
    ).toBe("Build feature");
  });
  it("deduplicates starts and enforces pane and plan exclusivity", async () => {
    const { store, input } = fixture();
    const first = await store.planExecutions.create(input);
    expect((await store.planExecutions.create(input)).id).toBe(first.id);
    await expect(
      store.planExecutions.create({
        ...input,
        requestId: "request-two",
        planId: "clipboard:two",
      }),
    ).rejects.toThrow();
    await expect(
      store.planExecutions.create({
        ...input,
        requestId: "request-three",
        paneId: "pane:two",
      }),
    ).rejects.toThrow();
  });
  it("hides other owners and rejects stale or concurrent updates", async () => {
    const { store, input } = fixture();
    const execution = await store.planExecutions.create(input);
    expect(await store.planExecutions.get("user:two", execution.id)).toBeNull();
    await expect(
      store.planExecutions.update("user:two", execution.id, 0, {
        status: "PAUSED",
      }),
    ).rejects.toThrow();
    const results = await Promise.allSettled([
      store.planExecutions.update("user:one", execution.id, 0, {
        status: "PAUSED",
      }),
      store.planExecutions.update("user:one", execution.id, 0, {
        status: "BLOCKED",
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
  });
  it("fences expired controller leases even after a second process takes over", async () => {
    const { store, input } = fixture();
    const execution = await store.planExecutions.create(input);
    const now = Date.now();
    const old = await store.planExecutions.claim(
      execution.id,
      "worker-one",
      now - 200,
      100,
    );
    expect(
      await store.planExecutions.claim(
        execution.id,
        "worker-two",
        now - 150,
        100,
      ),
    ).toBeNull();
    const fresh = await store.planExecutions.claim(
      execution.id,
      "worker-two",
      now,
      10000,
    );
    await expect(
      store.planExecutions.update(
        "user:one",
        execution.id,
        0,
        { checkpoint: "Old write" },
        old!.lease!,
      ),
    ).rejects.toThrow();
    expect(
      (
        await store.planExecutions.update(
          "user:one",
          execution.id,
          0,
          { checkpoint: "New write" },
          fresh!.lease!,
        )
      ).checkpoint,
    ).toBe("New write");
  });
  it("prevents legacy completion from bypassing managed criteria", async () => {
    const { store, plan, input } = fixture();
    await store.planExecutions.create(input);
    await expect(
      Promise.resolve().then(() =>
        store.updateClipboardItemProgress("user:one", plan.id, {
          progressPercentage: 100,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve().then(() =>
        store.setClipboardItemCompleted("user:one", plan.id, true),
      ),
    ).rejects.toThrow();
    expect(store.getClipboardItem("user:one", plan.id)?.isCompleted).toBe(
      false,
    );
  });
  it("resaving a managed PLAN cannot inject completed stage progress", async () => {
    const { store, plan, input } = fixture();
    await store.planExecutions.create(input);
    const saved = store.upsertClipboardItem({
      ownerUserId: "user:one",
      source: "PLAN",
      text: plan.text,
      minimumModel: "gpt-6.1-sol",
      steps: [{ ...steps[0]!, status: "COMPLETED", progress: 100 }],
    });
    expect(saved.steps[0]?.status).toBe("PENDING");
  });
  it("cannot reactivate a finished execution after another execution owns its pane", async () => {
    const { store, input } = fixture();
    const old = await store.planExecutions.create(input);
    await store.planExecutions.update("user:one", old.id, 0, {
      status: "COMPLETED",
    });
    await store.planExecutions.create({
      ...input,
      requestId: "new-request",
      planId: "clipboard:new",
    });
    await expect(
      store.planExecutions.update("user:one", old.id, 1, { status: "RUNNING" }),
    ).rejects.toThrow();
  });
});

it('atomically rejects an evidence-free checkpoint and projects accepted state',async()=>{
  const {store,input,plan}=fixture();
  const e=await store.planExecutions.create(input);
  await expect(store.planExecutions.update(e.ownerUserId,e.id,e.revision,{status:'COMPLETED',completedStageIds:['build']},undefined,true)).rejects.toThrow();
  expect((await store.planExecutions.get(e.ownerUserId,e.id))?.revision).toBe(0);
  const next=await store.planExecutions.update(e.ownerUserId,e.id,e.revision,{checkpoint:'Working'},undefined,true);
  expect(store.getClipboardItem(e.ownerUserId,plan.id)?.steps[0]?.status).toBe('IN_PROGRESS');
  await expect(store.projectManagedPlanExecution(e.ownerUserId,e.id,e.revision)).rejects.toThrow();
  expect(next.revision).toBe(1);
});

it('does not apply a stale initial projection over a newer atomic checkpoint',async()=>{
 const {store,input,plan}=fixture();const e=await store.planExecutions.create(input);
 const initial=store.projectManagedPlanExecution(e.ownerUserId,e.id,e.revision);
 const update=store.planExecutions.update(e.ownerUserId,e.id,e.revision,{attempts:[{id:'a',stageId:'build',commandId:'cmd',turnId:'turn',modelId:'gpt-6.1-sol',reasoningEffort:'high',actualSelection:{modelId:'gpt-6.1-sol',reasoningEffort:'high',source:'NATIVE_ACCEPTED_TURN_CONFIGURATION',observedAt:e.createdAt,completedAt:e.createdAt,threadId:e.threadId,turnId:'turn',commandId:'cmd',transport:'CONTINUOUS_NATIVE_NOTIFICATIONS',providerTelemetry:false},status:'RUNNING',startedAt:e.createdAt,completedAt:null,result:null}]},undefined,true);
 await Promise.allSettled([initial,update]);
 expect(store.getClipboardItem(e.ownerUserId,plan.id)?.steps[0]?.agent).toBe('gpt-6.1-sol');
});

it('retains a relay sequence for managed plan status events',()=>{
 const {store}=fixture();
 const room=store.createRoom({name:'Plan events',initialPaneCount:0});
 const event=store.recordRoomEvent({roomId:room.id,paneId:null,turnId:null,traceId:'trace:plan',type:'PLAN_EXECUTION_UPDATED',message:'Managed plan execution updated.',payload:{executionId:'execution:one',revision:1}});
 expect(store.listEventChanges({afterSequence:'0',limit:50,sortOrder:'asc'}).find(change=>change.event.id===event.id)?.sequence).toMatch(/^\d+$/);
});

it('deduplicates durable managed events and relay sequences after lost publication acknowledgment',async()=>{
 const {store,input}=fixture();const room=store.createRoom({name:'Outbox proof',initialPaneCount:1});
 const pane=store.listPanes(room.id)[0]!;
 const execution=await store.planExecutions.create({...input,paneId:pane.id},true);
 const event=(await store.planExecutions.listPendingEvents()).find(e=>e.executionId===execution.id)!;
 const first=await store.publishManagedPlanExecutionEvent(event);
 const duplicate=await store.publishManagedPlanExecutionEvent(event);
 expect(duplicate).toEqual(first);
 expect(store.listEvents(room.id).filter(e=>e.id===first.id)).toHaveLength(1);
 expect(store.listEventChanges({afterSequence:'0',limit:100,sortOrder:'asc'}).filter(c=>c.event.id===first.id)).toHaveLength(1);
 expect((await store.planExecutions.listPendingEvents()).some(e=>e.id===event.id)).toBe(true);
 await store.planExecutions.acknowledgeEvent(execution.id,event.revision);
 expect(await store.planExecutions.listPendingEvents()).toEqual([]);
});
