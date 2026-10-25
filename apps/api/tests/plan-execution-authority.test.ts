import { mkdtemp, mkdir, chmod, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { InMemorySpaceStore } from '@space/runtime';
import type { CodexNativeThread } from '@space/codex-app-server';
import type { CliHostClient } from '@space/cli-host';
import type { SystemAnalyticsService } from '../src/system-analytics-service.js';
import { createApp } from '../src/app.ts';
import { getApiConfig } from '../src/config.ts';
import { signSession, createCsrfToken } from '../src/auth.ts';
// Real managed controller, scheduler, authentication and authority; native I/O and unrelated host analytics are isolated.
describe('managed plan application wiring', () => {
    it('rejects signed READ_ONLY and automation while full ADMIN requires matching terminal authority', async () => {
        const root = await mkdtemp(join(tmpdir(), 'plan-api-'));
        await writeFile(join(root, 'codex-vscode-parity'), '#!/bin/sh\nexit 0\n');
        await chmod(join(root, 'codex-vscode-parity'), 0o755);
        await mkdir(join(root, 'workspaces'));
        const store = new InMemorySpaceStore();
        const room = store.createRoom({ name: 'Managed integration', initialPaneCount: 0 });
        const pane = store.createPane({ roomId: room.id, title: 'Codex', mode: 'TERMINAL', cwd: '/etc', terminalRuntimeId: 'cli:codex' });
        const session = store.createPaneCliSession({ sessionId: 'cli_session:managed-test', paneId: pane.id, roomId: room.id, runtimeId: 'cli:codex', providerId: 'openai', agentId: 'codex', modelId: 'model-a', reasoningEffort: 'high', cwd: '/etc', codexThreadId: '22222222-2222-4222-8222-222222222222', status: 'RUNNING', isActive: true });
        const thread: CodexNativeThread = { id: session.codexThreadId!, cwd: '/etc', modelId: 'old-model', reasoningEffort: 'high', status: 'idle', activeFlags: [], turns: [] };
        let sent = 0;
        let settingsWrites = 0;
        const app = await createApp({ store, config: getApiConfig({ SPACE_CLI_ENABLED: 'true', SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_WORKSPACE_ROOT: join(root, 'workspaces'), SPACE_CLI_CODEX_CREDENTIAL_SMOKE: 'true' }),
            auth: { sessionSecret: 'test-secret-with-enough-length', devLogin: true, secureCookies: false }, codexAgentControl: null,
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
            const user={id:'user:operator',email:'review@example.test',role:'ADMIN' as const};
            await store.upsertUser(user);
            const headersFor=(scope:object={})=>{
              const token=signSession({...user,...scope},'test-secret-with-enough-length');
              return {cookie:`space_session=${token}`,'x-space-csrf-token':createCsrfToken(token,'test-secret-with-enough-length')!};
            };
            const plan=store.upsertClipboardItem({ownerUserId:user.id,source:'PLAN',minimumModel:'model-a',text:'review plan',steps:[{id:'one',order:1,title:'Work',modelId:'model-a',reasoningEffort:'high',instructions:'Do work',completionCriteria:['Tests pass']}]});
            const payload={planId:plan.id,expectedSessionId:session.sessionId,requestId:'read-only'};
            const automation=await app.inject({method:'POST',url:`/api/panes/${pane.id}/plan-executions`,headers:headersFor({automationScope:'APP_DIAGNOSTICS'}),payload});
            expect(automation.statusCode).toBe(403);
            const readOnly=await app.inject({method:'POST',url:`/api/panes/${pane.id}/plan-executions`,headers:headersFor({proofScope:'READ_ONLY'}),payload});
            expect(readOnly.statusCode).toBe(403);
            expect(await store.planExecutions.listActive()).toEqual([]);
            expect(sent).toBe(0);
            const lease=store.createPaneCliTerminalControlLease({sessionId:session.sessionId,paneId:pane.id,roomId:room.id,userId:user.id,
             browserClientId:'11111111-1111-4111-8111-111111111111',tabLineageId:'22222222-2222-4222-8222-222222222222',pageClientId:'33333333-3333-4333-8333-333333333333',expectedActiveLeaseId:null});
            const controlHeaders={...headersFor(),'x-space-cli-control-lease-id':lease.leaseId,'x-space-cli-browser-client-id':lease.browserClientId,'x-space-cli-tab-lineage-id':lease.tabLineageId,'x-space-cli-page-client-id':lease.pageClientId};
            const denied=await app.inject({method:'POST',url:`/api/panes/${pane.id}/plan-executions`,headers:headersFor(),payload:{...payload,requestId:'full'}});
            expect(denied.statusCode).toBeGreaterThanOrEqual(400);
            const full=await app.inject({method:'POST',url:`/api/panes/${pane.id}/plan-executions`,headers:controlHeaders,payload:{...payload,requestId:'full'}});
            expect(full.statusCode).toBe(201);
            // Isolated fixture completes the previous turn before the server advances the new authorized execution.
            thread.status='idle';
            await vi.waitFor(()=>expect(sent).toBe(1),{timeout:8000});
            expect(settingsWrites).toBe(1);
            const id=full.json().id;
            for(const scope of [{proofScope:'READ_ONLY'},{automationScope:'APP_DIAGNOSTICS'}]) {
              for(const operation of [
                {method:'PATCH' as const,url:`/api/plan-executions/${id}/stages/one/override`,payload:{selection:null,revision:0}},
                {method:'POST' as const,url:`/api/plan-executions/${id}/control`,payload:{action:'pause',revision:0}},
                {method:'PATCH' as const,url:`/api/panes/${pane.id}/cli/model-settings`,payload:{modelId:'model-a',reasoningEffort:'high',expectedSessionId:session.sessionId}}
              ]) expect((await app.inject({...operation,headers:{...controlHeaders,...headersFor(scope)}})).statusCode).toBe(403);
            }
            const bypass=await app.inject({method:'PATCH',url:`/api/panes/${pane.id}/cli/model-settings`,headers:controlHeaders,payload:{modelId:'model-a',reasoningEffort:'high',expectedSessionId:session.sessionId}});
            expect(bypass.statusCode).toBe(409);expect(bypass.body).toMatch(/managed|override/i);expect(settingsWrites).toBe(1);
            const current=(await store.planExecutions.get(user.id,id))!;
            const noControl=await app.inject({method:'POST',url:`/api/plan-executions/${id}/control`,headers:headersFor(),payload:{action:'pause',revision:current.revision}});
            expect(noControl.statusCode).toBeGreaterThanOrEqual(400);
            const pause=await app.inject({method:'POST',url:`/api/plan-executions/${id}/control`,headers:controlHeaders,payload:{action:'pause',revision:current.revision}});
            expect(pause.statusCode).toBe(200);expect(pause.json().interruptReason).toBe('PAUSE');
        } finally {await app.close();await rm(root,{recursive:true,force:true});}
    },60000);
});
