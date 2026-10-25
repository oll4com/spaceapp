import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { youTubeAdBlockScript } from '../src/youtube-ad-block.js';

interface FakeResponseInit { status?: number; statusText?: string; headers?: unknown }

class FakeResponse {
  body: string;
  status: number;
  statusText: string;
  headers: unknown;
  constructor(body: string, init: FakeResponseInit = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? 'OK';
    this.headers = init.headers ?? {};
  }
  clone(): FakeResponse { return this; }
  text(): Promise<string> { return Promise.resolve(this.body); }
}

function buildSandbox(hostname: string) {
  const intervals: Array<() => void> = [];
  const sandbox: Record<string, unknown> = {
    console,
    Response: FakeResponse,
    setInterval: (fn: () => void) => { intervals.push(fn); return intervals.length; },
    location: { hostname },
    document: {
      head: { appendChild: () => undefined },
      documentElement: { appendChild: () => undefined },
      createElement: () => ({ setAttribute: () => undefined, textContent: '' }),
      addEventListener: () => undefined,
      querySelector: () => null
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return { sandbox, intervals };
}

function run(hostname: string) {
  const { sandbox, intervals } = buildSandbox(hostname);
  const context = createContext(sandbox);
  runInContext(youTubeAdBlockScript(), context);
  return { sandbox, intervals };
}

describe('youTubeAdBlockScript', () => {
  it('is inert on non-YouTube hosts', () => {
    const { sandbox } = run('www.example.com');
    const value = { playerAds: ['ad'], adPlacements: ['p'], contents: 'video' };
    (sandbox as Record<string, unknown>).ytInitialPlayerResponse = value;
    expect((sandbox as Record<string, unknown>).ytInitialPlayerResponse).toEqual(value);
  });

  it('prunes ad keys from ytInitialPlayerResponse on YouTube', () => {
    const { sandbox } = run('www.youtube.com');
    (sandbox as Record<string, unknown>).ytInitialPlayerResponse = {
      playerAds: ['ad'], adPlacements: ['p'], adSlots: ['s'], adBreakHeartbeatParams: { h: 1 },
      auxiliaryUi: { messageRenderers: { upsellDialogRenderer: { u: 1 } } },
      contents: 'video'
    };
    const pruned = (sandbox as Record<string, unknown>).ytInitialPlayerResponse as Record<string, unknown>;
    expect(pruned.playerAds).toBeUndefined();
    expect(pruned.adPlacements).toBeUndefined();
    expect(pruned.adSlots).toBeUndefined();
    expect(pruned.adBreakHeartbeatParams).toBeUndefined();
    expect((pruned.auxiliaryUi as Record<string, unknown>).messageRenderers).toEqual({});
    expect(pruned.contents).toBe('video');
  });

  it('prunes innertube fetch responses but leaves other URLs untouched', async () => {
    const { sandbox } = buildSandbox('m.youtube.com');
    const adPayload = JSON.stringify({ playerAds: ['ad'], playerResponse: { adSlots: ['s'] }, contents: 'ok' });
    (sandbox as Record<string, unknown>).fetch = () => Promise.resolve(new FakeResponse(adPayload));
    runInContext(youTubeAdBlockScript(), createContext(sandbox));
    const fetchFn = (sandbox as Record<string, unknown>).fetch as (url: string) => Promise<FakeResponse>;

    const pruned = await fetchFn('/youtubei/v1/player?key=1');
    const prunedJson = JSON.parse(await pruned.text()) as Record<string, unknown>;
    expect(prunedJson.playerAds).toBeUndefined();
    expect((prunedJson.playerResponse as Record<string, unknown>).adSlots).toBeUndefined();
    expect(prunedJson.contents).toBe('ok');

    const untouched = await fetchFn('/some/other/endpoint');
    expect(JSON.parse(await untouched.text())).toEqual(JSON.parse(adPayload));
  });

  it('prunes innertube XHR responses', () => {
    const { sandbox } = buildSandbox('www.youtube.com');
    function FakeXHR(this: Record<string, unknown>) {
      this.readyState = 0;
      this._listeners = {};
    }
    const proto = FakeXHR.prototype as unknown as Record<string, unknown>;
    proto.addEventListener = function (this: Record<string, unknown>, type: string, fn: () => void) {
      const list = (this._listeners as Record<string, Array<() => void>>)[type] ?? [];
      list.push(fn);
      (this._listeners as Record<string, Array<() => void>>)[type] = list;
    };
    proto.open = function (this: Record<string, unknown>, _method: string, url: string) { this._url = url; };
    proto.send = function (this: Record<string, unknown>) {
      this.readyState = 4;
      this.responseText = JSON.stringify({ adPlacements: ['p'], contents: 'ok' });
      for (const fn of (this._listeners as Record<string, Array<() => void>>).readystatechange ?? []) fn.call(this);
    };
    (sandbox as Record<string, unknown>).XMLHttpRequest = FakeXHR;
    runInContext(youTubeAdBlockScript(), createContext(sandbox));

    const xhr = new (FakeXHR as unknown as new () => Record<string, unknown>)();
    (xhr as { open: (m: string, u: string) => void }).open('POST', '/youtubei/v1/next');
    (xhr as { send: () => void }).send();
    const pruned = JSON.parse(xhr.responseText as string) as Record<string, unknown>;
    expect(pruned.adPlacements).toBeUndefined();
    expect(pruned.contents).toBe('ok');
  });

  it('registers a skip/fast-forward watcher without throwing', () => {
    const { intervals } = run('www.youtube.com');
    expect(intervals.length).toBeGreaterThan(0);
    expect(() => intervals.forEach((fn) => fn())).not.toThrow();
  });
});
