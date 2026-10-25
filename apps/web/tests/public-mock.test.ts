import { describe, expect, it } from 'vitest';
import { DemoStore } from '../src/demo/DemoStore.js';
import { createCurrentMockFixture } from '../src/demo/mock-fixture.js';
import { createDemoRuntime } from '../src/demo/demo-runtime.js';
import { sharedChatMessageListResponseSchema, vncPresetListResponseSchema, fileListResponseSchema, agentSessionHistoryResponseSchema } from '@space/contracts';
const store = () => new DemoStore(createCurrentMockFixture());

describe('current public Space mock', () => {
 it('starts with the operator screenshot layouts and an empty Operations room', async () => {
  const s=store();const rooms=(await s.api.rooms()).data;
  expect(rooms.map(r=>r.name)).toEqual(['Room 1','Research Lab','Operations','Copilots (coming next)']);
  for(const r of rooms)expect(r).toMatchObject({paneLayoutColumns:2,paneLayoutHeight:1});
  const first=(await s.api.panes(rooms[0]!.id)).data.sort((a,b)=>a.order-b.order);
  expect(first.map(p=>p.terminalRuntimeId)).toEqual(['cli:codex','cli:opencode','cli:gemini','cli:claude']);
  const research=(await s.api.panes(rooms[1]!.id)).data.sort((a,b)=>a.order-b.order);
  expect(research.map(p=>p.mode)).toEqual(['CHAT','YOUTUBE','BROWSER','FILES']);
  expect((await s.api.panes(rooms[2]!.id)).data).toEqual([]);
  const brief=await s.api.agentSession('pane:demo-research-chat');
  expect(brief.messages.map(m=>m.role)).toEqual(['user','assistant']);
  expect(brief.messages[0]!.content).toBe('Review the public launch workspace.');
 });
 it('matches each CLI ready message to the canonical pane session identity', async () => {
  const { runtime } = createDemoRuntime({ fixture: createCurrentMockFixture() });
  for (const pane of (await runtime.api.panes((await runtime.api.rooms()).data[0]!.id)).data.filter(p=>p.mode==='TERMINAL')) {
   const session = await runtime.api.activeCliSession(pane.id);
   if (!session) throw new Error('Expected an active local CLI session');
   const socket = runtime.terminal.connect(runtime.api.cliTerminalWebSocketUrl(session.websocket!));
   const ready = await new Promise<any>(resolve=>socket.addEventListener('message', e=>{ const data=JSON.parse(e.data); if(data.type==='ready')resolve(data) }));
   expect(ready).toMatchObject({ paneId:pane.id, sessionId:session.session.sessionId, runtimeId:session.session.runtimeId });
   socket.close();
  }
 });
 it('edits and renames a virtual file directory without leaving stale descendants', async()=>{
  const s=store(); await s.api.filesCreate({path:'/opt/spaceapp/example',type:'directory'});
  await s.api.filesWrite({path:'/opt/spaceapp/example/a.md',content:'saved text'});
  await s.api.filesRename({oldPath:'/opt/spaceapp/example',newPath:'/opt/spaceapp/renamed'});
  expect((await s.api.filesRead({path:'/opt/spaceapp/renamed/a.md'})).content).toBe('saved text');
  await expect(s.api.filesRead({path:'/opt/spaceapp/example/a.md'})).rejects.toMatchObject({code:'NOT_FOUND'});
  expect(fileListResponseSchema.safeParse(await s.api.filesList({path:'/opt/spaceapp'})).success).toBe(true);
  await expect(s.api.filesRead({path:'/opt/spaceapp/../secrets'})).rejects.toMatchObject({code:'INVALID_PATH'});
 });
 it('persists room and file changes and resets to the operator fixture',async()=>{
  const s=store(); const room=await s.api.createRoom('Proof room',0);
  await s.api.filesWrite({path:'/opt/spaceapp/saved.md',content:'durable'});
  const restored=store();restored.restoreSnapshot(s.snapshot());
  expect((await restored.api.rooms()).data.some(r=>r.id===room.id)).toBe(true);
  expect((await restored.api.filesRead({path:'/opt/spaceapp/saved.md'})).content).toBe('durable');
  restored.reset();expect((await restored.api.me()).user?.role).toBe('OPERATOR');
  await expect(restored.api.filesRead({path:'/opt/spaceapp/saved.md'})).rejects.toMatchObject({code:'NOT_FOUND'});
 });
 it('rejects corrupted workspace snapshots without crashing the current workspace',async()=>{
  const s=store(); s.restoreSnapshot('{"version":1,"rooms":[{"id":"room:bad","name":"bad","paneCap":16}],"panes":[],"settings":{"uiTheme":{}}}');
  expect((await s.api.rooms()).data[0]?.name).toBe('Room 1');
  s.restoreSnapshot('{}');s.restoreSnapshot('null');expect((await s.api.me()).user?.role).toBe('OPERATOR');
 });
 it('stores shared chat and returns contract-valid history',async()=>{
  const s=store();await s.api.sendSharedChatMessage({content:'Hello mock',kind:'message',metadata:{}});
  const response=await s.api.sharedChatMessages();expect(response.data).toHaveLength(2);
  expect(sharedChatMessageListResponseSchema.safeParse(response).success).toBe(true);
  expect(agentSessionHistoryResponseSchema.safeParse(await s.api.agentSessions()).success).toBe(true);
 });
 it('creates, activates and closes browser tabs and exports saved bookmarks',async()=>{
  const s=store(),pane='pane:demo-browser';const initial=await s.api.browserPages(pane);
  const next=await s.api.createBrowserPage(pane,{url:'https://example.test/',activate:true});expect(next.pages.length).toBe(initial.pages.length+1);
  await s.api.addBrowserBookmark(pane,{title:'Example',url:'https://example.test/'});
  expect(typeof s.api.browserBookmarksExportUrl(pane)).toBe('string');
  const closed=await s.api.closeBrowserPage(pane,next.activePageId!);expect(closed.pages.length).toBe(initial.pages.length);
 });
 it('fences cleared Live history and rejects another owner',async()=>{
  const s=store(),roomId=(await s.api.rooms()).data[0]!.id;
  const item={id:'live:test',role:'user' as const,text:'hello',timestamp:new Date().toISOString(),sessionId:'session:test',roomId,createdAtMs:Date.now(),revision:1};
  expect((await s.api.saveLiveHistory([{item,epoch:0}],'user:demo-user')).receipts[0]?.accepted).toBe(true);
  await s.api.clearVoiceRealtimeLogs(roomId);
  expect((await s.api.saveLiveHistory([{item,epoch:0}],'user:demo-user')).receipts[0]?.accepted).toBe(false);
  expect((await s.api.getLiveHistory()).items).toHaveLength(0);
  expect((await s.api.saveLiveHistory([{item,epoch:1}],'user:other')).receipts[0]?.accepted).toBe(false);
 });
 it('actually deletes public mock links, clipboard records and tasks',async()=>{
  const s=store(),link=(await s.api.links()).data[0]!;
  await s.api.deleteLink(link.id);expect((await s.api.links()).data.some(l=>l.id===link.id)).toBe(false);
  await s.api.clearClipboardItems();expect((await s.api.clipboardItems()).data).toHaveLength(0);
  await s.api.clearTaskItems();expect((await s.api.taskItems()).data).toHaveLength(0);
  expect(vncPresetListResponseSchema.safeParse(await s.api.vncPresets()).success).toBe(true);
 });
});
