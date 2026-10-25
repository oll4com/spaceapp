import { parentPort } from "node:worker_threads";
import { createCompressors, initCompressors } from "./compressors.js";
import { compressBlock, type BlockOptions } from "./engine.js";
import { countO200k, createTokenCounter, type TokenizerKind } from "./tokenizer.js";

/** Compression worker: runs one block at a time off the gateway's event loop. */
const compressors = createCompressors();
const counters = { o200k: createTokenCounter("o200k"), claude: createTokenCounter("claude"), gemini: createTokenCounter("gemini") };
// Load the tiktoken ranks and the tree-sitter grammars now, so the first request does not wait for them.
countO200k("warm up");
await initCompressors();
parentPort?.on("message", (job: { id: number; text: string; tokenizer?: TokenizerKind } & BlockOptions) => {
  try {
    const options: BlockOptions = { ...(job.codeText ? { codeText: job.codeText, lossy: job.lossy ?? false } : {}), ...(job.exact ? { exact: true } : {}) };
    parentPort!.postMessage({ id: job.id, ...compressBlock(job.text, compressors, counters[job.tokenizer ?? "o200k"], undefined, options) });
  } catch (error) {
    parentPort!.postMessage({ id: job.id, failure: error instanceof Error ? error.message : String(error) });
  }
});
parentPort?.postMessage({ ready: true });
