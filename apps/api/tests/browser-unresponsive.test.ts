import { describe, expect, it, vi } from 'vitest';
import { SpaceFeatureDisabledError } from '@space/runtime';
import { relaunchOnReport, withUnresponsiveReport } from '../src/browser-unresponsive.js';
import { registerVaultFenceHooks } from '../src/vault/fence-hooks.js';

const pane = (id: string, paneName: string) => ({ id, roomId: 'room:1', paneName, title: paneName });

function setup(fail: () => boolean, open = true, relaunch?: (paneIds: string[]) => Promise<unknown>) {
  const store = {
    getPane: async (id: string) => pane(id, id === 'pane:a' ? 'Huawei form' : 'Other'),
    getRoom: async () => ({ id: 'room:1' }),
    getActiveBrowserHandoffRequest: async (sessionId: string) => open && sessionId === 'browser_session:a' ? { id: 'handoff:1' } : null
  };
  registerVaultFenceHooks(store, { fenceHandoff: async () => undefined, fencedTargets: async () => open ? ['page:1'] : [] });
  const note = vi.fn(async () => undefined);
  const manager = {
    getActive: async (target: { id: string }) => {
      if (fail()) throw new SpaceFeatureDisabledError('BROWSER_UNRESPONSIVE', 'not answering',
        { paneId: target.id, sessionId: 'browser_session:a', profilePath: '/x/cli-accounts/abcdef0123456789', otherPanes: ['pane:b'], why: 'lost its DevTools connection' });
      return 'ok';
    },
    capacity: () => 7
  };
  const wrapped = withUnresponsiveReport(manager, { store: store as never, note: () => note as never, relaunch, relaunchAfterMs: 20 });
  return { wrapped, note };
}

describe('BROWSER_UNRESPONSIVE report to Nous', () => {
  it('sends one needs-decision report per episode naming the pane, Chrome, its other panes, handoff and fence; rethrows; keeps sync methods', async () => {
    let down = true;
    const { wrapped, note } = setup(() => down);
    expect(wrapped.capacity()).toBe(7);
    await expect(wrapped.getActive({ id: 'pane:a' })).rejects.toMatchObject({ errorCode: 'BROWSER_UNRESPONSIVE' });
    await expect(wrapped.getActive({ id: 'pane:a' })).rejects.toMatchObject({ errorCode: 'BROWSER_UNRESPONSIVE' });
    await vi.waitFor(() => expect(note).toHaveBeenCalledTimes(1));
    const [, reported, status, summary] = note.mock.calls[0] as unknown as [unknown, { id: string }, string, string];
    expect(reported.id).toBe('pane:a');
    expect(status).toBe('NEEDS_DECISION');
    expect(summary).toContain('Huawei form (pane:a)');
    expect(summary).toContain('cli-accounts/abcdef012345');
    expect(summary).toContain('Other (pane:b)');
    expect(summary).toContain('handoff OPEN');
    expect(summary).toContain('Vault fence OPEN');
    expect(summary).toContain('Space relaunches it and its other panes on the same page');
    down = false;
    await expect(wrapped.getActive({ id: 'pane:a' })).resolves.toBe('ok');
    down = true;
    await expect(wrapped.getActive({ id: 'pane:a' })).rejects.toThrow('not answering');
    await vi.waitFor(() => expect(note).toHaveBeenCalledTimes(2));
  });
  it('relaunches a Chrome still not answering with its other panes, handoff and Vault fence open included; not one that answers again', async () => {
    let down = true;
    const relaunch = vi.fn(async () => { down = false; });
    const { wrapped } = setup(() => down, true, relaunch);
    await expect(wrapped.getActive({ id: 'pane:a' })).rejects.toMatchObject({ errorCode: 'BROWSER_UNRESPONSIVE' });
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalledWith(['pane:a', 'pane:b']));
    // A relaunched Chrome that hangs again is a new episode, relaunched again.
    down = true;
    await expect(wrapped.getActive({ id: 'pane:a' })).rejects.toMatchObject({ errorCode: 'BROWSER_UNRESPONSIVE' });
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalledTimes(2));
    const slow = vi.fn(async () => undefined);
    let busy = true;
    const second = setup(() => busy, false, slow);
    await expect(second.wrapped.getActive({ id: 'pane:a' })).rejects.toMatchObject({ errorCode: 'BROWSER_UNRESPONSIVE' });
    busy = false;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(slow).not.toHaveBeenCalled();
  });
});

