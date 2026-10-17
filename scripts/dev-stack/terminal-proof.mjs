import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';

const menuTitles = ['Switch session', 'New session', 'Switch model', 'Switch agent', 'Connect provider', 'View status', 'Switch theme', 'Help', 'Exit the app'];
// Exact 1.18.4 references are recorded in the validation evidence. A brand name,
// rendered terminal rectangle, or historical RUNNING flag is never UI proof.
export class InteractiveTerminalProof {
  constructor(sessionId) { this.sessionId = sessionId; this.wsState = 'CONNECTING'; this.status = null; this.events = []; this.sequence = 0; this.fatal = null; this.sealed = false; this.session = null; }
  fail(message) { if (!this.sealed && !this.fatal) this.fatal = message; }
  open() { this.wsState = 'OPEN'; }
  error(code = 'WEBSOCKET_ERROR') { this.fail(`Terminal WebSocket error (${String(code).slice(0, 80)}).`); }
  close(code) { this.wsState = 'CLOSED'; this.closeCode = code; this.fail('Terminal WebSocket closed during the interactive proof.'); }
  message(event) {
    if (this.sealed) return;
    if (event.type === 'error') this.fail(`Terminal error (${String(event.code || 'UNKNOWN').slice(0, 80)}).`);
    if (event.type === 'status') { this.status = event.status; this.exitCode = event.exitCode ?? null; if (['ERROR', 'EXITED'].includes(event.status) || this.exitCode !== null) this.fail(`Terminal status/exit evidence ${event.status}.`); }
    if (event.type === 'output') {
      const text = stripVTControlCharacters(String(event.data));
      this.events.push({ sequence: ++this.sequence, text });
      while (this.events.length > 256) this.events.shift();
      const recent = this.events.map(item => item.text).join('').slice(-8000);
      if (/MODULE_NOT_FOUND|Cannot find module|postinstall[^\n]*not|CLI process exited|Pinned state-local OpenCode could not start/i.test(recent)) this.fail('Terminal output reports a CLI bootstrap/exit failure.');
    }
  }
  assertHealthy() { if (this.fatal) { const error = new Error(this.fatal); error.fatal = true; throw error; } }
  live(response) {
    this.assertHealthy();
    const session = response?.session;
    this.session = session ? { sessionId: session.sessionId, status: session.status, isActive: session.isActive, exitCode: session.exitCode ?? null } : null;
    if (!session || session.sessionId !== this.sessionId || session.runtimeId !== 'cli:opencode' || session.isActive !== true || session.exitCode !== null || ['ERROR', 'EXITED'].includes(session.status)) {
      this.fail('Fresh API session is absent, inactive, failed, or differs from the tested OpenCode session.'); this.assertHealthy();
    }
    return this.wsState === 'OPEN' && this.status === 'RUNNING' && session.status === 'RUNNING';
  }
  barrier() { this.assertHealthy(); return this.sequence; }
  fresh(after) { return this.events.filter(event => event.sequence > after).map(event => event.text).join(''); }
  menu(after) { this.assertHealthy(); const text = this.fresh(after); return text.includes('Commands') && menuTitles.filter(title => text.includes(title)).length >= 2; }
  challenge(after, value) { this.assertHealthy(); const text = this.fresh(after); return text.includes(value) && text.includes('No results found'); }
  seal(response) { assert.equal(this.live(response), true, 'UI success requires a final fresh live API/WS session.'); this.sealed = true; }
  diagnostic(redactions = []) {
    let excerpt = this.events.map(event => event.text).join('').slice(-6000);
    for (const secret of redactions.filter(Boolean).sort((a, b) => b.length - a.length)) excerpt = excerpt.split(secret).join('[redacted]');
    excerpt = excerpt.replace(/([?&](?:token|sessionToken|access_token)=)[^\s&]+/gi, '$1[redacted]');
    return { expectedSessionId: this.sessionId, currentSession: this.session, websocket: { state: this.wsState, status: this.status, exitCode: this.exitCode ?? null, closeCode: this.closeCode ?? null, fatal: this.fatal }, outputEvents: this.sequence, sealed: this.sealed, syntheticTerminalExcerpt: excerpt };
  }
}
export function assertBrowserTerminal(state, paneId) {
  assert(state && state.paneId === paneId, 'The rendered terminal must belong to the tested pane.');
  assert.equal(state.status, 'attached', 'The tested browser terminal must be currently attached.');
  assert.equal(state.hasSession, 'true'); assert.equal(state.hasWebsocket, 'true'); assert.equal(state.hasError, 'false');
  assert(state.width > 0, 'The matching live terminal must actually render.');
}
