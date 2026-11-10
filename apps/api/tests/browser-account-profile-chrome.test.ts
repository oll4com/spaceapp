import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { accessSync, constants, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemorySpaceStore } from '@space/runtime';
import { createBrowserSessionManager, googleBrowserProfilePathFor } from '../src/browser-sessions.js';
import { getApiConfig } from '../src/config.js';

// All data belongs to a disposable fixture; this is storage evidence, not Google authentication.
// Real Chrome and Xvfb at the paths the Browser Host uses; a machine without them skips these, as browser-chrome-crash does.
const missingBrowser = ['/usr/bin/google-chrome', '/usr/bin/Xvfb'].find((binary) => { try { accessSync(binary, constants.X_OK); return false; } catch { return true; } });
if (missingBrowser) process.stderr.write(`[real Chrome] skipped: ${missingBrowser} is not executable\n`);

describe.skipIf(missingBrowser)('full profile persistence in real Chrome', () => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/write') res.setHeader('Set-Cookie', 'fixture=retained; Path=/; Max-Age=3600; SameSite=Lax');
    res.end(`<html><body><script>
    (async()=>{
      const db=await new Promise((ok,no)=>{const r=indexedDB.open('profile-fixture',1);r.onupgradeneeded=()=>r.result.createObjectStore('data');r.onsuccess=()=>ok(r.result);r.onerror=no});
      if(location.pathname==='/write'){
        localStorage.setItem('fixture','retained');
        await new Promise((ok,no)=>{const t=db.transaction('data','readwrite');t.objectStore('data').put('retained','fixture');t.oncomplete=ok;t.onerror=no});
      }
      const value=await new Promise(ok=>{const r=db.transaction('data').objectStore('data').get('fixture');r.onsuccess=()=>ok(r.result)});
      document.body.textContent=JSON.stringify({local:localStorage.getItem('fixture'),idb:value??null,cookie:document.cookie.includes('fixture=retained')});
      const b=document.createElement('button');b.textContent='Popup';b.id='popup';b.style='position:fixed;top:10px;left:10px;width:100px;height:40px';b.onclick=()=>window.open('/popup','_blank');document.body.append(b);
    })();</script></body></html>`);
  });
  let root: string; let temp: string; let origin: string;
  let manager: ReturnType<typeof createBrowserSessionManager>;
  const store = new InMemorySpaceStore();
  const user = store.upsertUser({ id: 'user:chrome-fixture', email: 'fixture@example.test', role: 'ADMIN' });
  const account = store.linkGoogleAccount(user.id, { sub: 'fixture-a', email: user.email });
  const second = store.linkGoogleAccount(user.id, { sub: 'fixture-b', email: 'b@example.test' });
  const room = store.createRoom({ name: 'Isolated Chrome storage', initialPaneCount: 0 }, 'trace', user.id);
  const panes = Array.from({ length: 3 }, (_, i) => store.createPane({ roomId: room.id, title: `Fixture ${i}`, mode: 'BROWSER' }));
  const config = () => getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: 'true', SPACE_BROWSER_SESSIONS_PROFILE_ROOT: root, SPACE_ARTIFACT_ROOT: root, SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN: origin, SPACE_BROWSER_SESSIONS_AUDIO_ENABLED: 'false', SPACE_BROWSER_SESSIONS_XVFB_ENABLED: 'true' });
  const start = (index: number, path: string, accountId = account.id) => manager.startOrRestore({ pane: panes[index]!, googleAccount: { ownerUserId: user.id, accountId }, targetUrl: origin + path, includeInitialFrame: false, traceId: 'trace' });
  async function text(index: number) { return (await manager.action(panes[index]!, { type: 'extract_text' }, 'trace')).text; }
  beforeAll(async () => { temp = await mkdtemp(join(tmpdir(), 't-')); vi.stubEnv('TMPDIR', temp); root = await mkdtemp(join(tmpdir(), 'chrome-test-')); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`; manager = createBrowserSessionManager({ store, config: config() }); }, 30000);
  afterAll(async () => { await manager?.closeAll(); await new Promise<void>(r=>server.close(()=>r())); if(root) await rm(root,{ recursive:true,force:true }); if(temp) await rm(temp,{ recursive:true,force:true }); vi.unstubAllEnvs(); },30000);
  it('shares cookies, localStorage and IndexedDB; isolates accounts, popups and survives a host restart', async () => {
    await start(0,'/write');
    await expect.poll(()=>text(0)).toContain('"idb":"retained"');
    await start(1,'/read');
    await expect.poll(()=>text(1)).toContain('"cookie":true');
    const a=await manager.listPages!(panes[0]!); const b=await manager.listPages!(panes[1]!);
    expect(a.pages).toHaveLength(1); expect(b.pages).toHaveLength(1);
    await manager.action(panes[0]!, { type: 'click', x: 40, y: 25 }, 'trace');
    await expect.poll(async ()=>(await manager.listPages!(panes[0]!)).pages.length).toBe(2);
    expect((await manager.listPages!(panes[1]!)).pages).toHaveLength(1);
    await start(2,'/read',second.id);
    await expect.poll(()=>text(2)).toContain('"cookie":false');
    expect(await text(2)).toContain('"local":null');
    await manager.stopPane(panes[0]!.id);
    expect(await text(1)).toContain('"idb":"retained"');
    await manager.closeAll();
    manager=createBrowserSessionManager({store,config:config()});
    await manager.getActive(panes[1]!);
    await expect.poll(()=>text(1)).toContain('"local":"retained"');
    expect(await text(1)).toContain('"idb":"retained"');
    expect(await text(1)).toContain('"cookie":true');
  },60000);
});

// Same file as the profile test: real-Chrome tests share one process, so their Xvfb displays never collide.
// A tab of a pane in another Google account lives in that account's Chrome, beside the pane's own tabs.
describe.skipIf(missingBrowser)('tabs in another Google account inside one pane, in real Chrome', () => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/write') res.setHeader('Set-Cookie', 'fixture=retained; Path=/; Max-Age=3600; SameSite=Lax');
    res.end(`<html><body><script>
      document.body.textContent=JSON.stringify({path:location.pathname,cookie:document.cookie.includes('fixture=retained')});
      const b=document.createElement('button');b.textContent='Popup';b.style='position:fixed;top:10px;left:10px;width:100px;height:40px';b.onclick=()=>window.open('/popup','_blank');document.body.append(b);
    </script></body></html>`);
  });
  let root: string; let temp: string; let origin: string;
  let manager: ReturnType<typeof createBrowserSessionManager>;
  const store = new InMemorySpaceStore();
  const user = store.upsertUser({ id: 'user:tab-accounts', email: 'a@example.test', role: 'ADMIN' });
  const first = store.linkGoogleAccount(user.id, { sub: 'tab-a', email: user.email });
  const second = store.linkGoogleAccount(user.id, { sub: 'tab-b', email: 'b@example.test' });
  const room = store.createRoom({ name: 'Tab accounts', initialPaneCount: 0 }, 'trace', user.id);
  const pane = store.createPane({ roomId: room.id, title: 'Andy', mode: 'MARKETING_COPILOT' });
  const freelance = store.createPane({ roomId: room.id, title: 'Freelance', mode: 'FREELANCE_COPILOT' });
  const config = () => getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: 'true', SPACE_BROWSER_SESSIONS_PROFILE_ROOT: root, SPACE_ARTIFACT_ROOT: root, SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN: origin, SPACE_BROWSER_SESSIONS_AUDIO_ENABLED: 'false', SPACE_BROWSER_SESSIONS_XVFB_ENABLED: 'true' });
  const inSecond = { googleAccount: { ownerUserId: user.id, accountId: second.id } };
  const toSecond = (pageId: string) => manager.startOrRestore({ pane, ...inSecond, accountTab: { pageId, profileId: second.id, label: 'b@example.test' }, traceId: 'trace' });
  const text = async () => (await manager.action(pane, { type: 'extract_text' }, 'trace')).text ?? '';
  const pages = () => manager.listPages!(pane);
  beforeAll(async () => { temp = await mkdtemp(join(tmpdir(), 't-')); vi.stubEnv('TMPDIR', temp); root = await mkdtemp(join(tmpdir(), 'chrome-tabs-')); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`; manager = createBrowserSessionManager({ store, config: config() }); }, 30000);
  afterAll(async () => { await manager?.closeAll(); await new Promise<void>(r => server.close(() => r())); if (root) await rm(root, { recursive: true, force: true }); if (temp) await rm(temp, { recursive: true, force: true }); vi.unstubAllEnvs(); }, 30000);

  it('keeps each tab in its account, follows it with the live view, popups and input, and reopens it there after a restart', async () => {
    await manager.startOrRestore({ pane, googleAccount: { ownerUserId: user.id, accountId: first.id }, targetUrl: origin + '/write', includeInitialFrame: false, traceId: 'trace' });
    await expect.poll(text).toContain('"cookie":true');
    const own = (await pages()).pages[0]!;
    expect(own.account).toBeNull();
    const created = await manager.createPage!(pane, origin + '/read', true, 'trace');
    const tab = created.pages.find(page => page.pageId !== own.pageId)!;
    await expect.poll(text).toContain('"path":"/read","cookie":true');

    await toSecond(tab.pageId);
    let list = await pages();
    expect(list.pages).toHaveLength(2);
    const moved = list.pages.find(page => page.account)!;
    expect(moved).toMatchObject({ account: { profileId: second.id, label: 'b@example.test' }, isActive: true, url: origin + '/read' });
    expect(list.pages.find(page => page.pageId === own.pageId)!.account).toBeNull();
    // The same pane, the other account's cookies; the live view comes from the other Chrome.
    await expect.poll(text).toContain('"path":"/read","cookie":false');
    const shot = (await manager.action(pane, { type: 'extract_text' }, 'trace')).frame;
    expect(shot).toMatchObject({ currentUrl: origin + '/read', screenshotDataUrl: expect.stringMatching(/^data:image\/png;base64,/) });
    const frames: number[] = [];
    const stream = await manager.startFrameStream!((await manager.getActive(pane))!.session.sessionId, 'AUTO', frame => { frames.push(frame.data.byteLength); });
    await expect.poll(() => frames.length).toBeGreaterThan(0);

    await manager.activatePage!(pane, own.pageId, 'trace');
    await expect.poll(text).toContain('"path":"/write","cookie":true');
    const seen = frames.length;
    await manager.action(pane, { type: 'scroll', deltaX: 0, deltaY: 10 }, 'trace');
    await expect.poll(() => frames.length).toBeGreaterThan(seen);
    await stream.stop();
    await manager.activatePage!(pane, moved.pageId, 'trace');
    await manager.action(pane, { type: 'click', x: 40, y: 25 }, 'trace');
    await expect.poll(async () => (await pages()).pages.length).toBe(3);
    const popup = (await pages()).pages.find(page => page.kind === 'POPUP')!;
    expect(popup.account).toEqual({ profileId: second.id, label: 'b@example.test' });
    await manager.closePage!(pane, popup.pageId, 'trace');
    await manager.activatePage!(pane, moved.pageId, 'trace');

    // Back to the pane's account: the tab sees the pane's cookies again.
    await manager.startOrRestore({ pane, accountTab: { pageId: moved.pageId, profileId: null, label: null }, traceId: 'trace' });
    list = await pages();
    expect(list.pages.every(page => page.account === null)).toBe(true);
    await expect.poll(text).toContain('"path":"/read","cookie":true');

    // A restart of the host reopens the account tab in its account, never in the pane's.
    await toSecond(list.activePageId!);
    // The list saved for the restart: the moved tab once, never also its closing copy in the pane's Chrome.
    list = await pages();
    expect([list.pages.length, list.pages.filter(page => page.account).length]).toEqual([2, 1]);
    await manager.closeAll();
    manager = createBrowserSessionManager({ store, config: config() });
    await manager.getActive(pane);
    await expect.poll(async () => (await pages()).pages.filter(page => page.account).length, { timeout: 20000 }).toBe(1);
    list = await pages();
    expect(list.pages).toHaveLength(2);
    await manager.activatePage!(pane, list.pages.find(page => page.account)!.pageId, 'trace');
    await expect.poll(text).toContain('"path":"/read","cookie":false');
    // Already in that account: a sign-in request opens the given page in the same tab.
    const restored = list.pages.find(page => page.account)!.pageId;
    await manager.startOrRestore({ pane, ...inSecond, accountTab: { pageId: restored, profileId: second.id, label: 'b@example.test', url: origin + '/write' }, traceId: 'trace' });
    await expect.poll(text).toContain('"path":"/write","cookie":true');
    expect((await pages()).pages.find(page => page.account)!.pageId).toBe(restored);

    // The pane's own Chrome crashes while its tab in the other account stays open: both come back, that tab once.
    const chromeMains = (profile: string) => readdirSync('/proc').filter(entry => /^\d+$/.test(entry)).flatMap(entry => {
      try {
        const args = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0');
        return args.includes(`--user-data-dir=${profile}`) && !args.some(arg => arg.startsWith('--type=')) ? [Number(entry)] : [];
      } catch { return []; }
    });
    const ownProfile = googleBrowserProfilePathFor(root, user.id, first.id);
    const other = googleBrowserProfilePathFor(root, user.id, second.id);
    expect(chromeMains(other)).toHaveLength(1);
    for (const pid of chromeMains(ownProfile)) process.kill(pid, 'SIGKILL');
    await expect.poll(() => chromeMains(ownProfile).length).toBe(0);
    await expect.poll(async () => { const now = await pages(); return [now.pages.length, now.pages.filter(page => page.account).length]; }, { timeout: 30000 }).toEqual([2, 1]);
    expect(chromeMains(other)).toHaveLength(1);
    await manager.activatePage!(pane, (await pages()).pages.find(page => page.account)!.pageId, 'trace');
    await expect.poll(text).toContain('"path":"/write","cookie":true');

    // Freelance Copilot tabs keep the pane's account (its egress routes); a stopped pane leaves every Chrome.
    await manager.startOrRestore({ pane: freelance, targetUrl: origin + '/read', includeInitialFrame: false, traceId: 'trace' });
    const freelanceTab = (await manager.listPages!(freelance)).pages[0]!;
    await expect(manager.startOrRestore({ pane: freelance, ...inSecond, accountTab: { pageId: freelanceTab.pageId, profileId: second.id, label: null }, traceId: 'trace' }))
      .rejects.toThrow(/FREELANCE_EGRESS/);
    await manager.stopPane(freelance.id);
    await manager.stopPane(pane.id);
    expect(manager.capacity!().activeSessions).toBe(0);
  }, 120000);
});

