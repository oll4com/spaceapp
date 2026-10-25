import { createServer, type Server } from "node:http";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  assertCodexAppServerSocketRpcMethodAllowed,
  codexAppServerSocketMaxPayloadBytes,
  createCodexAppServerSocketControlService
} from "../src/index.js";

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function listen(
  respond: (message: RpcMessage, socket: WebSocket) => unknown | Promise<unknown>
): Promise<{ socketPath: string; messages: RpcMessage[] }> {
  const root = await mkdtemp(join(tmpdir(), "space-codex-socket-control-"));
  const socketPath = join(root, "app-server.sock");
  const messages: RpcMessage[] = [];
  const sockets = new Set<WebSocket>();
  const server: Server = createServer();
  const websocketServer = new WebSocketServer({ server });
  websocketServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (data, isBinary) => {
      if (isBinary) return socket.close();
      const message = JSON.parse(data.toString()) as RpcMessage;
      messages.push(message);
      void Promise.resolve(respond(message, socket)).then((response) => {
        if (response !== undefined && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(response));
        }
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { socketPath, messages };
}

function initializedServer(extra: (message: RpcMessage) => unknown | Promise<unknown>) {
  return async (message: RpcMessage) => {
    if (message.method === "initialize") {
      return { id: message.id, result: { userAgent: "codex-test" } };
    }
    if (message.method === "initialized") return undefined;
    return extra(message);
  };
}

describe("Codex App Server Unix-socket control", () => {
  it("keeps older multiplexers usable when primary selection metadata is absent", async () => {
    const server = await listen(initializedServer(() => undefined));
    const service = createCodexAppServerSocketControlService({ socketPath: server.socketPath });
    await expect(service.readCurrentThreadId!()).resolves.toBeUndefined();
    expect(server.messages.filter(message => message.method !== "initialize" && message.method !== "initialized")).toEqual([]);
  });

  it("reads the native resume name without starting a turn or using the legacy title", async () => {
    const server = await listen(initializedServer(message => message.method === "thread/read" ? {id:message.id,result:{thread:{id:"thread:1",name:"Native task name",title:"Legacy prompt"}}} : undefined));
    const service=createCodexAppServerSocketControlService({socketPath:server.socketPath,timeoutMs:500});
    await expect(service.getThreadName!("thread:1")).resolves.toBe("Native task name");
    expect(server.messages.some(m=>m.method==="turn/start")).toBe(false);
    await expect(service.getThreadName!("thread:other")).rejects.toThrow("identity");
  });
  it("renames the exact thread and confirms the persisted name without starting a turn", async () => {
    const server = await listen(initializedServer(message => {
      if (message.method === "thread/name/set") return {id:message.id,result:{}};
      if (message.method === "thread/read") return {id:message.id,result:{thread:{id:"thread:1",name:"Task title"}}};
      return undefined;
    }));
    const service=createCodexAppServerSocketControlService({socketPath:server.socketPath,timeoutMs:500});
    await expect(service.renameThread!({threadId:"thread:1",name:"Task title"})).resolves.toBe("Task title");
    expect(server.messages.find(m=>m.method==="thread/name/set")?.params).toEqual({threadId:"thread:1",name:"Task title"});
    expect(server.messages.some(m=>m.method==="turn/start")).toBe(false);
  });
  it("rejects a rename that the native thread did not retain", async () => {
    const server=await listen(initializedServer(message=>({id:message.id,result:message.method==="thread/read"?{thread:{id:"thread:1",name:"Unchanged"}}:{}})));
    const service=createCodexAppServerSocketControlService({socketPath:server.socketPath,timeoutMs:500});
    await expect(service.renameThread!({threadId:"thread:1",name:"Task title"})).rejects.toThrow();
  });

  it("initializes and normalizes the visible model catalog", async () => {
    const server = await listen(initializedServer((message) => {
      if (message.method !== "model/list") return undefined;
      return {
        id: message.id,
        result: {
          data: [
            {
              model: "gpt-6-astra",
              displayName: "GPT-6-Astra",
              isDefault: false,
              hidden: true,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "Balanced" },
                { reasoningEffort: "ultra", description: "Delegated" }
              ]
            },
            {
              model: "gpt-reserve",
              displayName: "GPT Reserve",
              isDefault: false,
              hidden: true,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: [{ reasoningEffort: "medium" }]
            },
            {
              id: "catalog:gpt-5.6",
              model: "gpt-5.6",
              displayName: "GPT-5.6",
              description: "Provider-described coding model.",
              isDefault: true,
              hidden: false,
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "Fast" },
                { reasoningEffort: "high", description: "Deep" },
                { reasoningEffort: "xhigh", description: "Deeper" },
                { reasoningEffort: "research", description: "Provider-specific exploration." }
              ]
            }
          ],
          nextCursor: null
        }
      };
    }));

    const service = createCodexAppServerSocketControlService({ socketPath: server.socketPath, timeoutMs: 500 });
    await expect(service.listModels()).resolves.toEqual([
      {
        id: "gpt-6-astra",
        displayName: "GPT-6-Astra",
        description: undefined,
        isDefault: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium", "ultra"],
        reasoningOptions: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "ultra", description: "Delegated" }
        ]
      },
      {
        id: "gpt-5.6",
        displayName: "GPT-5.6",
        description: "Provider-described coding model.",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["medium", "high", "xhigh", "research"],
        reasoningOptions: [
          { reasoningEffort: "medium", description: "Fast" },
          { reasoningEffort: "high", description: "Deep" },
          { reasoningEffort: "xhigh", description: "Deeper" },
          { reasoningEffort: "research", description: "Provider-specific exploration." }
        ]
      }
    ]);
    expect(server.messages.map((message) => message.method)).toEqual(["initialize", "initialized", "model/list"]);
    expect(server.messages.at(-1)?.params).toEqual({ includeHidden: true, cursor: null, limit: 100 });
  });

  it("rejects a provider default that is absent from its advertised reasoning options", async () => {
    const server = await listen(initializedServer((message) => {
      if (message.method !== "model/list") return undefined;
      return {
        id: message.id,
        result: {
          data: [{
            model: "gpt-5.6",
            displayName: "GPT-5.6",
            isDefault: true,
            defaultReasoningEffort: "unlisted",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }]
          }],
          nextCursor: null
        }
      };
    }));
    const service = createCodexAppServerSocketControlService({ socketPath: server.socketPath, timeoutMs: 500 });

    await expect(service.listModels()).rejects.toThrow("model/list response was invalid");
  });

  it("interrupts a specific active turn", async () => {
    const server = await listen(initializedServer((message) => {
      if (message.method === "turn/interrupt") return { id: message.id, result: {} };
      return undefined;
    }));
    const service = createCodexAppServerSocketControlService({ socketPath: server.socketPath, timeoutMs: 500 });

    await expect(service.interruptTurn({ threadId: "thread:1", turnId: "turn:1" })).resolves.toBeUndefined();
    expect(server.messages.at(-1)).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "thread:1", turnId: "turn:1" }
    });
  });

  it("updates an attached thread with model and reasoning overrides", async () => {
    const server = await listen(initializedServer((message) => {
      if (message.method === "thread/settings/update") {
        return { id: message.id, result: {} };
      }
      return undefined;
    }));
    const service = createCodexAppServerSocketControlService({ socketPath: server.socketPath, timeoutMs: 500 });

    await expect(service.updateThreadSettings({
      threadId: "thread:1",
      model: "gpt-5.5",
      reasoningEffort: "xhigh"
    })).resolves.toBeUndefined();
    expect(server.messages.at(-1)).toMatchObject({
      method: "thread/settings/update",
      params: { threadId: "thread:1", model: "gpt-5.5", effort: "xhigh" }
    });
  });

  it("starts an idempotent continuation with model and reasoning overrides", async () => {
    const server = await listen(initializedServer((message) => {
      if (message.method === "turn/start") {
        return { id: message.id, result: { turn: { id: "turn:continued", status: "inProgress" } } };
      }
      return undefined;
    }));
    const service = createCodexAppServerSocketControlService({ socketPath: server.socketPath, timeoutMs: 500 });

    await expect(service.startTurn({
      threadId: "thread:1",
      prompt: "Continue exactly from the interrupted turn.",
      model: "gpt-5.6",
      reasoningEffort: "xhigh",
      clientUserMessageId: "space-model-switch:session:1:request:1"
    })).resolves.toEqual({ turnId: "turn:continued", status: "inProgress" });
    expect(server.messages.at(-1)).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread:1",
        model: "gpt-5.6",
        effort: "xhigh",
        clientUserMessageId: "space-model-switch:session:1:request:1",
        input: [{ type: "text", text: "Continue exactly from the interrupted turn.", text_elements: [] }]
      }
    });
  });

  it("sanitizes remote failures and bounds unresponsive sockets", async () => {
    const failing = await listen(initializedServer((message) => {
      if (message.method === "turn/interrupt") {
        return { id: message.id, error: { message: "secret upstream token and filesystem detail" } };
      }
      return undefined;
    }));
    const hanging = await listen(initializedServer(() => undefined));

    await expect(
      createCodexAppServerSocketControlService({ socketPath: failing.socketPath, timeoutMs: 500 })
        .interruptTurn({ threadId: "thread:1", turnId: "turn:1" })
    ).rejects.toThrow("Codex App Server turn/interrupt returned an error.");
    await expect(
      createCodexAppServerSocketControlService({ socketPath: hanging.socketPath, timeoutMs: 20 }).listModels()
    ).rejects.toThrow("Codex App Server socket request timed out.");
  });

  it("accepts control responses above the legacy one-megabyte envelope", async () => {
    const padding = "x".repeat(1_100_000);
    const server = await listen(initializedServer((message) => {
      if (message.method === "turn/interrupt") {
        return { id: message.id, result: { padding } };
      }
      return undefined;
    }));
    const service = createCodexAppServerSocketControlService({ socketPath: server.socketPath, timeoutMs: 1_500 });

    expect(codexAppServerSocketMaxPayloadBytes).toBe(16 * 1_024 * 1_024);
    await expect(
      service.interruptTurn({ threadId: "thread:large", turnId: "turn:large" })
    ).resolves.toBeUndefined();
  });

  it("uses a strict socket RPC allowlist", () => {
    for (const method of [
      "initialize",
      "model/list",
      "thread/list",
      "thread/read",
      "thread/settings/update",
      "turn/interrupt",
      "turn/start"
    ]) {
      expect(() => assertCodexAppServerSocketRpcMethodAllowed(method)).not.toThrow();
    }
    expect(() => assertCodexAppServerSocketRpcMethodAllowed("thread/resume")).toThrow(
      "Codex App Server socket RPC method is not allowed."
    );
    expect(() => assertCodexAppServerSocketRpcMethodAllowed("config/value/write")).toThrow(
      "Codex App Server socket RPC method is not allowed."
    );
  });
});

