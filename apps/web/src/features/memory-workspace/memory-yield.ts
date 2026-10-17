/** Give input/paint a new task without timer-clamp delays between graph batches. */
export function yieldMemoryWork(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  if (typeof MessageChannel === "undefined") return new Promise(resolve => setTimeout(resolve, 0));
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(null);
  });
}