// Opt-in network check against Google itself with an empty disposable profile.
// It never signs in: the only acceptable answer is "no Google session".
describe.skipIf(process.env.SPACE_REAL_GOOGLE_CHECK !== '1')('real Google session check of an empty profile', () => {
  it('reports Not connected from Google ListAccounts and leaves no Chrome running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'google-real-check-'));
    const store = new InMemorySpaceStore();
    const user = store.upsertUser({ id: 'user:real-check', email: 'real-check@example.test', role: 'ADMIN' });
    const account = store.linkGoogleAccount(user.id, { sub: '000000000000000000000', email: 'nobody.real-check@example.test' });
    const manager = createBrowserSessionManager({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: 'true', SPACE_BROWSER_SESSIONS_PROFILE_ROOT: root, SPACE_ARTIFACT_ROOT: root, SPACE_BROWSER_SESSIONS_AUDIO_ENABLED: 'false', SPACE_BROWSER_SESSIONS_XVFB_ENABLED: 'true' }) });
    try {
      const { mkdir } = await import('node:fs/promises');
      const { googleBrowserProfilePathFor } = await import('../src/browser-sessions.js');
      await mkdir(googleBrowserProfilePathFor(root, user.id, account.id), { recursive: true });
      const result = await manager.checkGoogleAccount!({ ownerUserId: user.id, accountId: account.id }, true);
      expect(result).toMatchObject({ status: 'NOT_CONNECTED', reason: 'NO_GOOGLE_SESSION' });
      expect(manager.capacity!().activeSessions).toBe(0);
    } finally { await manager.closeAll(); await rm(root, { recursive: true, force: true }); }
  }, 60000);
});