it("reads native model settings without requesting turns and rejects a different thread", async () => {
  const server = await listen(initializedServer(message => ({ id: message.id,
    result: { thread: { id: "thread:one", model: "gpt-6-astra", reasoningEffort: "high", cwd: "/etc", status: {type: "active"} } } })));
  const service = createCodexAppServerSocketControlService({socketPath: server.socketPath, timeoutMs: 500});
  await expect(service.readThreadSettings!("thread:one")).resolves.toEqual({modelId: "gpt-6-astra", reasoningEffort: "high", cwd: "/etc", isTurnActive: true});
  expect(server.messages.filter(message => message.method === "thread/read")).toEqual([{id: 1, method: "thread/read", params: {threadId: "thread:one", includeTurns: false}}]);
  await expect(service.readThreadSettings!("thread:other")).rejects.toThrow("confirm");
});

it('reads full native turns, client correlation, result and actual thread selection', async () => {
  const server = await listen(initializedServer(message => ({id:message.id,result:{thread:{id:'thread:managed',cwd:'/project',model:'model-a',reasoningEffort:'high',status:{type:'active',activeFlags:['waitingOnUserInput']},turns:[{id:'turn:one',status:'completed',itemsView:'full',items:[{type:'userMessage',id:'msg',clientId:'command:one',content:[]},{type:'agentMessage',phase:'final_answer',text:'{"outcome":"CONTINUE"}'}]}]}}})));
  const service=createCodexAppServerSocketControlService({socketPath:server.socketPath});
  expect(await service.readThread!('thread:managed')).toMatchObject({id:'thread:managed',modelId:'model-a',reasoningEffort:'high',activeFlags:['waitingOnUserInput'],turns:[{id:'turn:one',clientUserMessageIds:['command:one'],itemsComplete:true,resultText:'{"outcome":"CONTINUE"}'}]});
  expect(server.messages.at(-1)?.params).toEqual({threadId:'thread:managed',includeTurns:true});
});
it('sends explicit structured output with model and effort without collaboration defaults',async()=>{
  const server=await listen(initializedServer(message=>({id:message.id,result:{turn:{id:'turn:one',status:'inProgress'}}})));
  const service=createCodexAppServerSocketControlService({socketPath:server.socketPath});
  await service.startTurn({threadId:'thread:one',prompt:'Work',model:'model-a',reasoningEffort:'high',clientUserMessageId:'command:one',outputSchema:{type:'object'}});
  expect(server.messages.at(-1)?.params).toMatchObject({model:'model-a',effort:'high',outputSchema:{type:'object'}});
  expect(server.messages.at(-1)?.params).not.toHaveProperty('collaborationMode');
});

