import { mkdtemp, mkdir, chmod, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { InMemorySpaceStore } from '@space/runtime';
import type { CodexNativeThread } from '@space/codex-app-server';
import type { CliHostClient } from '@space/cli-host';
import type { SystemAnalyticsService } from '../src/system-analytics-service.js';
import { createApp } from '../src/app.js';
import { getApiConfig } from '../src/config.js';
// Real managed controller, scheduler, authentication and authority; native I/O and unrelated host analytics are isolated.
describe('managed plan application wiring', () => {
    it.each(['persisted', 'fresh'] as const)('starts a %s thread, continues on the server and rechecks admin authority', async (binding) => {
        const root = await mkdtemp(join(tmpdir(), 'plan-api-'));
        await writeFile(join(root, 'codex-vscode-parity'), '#!/bin/sh\nexit 0\n');
        await chmod(join(root, 'codex-vscode-parity'), 0o755);
        await mkdir(join(root, 'workspaces'));
        const store = new InMemorySpaceStore();
        const room = store.createRoom({ name: 'Managed integration', initialPaneCount: 0 });
        const pane = store.createPane({ roomId: room.id, title: 'Codex', mode: 'TERMINAL', cwd: '/etc', terminalRuntimeId: 'cli:codex' });
        const threadId = '22222222-2222-4222-8222-222222222222';
        const session = store.createPaneCliSession({ sessionId: 'cli_session:managed-test', paneId: pane.id, roomId: room.id, runtimeId: 'cli:codex', providerId: 'openai', agentId: 'codex', modelId: 'model-a', reasoningEffort: 'high', cwd: '/etc', codexThreadId: binding === 'persisted' ? threadId : null, status: 'RUNNING', isActive: true });
        const thread: CodexNativeThread = { id: threadId, cwd: '/etc', modelId: 'model-a', reasoningEffort: 'high', status: 'idle', activeFlags: [], turns: [] };
        let writerThreads = [threadId];
        let sent = 0;
        let settingsWrites = 0;
        const app = await createApp({ store, config: getApiConfig({ SPACE_CLI_ENABLED: 'true', SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_WORKSPACE_ROOT: join(root, 'workspaces'), SPACE_CLI_CODEX_CREDENTIAL_SMOKE: 'true' }),
            auth: { sessionSecret: 'test-secret-with-enough-length', devLogin: true, secureCookies: false }, codexAgentControl: null,
            findCodexThreadId: async () => null,
            findCodexModelControlThreads: async () => writerThreads,
            // Synthetic thread IDs must not trigger real host telemetry/history scans.
            systemAnalyticsService: ({
                sample: async () => {},
                rollupAndSweep: async () => {},
                backfill: async () => {},
                dispose: async () => {}
            } satisfies Pick<SystemAnalyticsService, 'sample' | 'rollupAndSweep' | 'backfill' | 'dispose'>) as SystemAnalyticsService,
            cliHostClient: { input: async () => { throw Error('no terminal input'); }, health: async () => ({ ok: true, sessions: [] }), inspect: async () => null, close: async () => { } } as unknown as CliHostClient,
            codexSocketControlFactory: () => ({
                listModels: async () => [{ id: 'model-a', displayName: 'A', isDefault: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: ['high'] }],
                readThread: async () => structuredClone(thread), readThreadSettings: async () => ({ ...thread, isTurnActive: thread.status === 'active' }),
                updateThreadSettings: async (input) => { await input.beforeSend?.(); settingsWrites++; thread.modelId = input.model; thread.reasoningEffort = input.reasoningEffort; },
                interruptTurn: async () => { throw Error('no interrupt'); },
                startTurn: async () => { throw Error("Unobserved start is forbidden"); },
                startManagedTurn: async (input) => { await input.beforeSend?.(); sent++; thread.status = 'active'; thread.turns.push({ id: `turn:${sent}`, status: 'inProgress', itemsComplete: true, clientUserMessageIds: [input.clientUserMessageId], resultText: null }); return { turnId: `turn:${sent}`, status: 'inProgress', observation:{read:()=>({status:'OBSERVING',selection:null}),close:()=>{}} }; }
            })
        });
        try {
            const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'space@space.local', password: 'space-dev' } });
            const cookie = `space_session=${login.cookies[0]!.value}`;
            const csrf = (await app.inject({ url: '/api/auth/csrf', headers: { cookie } })).json().csrfToken;
            const headers = { cookie, 'x-space-csrf-token': csrf };
            // Use the authenticated clipboard route so the owner identity is not assumed.
            const planResponse = await app.inject({ method: 'POST', url: '/api/clipboard-items', headers, payload: { source: 'PLAN', minimumModel: 'model-a', text: 'Managed API plan', steps: [{ id: 'first', order: 1, title: 'First', modelId: 'model-a', reasoningEffort: 'high', instructions: 'Do work', completionCriteria: ['Tests pass'] }, { id: 'second', order: 2, title: 'Second', modelId: 'model-a', reasoningEffort: 'high', instructions: 'Next work', completionCriteria: ['Tests pass'] }] } });
            expect(planResponse.statusCode).toBe(201);
            if (binding === 'fresh') {
                const start = () => app.inject({ method: 'POST', url: `/api/panes/${pane.id}/plan-executions`, headers, payload: { planId: planResponse.json().id, expectedSessionId: session.sessionId, requestId: 'managed-api-request' } });
                writerThreads = [threadId, '33333333-3333-4333-8333-333333333333'];
                expect((await start()).statusCode).toBe(409);
                writerThreads = [threadId];
                thread.cwd = '/foreign';
                expect((await start()).statusCode).toBe(409);
                expect((await store.getPaneCliSession(session.sessionId))?.codexThreadId).toBeNull();
                expect(sent).toBe(0);
                thread.cwd = '/etc';
            }
            const response = await app.inject({ method: 'POST', url: `/api/panes/${pane.id}/plan-executions`, headers, payload: { planId: planResponse.json().id, expectedSessionId: session.sessionId, requestId: 'managed-api-request' } });
            expect(response.statusCode, response.body).toBe(201);
            expect((await store.getPaneCliSession(session.sessionId))?.codexThreadId).toBe(threadId);
            const execution = response.json();
            await vi.waitFor(() => expect(sent).toBe(1), { timeout: 8000, interval: 50 });
            expect(settingsWrites).toBe(1);
            const actor = await store.getControlActor(execution.ownerUserId);
            expect(actor?.role).toBe('ADMIN');
            await store.updateUserRole(actor!.id, 'USER');
            await vi.waitFor(async () => expect((await store.planExecutions.get(execution.ownerUserId, execution.id))?.status).toBe('BLOCKED'), { timeout: 8000, interval: 50 });
            expect(sent).toBe(1);
            expect((await store.listEvents(room.id)).some(event => event.type === 'PLAN_EXECUTION_UPDATED')).toBe(true);
            expect((await store.getPaneCliSession(session.sessionId))?.isActive).toBe(true);
        }
        finally {
            await app.close();
            await rm(root, { recursive: true, force: true });
        }
    }, 60000);
});
