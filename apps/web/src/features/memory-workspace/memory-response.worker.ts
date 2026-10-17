import { yieldMemoryWork } from "./memory-yield.js";
self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const raw = new TextDecoder().decode(event.data);
    let value;
    try { value = JSON.parse(raw); } catch { self.postMessage({ value: raw }); return; }
    if (!Array.isArray(value?.data?.nodes) || !Array.isArray(value?.data?.edges)) { self.postMessage({ value }); return; }
    const { nodes, edges, ...metadata } = value.data;
    for (let i = 0; i < nodes.length; i += 1000) {
      self.postMessage({ nodes: nodes.slice(i, i + 1000) });
      await yieldMemoryWork();
    }
    for (let i = 0; i < edges.length; i += 2000) {
      self.postMessage({ edges: edges.slice(i, i + 2000) });
      await yieldMemoryWork();
    }
    self.postMessage({ value: { ...value, data: metadata }, graph: true });
  } catch { self.postMessage({ error: "Memory response could not be decoded." }); }
};
export {};