it('rechecks the send fence after socket initialization before any native mutation',async()=>{
  const server=await listen(initializedServer(message=>({id:message.id,result:{turn:{id:'turn:one',status:'inProgress'}}})));
  const service=createCodexAppServerSocketControlService({socketPath:server.socketPath});
  const beforeSend=async()=>{throw Error('lease expired');};
  await expect(service.startTurn({threadId:'thread:one',prompt:'Work',model:'model-a',reasoningEffort:'high',clientUserMessageId:'command:one',beforeSend})).rejects.toThrow('lease expired');
  await expect(service.updateThreadSettings({threadId:'thread:one',model:'model-a',reasoningEffort:'high',beforeSend})).rejects.toThrow('lease expired');
  expect(server.messages.filter(m=>m.method==='turn/start'||m.method==='thread/settings/update')).toEqual([]);
});
it.each([
 {codexErrorInfo:'rateLimitExceeded',retryAfter:42},
 {codexErrorInfo:'modelUnavailable',retryAfter:42},
 {codexErrorInfo:'other',message:'The model model-a does not exist',retryAfter:42}
])('reads only explicit retryable native failure metadata: %j',async error=>{
 const server=await listen(initializedServer(message=>({id:message.id,result:{thread:{id:'thread',cwd:'/project',model:'a',reasoningEffort:'high',status:{type:'idle'},turns:[{id:'turn',status:'failed',itemsView:'full',items:[],error}]}}})));
 const service=createCodexAppServerSocketControlService({socketPath:server.socketPath});
 expect((await service.readThread!('thread')).turns[0]?.retryableFailure).toEqual({retryAfterMs:42000});
});
it.each(['unauthorized','other','internalServerError'])('does not retry ambiguous native failure %s',async code=>{
 const server=await listen(initializedServer(message=>({id:message.id,result:{thread:{id:'thread',cwd:'/project',model:'a',reasoningEffort:'high',status:{type:'idle'},turns:[{id:'turn',status:'failed',itemsView:'full',items:[],error:{codexErrorInfo:code,message:'private timeout'}}]}}})));
 expect((await createCodexAppServerSocketControlService({socketPath:server.socketPath}).readThread!('thread')).turns[0]?.retryableFailure).toBeUndefined();
});
it('fences interrupt at socket send time',async()=>{
 const server=await listen(initializedServer(message=>({id:message.id,result:{}})));
 await expect(createCodexAppServerSocketControlService({socketPath:server.socketPath}).interruptTurn({threadId:'thread',turnId:'turn',beforeSend:async()=>{throw Error('lost lease');}})).rejects.toThrow('lost lease');
 expect(server.messages.some(m=>m.method==='turn/interrupt')).toBe(false);
});
it('marks a native rejected START retryable without exposing raw runtime errors',async()=>{
 const server=await listen(initializedServer(message=>({id:message.id,error:{code:-32000,message:'private rejected details',data:{codexErrorInfo:'rateLimitExceeded',retryAfter:30}}})));
 await expect(createCodexAppServerSocketControlService({socketPath:server.socketPath}).startManagedTurn!({threadId:'thread',prompt:'Work',model:'model-a',reasoningEffort:'high',clientUserMessageId:'command'})).rejects.toMatchObject({delivery:'REJECTED',retryableFailure:{retryAfterMs:30000},message:'Managed Codex turn was not accepted.'});
});
it('proves a failed pre-send fence never submitted START',async()=>{
 const server=await listen(initializedServer(message=>({id:message.id,result:{}})));
 await expect(createCodexAppServerSocketControlService({socketPath:server.socketPath}).startManagedTurn!({threadId:'thread',prompt:'Work',model:'model-a',reasoningEffort:'high',clientUserMessageId:'command',beforeSend:async()=>{throw Error('authority lost');}})).rejects.toMatchObject({delivery:'NOT_SENT'});
 expect(server.messages.some(m=>m.method==='turn/start')).toBe(false);
});
it('retains sanitized SETTINGS rejection metadata and Retry-After from the native RPC',async()=>{
 const server=await listen(initializedServer(message=>({id:message.id,error:{code:-32000,message:'private runtime details',data:{codexErrorInfo:'rateLimitExceeded',retryAfter:60}}})));
 const service=createCodexAppServerSocketControlService({socketPath:server.socketPath});
 await expect(service.updateThreadSettings({threadId:'thread',model:'model-a',reasoningEffort:'high'})).rejects.toMatchObject({name:'CodexSettingsRejectedError',retryableFailure:{retryAfterMs:60000},message:'Native thread settings were rejected.'});
});

