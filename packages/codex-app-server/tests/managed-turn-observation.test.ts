import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { createCodexAppServerSocketControlService } from '../src/index.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0))
    await cleanup(); });
async function fixture(options: {
    duplicateInitialize?: boolean;
    reroute?: boolean;
    changeRestore?: boolean;
    drop?: boolean;
    noStarted?: boolean;
    completeBeforeAck?: boolean;
    foreignStarted?: boolean;
} = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'managed-'));
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const messages: any[] = [];
    let connection: WebSocket;
    wss.on('connection', socket => {
        connection = socket;
        socket.on('message', raw => {
            const m = JSON.parse(raw.toString());
            messages.push(m);
            if (m.method === 'initialize') {
                socket.send(JSON.stringify({ id: m.id, result: { userAgent: 'fixture' } }));
                if (options.duplicateInitialize) socket.send(JSON.stringify({ id: m.id, result: { userAgent: 'fixture' } }));
            }
            if (m.method === 'turn/start') {
                if (!options.noStarted)
                    socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn', status: 'inProgress' } } }));
                if (options.completeBeforeAck)
                    socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } }));
                socket.send(JSON.stringify({ id: m.id, result: { turn: { id: 'turn', status: 'inProgress' } } }));
            }
        });
    });
    await new Promise<void>(resolve => server.listen(join(dir, 'control.sock'), resolve));
    cleanups.push(async () => { for (const socket of wss.clients)
        socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
    const service = createCodexAppServerSocketControlService({ socketPath: join(dir, 'control.sock'), timeoutMs: 500 });
    const handle = await service.startManagedTurn!({ threadId: 'thread', prompt: 'Work', model: 'model-a', reasoningEffort: 'high', clientUserMessageId: 'command', outputSchema: { type: 'object' } });
    const notify = (method: string, params: unknown) => connection!.send(JSON.stringify({ method, params }));
    const finish = async () => {
        if (options.foreignStarted)
            notify('turn/started', { threadId: 'thread', turn: { id: 'foreign', status: 'inProgress' } });
        if (options.reroute)
            notify('model/rerouted', { threadId: 'thread', turnId: 'turn', fromModel: 'model-a', toModel: 'model-b', reason: 'other' });
        if (options.changeRestore) {
            for (const model of ['model-b', 'model-a'])
                notify('thread/settings/updated', { threadId: 'thread', threadSettings: { model, effort: 'high' } });
        }
        if (options.drop)
            connection!.terminate();
        else
            notify('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
        await new Promise(resolve => setTimeout(resolve, 25));
    };
    return { handle, finish, messages, request: (method: string) => connection!.send(JSON.stringify({id:88,method,params:{threadId:'thread',turnId:'turn'}})) };
}
it('binds explicit configuration to the accepted turn across an uninterrupted native observation', async () => {
    const f = await fixture();
    expect(f.handle.observation.read().status).toBe('OBSERVING');
    await f.finish();
    expect(f.handle.observation.read()).toMatchObject({ status: 'VERIFIED', selection: { source: 'NATIVE_ACCEPTED_TURN_CONFIGURATION', threadId: 'thread', turnId: 'turn', commandId: 'command', modelId: 'model-a', reasoningEffort: 'high', providerTelemetry: false } });
    expect(f.messages.find(m => m.method === 'turn/start').params).toMatchObject({ model: 'model-a', effort: 'high', clientUserMessageId: 'command', outputSchema: { type: 'object' } });
    expect(f.messages.some(m => m.method === 'thread/resume' || m.method === 'thread/start')).toBe(false);
});
it.each([{ reroute: true }, { changeRestore: true }, { drop: true }, { noStarted: true }, { foreignStarted: true }])('invalidates ambiguous evidence: %j', async (options) => {
    const f = await fixture(options);
    await f.finish();
    expect(f.handle.observation.read().status).toBe('INVALID');
    expect(f.handle.observation.read().selection).toBeNull();
});
it('retains matching completion that arrives before the start response', async () => {
    const f = await fixture({ completeBeforeAck: true });
    expect(f.handle.observation.read()).toMatchObject({ status: 'VERIFIED', selection: { turnId: 'turn', commandId: 'command' } });
});
it('never sends after its handshake deadline while an asynchronous fence is pending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'managed-'));
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const methods: string[] = [];
    wss.on('connection', socket => socket.on('message', raw => { const m = JSON.parse(raw.toString()); methods.push(m.method); if (m.method === 'initialize')
        socket.send(JSON.stringify({ id: m.id, result: {} })); }));
    await new Promise<void>(resolve => server.listen(join(dir, 'control.sock'), resolve));
    cleanups.push(async () => { for (const socket of wss.clients)
        socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
    const service = createCodexAppServerSocketControlService({ socketPath: join(dir, 'control.sock'), timeoutMs: 30 });
    let release!: () => void;
    const fence = new Promise<void>(resolve => { release = resolve; });
    await expect(service.startManagedTurn!({ threadId: 'thread', prompt: 'Work', model: 'model-a', reasoningEffort: 'high', clientUserMessageId: 'command', beforeSend: () => fence })).rejects.toThrow();
    release();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(methods).not.toContain('turn/start');
});

it('rejects duplicate initialization instead of sending START twice', async () => {
    await expect(fixture({duplicateInitialize:true})).rejects.toThrow();
});

it.each(['item/commandExecution/requestApproval','item/tool/requestUserInput'])('retains observation through %s without answering for the TUI',async method=>{
 const f=await fixture();f.request(method);await new Promise(r=>setTimeout(r,25));expect(f.handle.observation.read().status).toBe('OBSERVING');await f.finish();expect(f.handle.observation.read().status).toBe('VERIFIED');expect(f.messages.some(m=>m.id===88)).toBe(false);
});
