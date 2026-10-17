import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import headless from '@xterm/headless';

const menuTitles = ['Switch session', 'New session', 'Switch model', 'Switch agent', 'Connect provider', 'View status', 'Switch theme', 'Help', 'Exit the app'];
const maximumReplayBytes = 8 * 1024 * 1024;
const fullMenu = text => text.includes('Commands') && menuTitles.filter(title => text.includes(title)).length >= 2;
const validGrid = value => value && Number.isInteger(value.cols) && value.cols >= 2 && value.cols <= 400 && Number.isInteger(value.rows) && value.rows >= 2 && value.rows <= 200;
const sameGrid = (left, right) => left?.cols === right?.cols && left?.rows === right?.rows;
const sameGeometry = (left, right) => sameGrid(left, right) && left?.generationId === right?.generationId;
const selectedGeometry = value => value ? { generationId: typeof value.generationId === 'string' && /^[a-z0-9:_-]{1,160}$/i.test(value.generationId) ? value.generationId : null, cols: Number.isInteger(value.cols) && value.cols >= 2 && value.cols <= 400 ? value.cols : null, rows: Number.isInteger(value.rows) && value.rows >= 2 && value.rows <= 200 ? value.rows : null } : null;
const selectedBrowserGrid = value => value ? { cols: selectedGeometry(value).cols, rows: selectedGeometry(value).rows, initialFitPending: value.initialFitPending === true, fontsLoaded: value.fontsLoaded === true } : null;
// Exact 1.18.4 references are recorded in the validation evidence. A brand name,
// rendered terminal rectangle, or historical RUNNING flag is never UI proof.
export class InteractiveTerminalProof {
  constructor(sessionId) { this.sessionId = sessionId; this.wsState = 'CONNECTING'; this.status = null; this.events = []; this.sequence = 0; this.fatal = null; this.sealed = false; this.session = null; this.frames = []; this.replayBytes = 0; this.completeReplay = false; this.geometry = null; this.screenRecords = []; this.activeTransition = null; this.expectedGenerationId = null; this.initialGeometry = null; this.geometryCandidate = null; this.browserGeometry = null; this.geometryObservation = null; }
  fail(message) { if (!this.sealed && !this.fatal) this.fatal = message; }
  open() { this.wsState = 'OPEN'; }
  error(code = 'WEBSOCKET_ERROR') { this.fail(`Terminal WebSocket error (${String(code).slice(0, 80)}).`); }
  close(code) { this.wsState = 'CLOSED'; this.closeCode = code; this.fail('Terminal WebSocket closed during the interactive proof.'); }
  message(event) {
    if (this.sealed) return;
    if (event.type === 'error') this.fail(`Terminal error (${String(event.code || 'UNKNOWN').slice(0, 80)}).`);
    if (event.type === 'status') { this.status = event.status; this.exitCode = event.exitCode ?? null; if (event.replayContinuity === 'TRUNCATED') this.fail('Terminal replay is truncated; a tail cannot prove the current screen.'); else if (event.replayContinuity === 'COMPLETE') this.completeReplay = true; if (['ERROR', 'EXITED'].includes(event.status) || this.exitCode !== null) this.fail(`Terminal status/exit evidence ${event.status}.`); }
    if (event.type === 'output') {
      const data = String(event.data), size = Buffer.byteLength(data, 'utf8');
      if (this.replayBytes + size > maximumReplayBytes) { this.fail('Complete terminal replay exceeds the projection limit; refusing a partial screen.'); return; }
      this.replayBytes += size;
      const text = stripVTControlCharacters(data);
      this.events.push({ sequence: ++this.sequence, text });
      this.frames.push({ sequence: this.sequence, data });
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
  observeGeometry(response, phase) {
    const geometry = response?.session?.terminalGeometry;
    this.geometryObservation = { phase, sequence: this.sequence, expected: selectedGeometry(this.geometry || this.browserGeometry?.geometry || (this.expectedGenerationId ? { generationId: this.expectedGenerationId } : null)), observedAPI: selectedGeometry(geometry) };
    if (!validGrid(geometry) || typeof geometry.generationId !== 'string' || !/^[a-z0-9:_-]{1,160}$/i.test(geometry.generationId)) this.fail('A current generation-bound terminal geometry is required.');
    this.assertHealthy();
    if (this.geometry && !sameGeometry(geometry, this.geometry)) this.fail('Terminal generation or geometry changed after the pre-input baseline.');
    if (this.expectedGenerationId && geometry.generationId !== this.expectedGenerationId) this.fail('Terminal generation changed before the pre-input baseline.');
    this.assertHealthy();
    return { generationId: geometry.generationId, cols: geometry.cols, rows: geometry.rows };
  }
  pinGeneration(response) {
    if (!this.live(response)) return false;
    const geometry = this.observeGeometry(response, 'before-browser-startup');
    this.expectedGenerationId ??= geometry.generationId;
    this.initialGeometry ??= geometry;
    return true;
  }
  acknowledgeBrowserGeometry(paneId, before, response, after, now = Date.now()) {
    this.assertHealthy();
    assert(this.expectedGenerationId, 'Pin the first live generation before starting the browser.');
    assert.equal(this.browserGeometry, null, 'The browser geometry acknowledgment cannot be resampled.');
    assert.equal(this.geometry, null, 'The pre-input baseline cannot be resampled.');
    assert.equal(this.activeTransition, null, 'No keyboard transition may precede browser geometry acknowledgment.');
    assert(Number.isFinite(now), 'The bounded geometry sample clock must be finite.');
    if (!this.live(response)) { this.geometryCandidate = null; return null; }
    const geometry = this.observeGeometry(response, 'browser-api-pre-input');
    assertBrowserTerminal(before, paneId); assertBrowserTerminal(after, paneId);
    this.geometryObservation.DOMBefore = selectedBrowserGrid(before.geometry); this.geometryObservation.DOMAfter = selectedBrowserGrid(after.geometry);
    const ready = value => validGrid(value) && value.initialFitPending === false && value.fontsLoaded === true;
    if (!ready(before.geometry) || !ready(after.geometry) || !sameGrid(before.geometry, after.geometry) || !sameGrid(after.geometry, geometry)) { this.geometryCandidate = null; return null; }
    if (!this.geometryCandidate || !sameGeometry(this.geometryCandidate.geometry, geometry)) { this.geometryCandidate = { geometry, since: now }; return null; }
    if (now - this.geometryCandidate.since < 400) return null;
    this.browserGeometry = Object.freeze({ paneId, geometry: Object.freeze({ ...geometry }), acknowledgedSamples: 2, stableForMs: now - this.geometryCandidate.since, sequence: this.sequence });
    return this.browserGeometry;
  }
  assertBrowserGeometry(state, paneId, phase) {
    this.assertHealthy(); assert.equal(paneId, this.browserGeometry?.paneId, 'The browser must remain the acknowledged pane.'); assertBrowserTerminal(state, paneId);
    const expected = this.geometry || this.browserGeometry?.geometry;
    this.geometryObservation = { phase, sequence: this.sequence, expected: selectedGeometry(expected), observedAPI: this.geometryObservation?.observedAPI ?? null, observedDOM: selectedBrowserGrid(state.geometry) };
    if (!expected || !validGrid(state.geometry) || state.geometry.initialFitPending !== false || state.geometry.fontsLoaded !== true || !sameGrid(state.geometry, expected)) this.fail('The browser terminal grid differs from the acknowledged pre-input baseline.');
    this.assertHealthy();
  }
  barrier() { this.assertHealthy(); return this.sequence; }
  fresh(after) { return this.events.filter(event => event.sequence > after).map(event => event.text).join(''); }
  menu(after) { this.assertHealthy(); const text = this.fresh(after); return text.includes('Commands') && menuTitles.filter(title => text.includes(title)).length >= 2; }
  challenge(after, value) { this.assertHealthy(); const text = this.fresh(after); return text.includes(value) && text.includes('No results found'); }
  async screen(response, phase = 'screen-projection') {
    if (!this.live(response)) return null;
    const geometry = this.observeGeometry(response, phase);
    if (!this.completeReplay) this.fail('A complete terminal replay has not been established.');
    this.assertHealthy();
    const sequence = this.sequence, terminal = new headless.Terminal({ cols: geometry.cols, rows: geometry.rows, scrollback: 0, allowProposedApi: true });
    try {
      // Match the canonical room-terminal-screen projection: full observed ANSI
      // replay, awaited write callback and active screen, never a stripped tail.
      await new Promise(done => terminal.write(this.frames.map(frame => frame.data).join(''), done));
      const buffer = terminal.buffer.active, lines = [];
      for (let index = 0; index < buffer.length; index++) {
        const line = buffer.getLine(index), text = line?.translateToString(!buffer.getLine(index + 1)?.isWrapped) || '';
        if (line?.isWrapped && lines.length) lines[lines.length - 1] += text; else lines.push(text);
      }
      this.assertHealthy();
      if (this.sequence !== sequence) return null;
      this.lastScreen = { sequence, geometry: { generationId: geometry.generationId, cols: geometry.cols, rows: geometry.rows }, text: lines.join('\n') };
      return this.lastScreen;
    } finally { terminal.dispose(); }
  }
  async beginScreenTransition(kind, response, challenge = null) {
    assert(['open', 'filter', 'dismiss'].includes(kind), 'Unknown terminal transition.');
    if (kind !== 'open') assert(typeof challenge === 'string' && /^[a-z0-9]{1,64}$/.test(challenge), 'A fresh synthetic challenge is required.');
    assert.equal(this.activeTransition, null, 'A previous terminal transition remains unverified.');
    if (this.expectedGenerationId && !this.browserGeometry) this.fail('Browser/API geometry acknowledgment is required before the first input baseline.');
    this.assertHealthy();
    const screen = await this.screen(response, `before-${kind}`); if (!screen) return null;
    if (this.browserGeometry && !sameGeometry(screen.geometry, this.browserGeometry.geometry)) this.fail('Terminal geometry changed after browser/API pre-input acknowledgment.');
    this.assertHealthy();
    const filtered = screen.text.includes('Commands') && screen.text.includes('No results found') && challenge && screen.text.includes(challenge);
    const valid = kind === 'open' ? !screen.text.includes('Commands') && !screen.text.includes('No results found') : kind === 'filter' ? fullMenu(screen.text) && !screen.text.includes(challenge) && !screen.text.includes('No results found') : filtered;
    if (!valid) return null;
    this.geometry ??= screen.geometry;
    const token = Object.freeze({ kind, challenge, sequence: screen.sequence, geometry: Object.freeze({ ...screen.geometry }) });
    this.screenRecords.push({ phase: `before-${kind}`, ...screen }); this.activeTransition = token; return token;
  }
  async screenTransition(token, response) {
    assert.equal(token, this.activeTransition, 'Only the current pre-input transition can be verified.');
    const screen = await this.screen(response, `after-${token.kind}`); if (!screen || screen.sequence <= token.sequence) return null;
    const valid = token.kind === 'open' ? fullMenu(screen.text) && !screen.text.includes('No results found') : token.kind === 'filter' ? screen.text.includes('Commands') && screen.text.includes(token.challenge) && screen.text.includes('No results found') : !screen.text.includes('Commands') && !screen.text.includes(token.challenge) && !screen.text.includes('No results found');
    if (!valid) return null;
    this.screenRecords.push({ phase: `after-${token.kind}`, ...screen }); this.activeTransition = null; return screen;
  }
  streamEvidence(redactions = []) {
    const clean = value => { let text = value; for (const secret of redactions.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('*'.repeat(secret.length)); return text.replace(/[?&](?:token|sessionToken|access_token)=[^\s&]+/gi, match => '*'.repeat(match.length)); };
    // Redact the complete stream before splitting at its original event offsets,
    // so a generated secret split across WebSocket events cannot escape masking.
    const content = clean(this.frames.map(frame => frame.data).join('')); let offset = 0;
    const frames = this.frames.map(frame => { const data = content.slice(offset, offset + frame.data.length); offset += frame.data.length; return { sequence: frame.sequence, data }; });
    return { expectedSessionId: this.sessionId, completeReplay: this.completeReplay, originalReplayBytes: this.replayBytes, maximumReplayBytes, geometry: this.geometry, initialGeometry: selectedGeometry(this.initialGeometry), browserGeometry: this.browserGeometry, geometryObservation: this.geometryObservation, frames, screens: this.screenRecords.map(screen => ({ ...screen, text: clean(screen.text) })), currentScreen: this.lastScreen ? { ...this.lastScreen, text: clean(this.lastScreen.text) } : null };
  }
  seal(response) { assert.equal(this.live(response), true, 'UI success requires a final fresh live API/WS session.'); assert.equal(this.activeTransition, null, 'A terminal transition remains unverified.'); if (this.geometry) assert.deepEqual(this.observeGeometry(response, 'final-api-seal'), this.geometry, 'Final terminal geometry must match the pre-input baseline.'); this.sealed = true; }
  diagnostic(redactions = []) {
    let excerpt = this.events.map(event => event.text).join('').slice(-6000);
    for (const secret of redactions.filter(Boolean).sort((a, b) => b.length - a.length)) excerpt = excerpt.split(secret).join('[redacted]');
    excerpt = excerpt.replace(/([?&](?:token|sessionToken|access_token)=)[^\s&]+/gi, '$1[redacted]');
    return { expectedSessionId: this.sessionId, currentSession: this.session, websocket: { state: this.wsState, status: this.status, exitCode: this.exitCode ?? null, closeCode: this.closeCode ?? null, fatal: this.fatal }, outputEvents: this.sequence, sealed: this.sealed, initialGeometry: selectedGeometry(this.initialGeometry), browserGeometry: this.browserGeometry, geometryObservation: this.geometryObservation, syntheticTerminalExcerpt: excerpt };
  }
}
export function assertBrowserTerminal(state, paneId) {
  assert(state && state.paneId === paneId, 'The rendered terminal must belong to the tested pane.');
  assert.equal(state.status, 'attached', 'The tested browser terminal must be currently attached.');
  assert.equal(state.hasSession, 'true'); assert.equal(state.hasWebsocket, 'true'); assert.equal(state.hasError, 'false');
  assert(state.width > 0, 'The matching live terminal must actually render.');
}