it('retains typed internal command execution evidence without inventing missing exit or output fields', async () => {
  const items = [
    {type:'commandExecution',id:'cmd-ok',command:'/bin/bash -lc \'node -e 1\'',status:'completed',exitCode:0,aggregatedOutput:'OK\n'},
    {type:'commandExecution',id:'cmd-failed',command:'node -e 1',status:'failed',exitCode:2,aggregatedOutput:'error'},
    {type:'commandExecution',id:'cmd-incomplete',command:'node -e 1',status:'inProgress',exitCode:'0',aggregatedOutput:42}
  ];
  const server = await listen(initializedServer(message => ({id:message.id,result:{thread:{id:'thread',cwd:'/project',model:'a',reasoningEffort:'high',status:{type:'idle'},turns:[{id:'turn',status:'completed',itemsView:'full',items}]}}})));
  const service = createCodexAppServerSocketControlService({socketPath:server.socketPath});
  expect((await service.readThread!('thread')).turns[0]?.commandExecutions).toEqual([
    {id:'cmd-ok',command:'/bin/bash -lc \'node -e 1\'',status:'completed',exitCode:0,aggregatedOutput:'OK\n'},
    {id:'cmd-failed',command:'node -e 1',status:'failed',exitCode:2,aggregatedOutput:'error'},
    {id:'cmd-incomplete',command:'node -e 1',status:'inProgress',exitCode:null,aggregatedOutput:null}
  ]);
});