describe("a copilot's own relaunch ask (operator 21/11 18:05 BKK, Job Copilot Andy)", () => {
  function deps(handoff = false, fenced = false, shared = false) {
    const a = { sessionId: 'browser_session:a', paneId: 'pane:a', profilePath: '/profiles/jobs' };
    const sessions = [a, { sessionId: 'browser_session:c', paneId: 'pane:c', profilePath: '/profiles/other' },
      ...(shared ? [{ sessionId: 'browser_session:b', paneId: 'pane:b', profilePath: '/profiles/jobs' }] : [])];
    const store = {
      getActivePaneBrowserSession: async (paneId: string) => paneId === 'pane:a' ? a : null,
      listActivePaneBrowserSessions: async () => sessions,
      // With a shared Chrome the open handoff is on its other pane.
      getActiveBrowserHandoffRequest: async (sessionId: string) => handoff && sessionId === (shared ? 'browser_session:b' : 'browser_session:a') ? { id: 'handoff:1' } : null
    };
    registerVaultFenceHooks(store, { fenceHandoff: async () => undefined, fencedTargets: async (paneId: string) => fenced && paneId === (shared ? 'pane:b' : 'pane:a') ? ['page:1'] : [] });
    const relaunch = vi.fn(async () => undefined);
    return { store: store as never, relaunch };
  }
  const ask = { source: 'AGENT', status: 'NEEDS_DECISION', paneId: 'pane:a', summary: 'NO_RUN: Chrome hung on careers-sbs.icims.com/login', needs: 'needs decision: relaunch Chrome' };

  it('relaunches the pane Chrome a needs-decision or blocked report asks for or says hangs', async () => {
    for (const report of [ask, { ...ask, status: 'BLOCKED', summary: 'The browser is not responding on the login page', needs: null },
      // DEV3D-043: saying it cannot restart Chrome itself is the reason to relaunch, not a refusal.
      { ...ask, status: 'BLOCKED', summary: "Chrome is frozen and I can't restart Chrome.", needs: null },
      { ...ask, summary: 'I could not restart the browser from the pane, please relaunch Chrome.', needs: null }]) {
      const d = deps();
      expect(await relaunchOnReport(d, report)).toBe(true);
      expect(d.relaunch).toHaveBeenCalledWith(['pane:a']);
    }
  });

  it('relaunches every pane on a shared Chrome (it closes only when its last pane leaves), unless one of them has a handoff or Vault fill open', async () => {
    const d = deps(false, false, true);
    expect(await relaunchOnReport(d, ask)).toBe(true);
    expect(d.relaunch).toHaveBeenCalledWith(['pane:a', 'pane:b']);
    for (const blocked of [deps(true, false, true), deps(false, true, true)]) {
      expect(await relaunchOnReport(blocked, ask)).toBe(false);
      expect(blocked.relaunch).not.toHaveBeenCalled();
    }
  });

  it("leaves Space's own reports, other statuses, other asks, a pane with no Chrome, an open handoff or Vault fill", async () => {
    for (const [report, d] of [
      [{ ...ask, source: 'AUTO' }, deps()], [{ ...ask, status: 'DONE' }, deps()], [{ ...ask, summary: 'Upwork Connects 0', needs: 'buy Connects?' }, deps()],
      [{ ...ask, paneId: 'pane:none' }, deps()], [ask, deps(true)], [ask, deps(false, true)],
      // DEV3D-026: a negated ask or state is no ask.
      [{ ...ask, summary: 'Waiting on the operator; do not restart the browser', needs: null }, deps()],
      [{ ...ask, summary: 'Chrome hung on the form, but don\'t relaunch the browser: the draft is unsaved', needs: null }, deps()],
      [{ ...ask, status: 'BLOCKED', summary: 'The browser is not stuck, the site is down', needs: null }, deps()]
    ] as const) {
      expect(await relaunchOnReport(d, report)).toBe(false);
      expect(d.relaunch).not.toHaveBeenCalled();
    }
  });
});
