/** Keep results, including in-flight results, for the lifetime of a Live session. */
export function createLiveToolReplay(capacity = 4096) {
  const calls = new Map<string, { signature: string; result: Promise<string> }>();
  return {
    has: (id: string) => calls.has(id),
    run(id: string, name: string, args: string, execute: () => Promise<string>): Promise<string> {
      const signature = JSON.stringify([name, JSON.parse(args)]);
      const prior = calls.get(id);
      if (prior) {
        if (prior.signature !== signature) return Promise.resolve(JSON.stringify({ ok: false, code: "LIVE_CALL_ID_CONFLICT" }));
        return prior.result;
      }
      if (calls.size >= capacity) return Promise.resolve(JSON.stringify({ ok: false, code: "LIVE_CALL_LIMIT" }));
      const result = Promise.resolve().then(execute);
      calls.set(id, { signature, result });
      return result;
    }
  };
}