describe('managed native history compatibility', () => {
  const metadata = {id:'thread:fresh',cwd:'/etc',model:'gpt-6-astra',reasoningEffort:'high',status:{type:'idle'},historyMode:'paginated',ephemeral:false,path:null,turns:[]};
  it('hydrates every paginated turn with full items and preserves correlation and command evidence', async () => {
    const server = await listen(initializedServer(message => {
      if (message.method === 'thread/read') return message.params?.includeTurns === false
        ? {id:message.id,result:{thread:metadata}} : {id:message.id,error:{code:-32600,message:'paginated threads do not support thread/read(includeTurns=true)'}};
      if (message.method === 'thread/turns/list') {
        const second = message.params?.cursor === 'page2';
        return {id:message.id,result:{data:[{id:second?'turn:2':'turn:1',status:'completed',itemsView:message.params?.itemsView,items:second?[{type:'userMessage',clientId:'command:2'},{type:'commandExecution',id:'cmd',command:'node proof',status:'completed',exitCode:0,aggregatedOutput:'proof-ok'}]:[]}],nextCursor:second?null:'page2',backwardsCursor:null}};
      }
      return {id:message.id,error:{code:-32601,message:'unsupported'}};
    }));
    const history = await createCodexAppServerSocketControlService({socketPath:server.socketPath}).readThread!('thread:fresh');
    expect(history.turns.map(turn=>turn.id)).toEqual(['turn:1','turn:2']);
    expect(history.turns[1]).toMatchObject({itemsComplete:true,clientUserMessageIds:['command:2'],commandExecutions:[{exitCode:0,aggregatedOutput:'proof-ok'}]});
    expect(server.messages.filter(m=>m.method==='thread/turns/list').map(m=>m.params)).toEqual([
      {threadId:'thread:fresh',limit:100,sortDirection:'asc',itemsView:'full'},
      {threadId:'thread:fresh',limit:100,sortDirection:'asc',itemsView:'full',cursor:'page2'}
    ]);
  });
  it.each(['paginated','legacy'])('accepts only a native-confirmed unmaterialized idle %s thread', async historyMode => {
    const server = await listen(initializedServer(message => message.method === 'thread/read' && message.params?.includeTurns === false
      ? {id:message.id,result:{thread:{...metadata,historyMode}}}
      : {id:message.id,error:{code:-32600,message:`thread thread:fresh is not materialized yet; ${historyMode==='paginated'?'thread/turns/list':'includeTurns'} is unavailable before first user message`}}));
    await expect(createCodexAppServerSocketControlService({socketPath:server.socketPath}).readThread!('thread:fresh')).resolves.toMatchObject({id:'thread:fresh',status:'idle',turns:[]});
  });
  it.each(['unknown-error','active','ephemeral','wrong-thread','cycle','missing-cursor','partial-items','duplicate','unknown-mode'])('fails closed for %s history', async scenario => {
    const server=await listen(initializedServer(message=>{
      if(message.method==='thread/read' && message.params?.includeTurns===false) return {id:message.id,result:{thread:{...metadata,
        ...(scenario==='active'?{status:{type:'active'}}:{}),...(scenario==='ephemeral'?{ephemeral:true}:{}),...(scenario==='unknown-mode'?{historyMode:'future'}:{})}}};
      if(['unknown-error','active','ephemeral','wrong-thread'].includes(scenario)) return {id:message.id,error:{code:-32600,message:scenario==='unknown-error'?'private unavailable history':`thread ${scenario==='wrong-thread'?'thread:other':'thread:fresh'} is not materialized yet; thread/turns/list is unavailable before first user message`}};
      return {id:message.id,result:{data:[{id:'turn:1',status:'completed',itemsView:scenario==='partial-items'?'summary':'full',items:[]}],...(scenario==='missing-cursor'?{}:{nextCursor:['cycle','duplicate'].includes(scenario)?'again':null})}};
    }));
    await expect(createCodexAppServerSocketControlService({socketPath:server.socketPath}).readThread!('thread:fresh')).rejects.toThrow();
    expect(server.messages.some(m=>m.method==='turn/start')).toBe(false);
  });
});