// Chrome holds each input to a background tab for 5 s and streams no frames from it (2026-10-20): an agent's tab
// switch left a pane's tab behind another, and taking control must bring the pane's tab back to the front.
describe.skipIf(missingBrowser)('taking control of a pane whose tab another tab hid, in real Chrome', () => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body><script>const s=()=>document.body.textContent=document.visibilityState;s();document.addEventListener("visibilitychange",s);</script></body></html>');
  });
  let root: string; let temp: string; let origin: string;
  let manager: ReturnType<typeof createBrowserSessionManager>;
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: 'Front tab', initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: 'Browser', mode: 'BROWSER' });
  const text = async () => (await manager.action(pane, { type: 'extract_text' }, 'trace')).text;
  beforeAll(async () => { temp = await mkdtemp(join(tmpdir(), 't-')); vi.stubEnv('TMPDIR', temp); root = await mkdtemp(join(tmpdir(), 'chrome-front-')); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`; manager = createBrowserSessionManager({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: 'true', SPACE_BROWSER_SESSIONS_PROFILE_ROOT: root, SPACE_ARTIFACT_ROOT: root, SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN: origin, SPACE_BROWSER_SESSIONS_AUDIO_ENABLED: 'false', SPACE_BROWSER_SESSIONS_XVFB_ENABLED: 'true' }) }); }, 30000);
  afterAll(async () => { await manager?.closeAll(); await new Promise<void>(r => server.close(() => r())); if (root) await rm(root, { recursive: true, force: true }); if (temp) await rm(temp, { recursive: true, force: true }); vi.unstubAllEnvs(); }, 30000);

  it("brings the pane's active tab to the front when control is acquired", async () => {
    await manager.startOrRestore({ pane, targetUrl: origin + '/', includeInitialFrame: false, traceId: 'trace' });
    await expect.poll(text).toBe('visible');
    const own = (await manager.listPages!(pane)).activePageId;
    const other = (await manager.createPage!(pane, origin + '/other', false, 'trace')).pages.find(page => page.pageId !== own)!;
    // The agent's switch: the other tab goes in front while the pane keeps its active tab.
    const [port, path] = readFileSync(`${store.getActivePaneBrowserSession(pane.id)!.profilePath}/DevToolsActivePort`, 'utf8').split('\n');
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
    ws.send(JSON.stringify({ id: 1, method: 'Target.activateTarget', params: { targetId: other.pageId } }));
    await expect.poll(text).toBe('hidden');
    ws.close();
    await manager.acquireControl!(pane, { holderType: 'OPERATOR', holderId: 'user:test', reason: null, ttlSeconds: 30 }, 'trace');
    await expect.poll(text).toBe('visible');
  }, 60000);
});
