import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { delay, sameProcess } from './processes.mjs';
import { reloadObservation } from './reload-proof-channel.mjs';
export { reloadObservation };

const names = ['api', 'cli-host', 'web', 'worker'];
const identity = value => value && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.identity === 'string' && value.identity.length > 0;

const idle = value => !value.stopping && value.pending === null && value.queued === null && value.active === null && value.requested === value.completed;
function children(record) {
  assert(Array.isArray(record.children) && record.children.length === names.length, 'Idle reload receipt needs every source child.');
  const selected = names.map(name => {
    const matches = record.children.filter(item => item.name === name);
    assert(matches.length === 1 && identity(matches[0]), 'Idle reload receipt has missing, duplicate or unverified children.');
    return { name, pid: matches[0].pid, identity: matches[0].identity };
  });
  assert(new Set(selected.map(item => item.pid)).size === names.length, 'Idle reload receipt has duplicate process IDs.');
  return selected;
}

/**
 * Join a known source edit to a later completed, live service generation within
 * the existing proof deadline. Compare the same idle receipt/identities around
 * fresh HTTP readiness and exact expected bytes. This never collects, adopts,
 * retries or suppresses descendant identity failures in the later lifecycle proof.
 * Callers restore watched sources in finally blocks before awaiting this join.
 */
export async function restorationCheckpoint({ observe, nonce, supervisor, before = null, changed = [], files = [], ready, live = sameProcess, timeout = 120000, until, now = Date.now, pause = delay, label = 'Source restoration' }) {
  assert(typeof nonce === 'string' && nonce.length > 0 && [120000, 300000].includes(timeout), 'Invalid restoration proof boundary.');
  assert(until === undefined || Number.isFinite(until), 'Invalid restoration deadline.');
  assert(changed.every(name => names.includes(name)) && (changed.length === 0 || before), 'Changed identities require a prior checkpoint.');
  const bound = supervisor || before, challenges = new Set(), deadline = Math.min(until ?? Infinity, now() + timeout);
  assert(identity(bound) && typeof observe === 'function', 'A bound live reload proof channel is required; no file-only fallback.');
  let previous = before?.reload;
  const read = async () => {
    const challenge = randomUUID(); assert(!challenges.has(challenge), 'A new reload proof challenge is required.'); challenges.add(challenge);
    const reply = await observe({ challenge }, Math.max(1, deadline - now()));
    assert(reply?.version === 1 && reply.challenge === challenge && reply.nonce === nonce && reply.pid === bound.pid && reply.identity === bound.identity && await live(bound), 'Reload proof response is foreign, stale or unbound.');
    assert(['OK', 'BUSY'].includes(reply.status), 'Reload proof response failed.');
    if (reply.status === 'BUSY') { assert.equal(reply.snapshot, null, 'A busy response must not offer a stale snapshot.'); return null; }
    const record = reply.snapshot;
    assert(record?.nonce === nonce && identity(record), 'Restoration supervisor ownership/identity is missing.');
    assert(record.pid === bound.pid && record.identity === bound.identity && await live(record), 'Restoration supervisor identity changed.');
    const reload = reloadObservation(record.reload);
    assert(!reload.stopping, 'Restoration supervisor is stopping.');
    if (previous) {
      assert(reload.revision >= previous.revision && reload.requested >= previous.requested && reload.completed >= previous.completed, 'Reload receipt moved backwards.');
      assert(reload.revision !== previous.revision || JSON.stringify(reload) === JSON.stringify(previous), 'Reload receipt changed without a new revision.');
    }
    previous = reload;
    return { nonce, pid: record.pid, identity: record.identity, reload, children: record.children, proofRequest: challenge };
  };
  const assertLive = async items => {
    for (const item of items) assert(await live(item), 'Idle restored child identity changed.');
  };
  while (now() < deadline) {
    const first = await read();
    if (first && idle(first.reload) && (!before || first.reload.completed > before.reload.requested)) {
      first.children = children(first);
      const distinct = changed.every(name => {
        const old = before.children.find(item => item.name === name), next = first.children.find(item => item.name === name);
        // Darwin lstart has second resolution: the identity is the PID/birth pair.
        return old && next.pid !== old.pid;
      });
      if (distinct) {
        await assertLive(first.children);
        const readyNow = await ready();
        const observed = [];
        let matching = true;
        for (const file of files) {
          const bytes = Buffer.from(await file.read());
          matching &&= (file.expected === undefined || bytes.equals(Buffer.from(file.expected))) && (file.includes === undefined || bytes.includes(file.includes)) && (file.forbidden === undefined || !bytes.includes(file.forbidden));
          observed.push({ name: file.name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
        const second = await read();
        if (second && idle(second.reload)) {
          second.children = children(second);
          if (JSON.stringify(first.reload) === JSON.stringify(second.reload)) {
            assert.deepEqual(second.children, first.children, 'Children changed inside the same idle reload receipt.');
            await assertLive(second.children);
            if (readyNow === true && matching && now() < deadline) return { ...second, proofRequests: [first.proofRequest, second.proofRequest], ready: true, files: observed };
          }
        }
      }
    }
    await pause(400);
  }
  throw new Error(`${label} exceeded its existing ${timeout / 1000}s proof bound; no restored handoff is accepted.`);
}