describe('Codex 0.162 pre-first-turn history', () => {
  it.each(['empty', 'has-turn', 'wrong-id', 'outside-root', 'partial', 'active', 'unknown-error'])('validates the owned native rollout for %s', async scenario => {
    const home = await mkdtemp(join(tmpdir(), 'history-'));
    cleanups.push(() => rm(home, {recursive:true,force:true}));
    await mkdir(join(home,'sessions'));
    const path = join(home, scenario === 'outside-root' ? 'rollout.jsonl' : 'sessions/rollout.jsonl');
    const record = {type:'session_meta',payload:{id:scenario==='wrong-id'?'other':'fresh',cwd:'/etc',history_mode:'paginated'}};
    await writeFile(path, JSON.stringify(record)+(scenario==='partial'?'':'\n')+(scenario==='has-turn'?JSON.stringify({type:'event_msg',payload:{type:'task_started',turn_id:'turn'}})+'\n':''));
    const server = await listen(initializedServer(message => message.method === 'thread/read' && message.params?.includeTurns===false
      ? {id:message.id,result:{thread:{id:'fresh',cwd:'/etc',model:'a',reasoningEffort:'high',status:{type:scenario==='active'?'active':'idle'},historyMode:'paginated',ephemeral:false,path,preview:'',turns:[]}}}
      : {id:message.id,error:{code:-32601,message:scenario==='unknown-error'?'unexpected unavailable history':'list_turns is not supported yet'}}));
    const read=createCodexAppServerSocketControlService({socketPath:server.socketPath,rolloutRoot:home}).readThread!('fresh');
    if(scenario==='empty') await expect(read).resolves.toMatchObject({id:'fresh',status:'idle',turns:[]});
    else await expect(read).rejects.toThrow();
  });
});
