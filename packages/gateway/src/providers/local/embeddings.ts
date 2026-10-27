import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import models from "./local-embedding-models.json" with { type: "json" };

/**
 * Local embedding models on Space Gateway's `/v1/embeddings` (Space Memory plan clipboard:o7SATwaOHqca): no key, no cost, and
 * the text never leaves the server. Each model runs in its own Python process (space-local-embeddings.py, ONNX Runtime on the
 * CPU), so inference never blocks the gateway's event loop and a reload's new worker simply starts its own. The process starts
 * on the first request and then stays (about 1 GB): loading takes 5-7 seconds, too long for a query. Weights and the Python
 * environment live outside the repository in var/models (scripts/space-local-embeddings-setup.mjs), pinned by revision and SHA-256.
 */
export interface LocalEmbeddingModel {
  repo: string; revision: string;
  model: { path: string; sha256: string }; tokenizer: { path: string; sha256: string };
  dimensions: number; maxTokens: number; pooling: "cls" | "mean"; queryPrefix: string; documentPrefix: string;
}
export const LOCAL_EMBEDDING_MODELS = new Map(Object.entries(models as Record<string, LocalEmbeddingModel>));

/** Texts per worker call: a query goes to the front of the queue, so it never waits behind more than one chunk of a long batch. */
const CHUNK = 2;
const THREADS = 4;

/** The repository root, from the bundle (packages/gateway/dist) or from the sources (tests). */
const repoRoot = () => [new URL("../../../", import.meta.url), new URL("../../../../../", import.meta.url)].map((url) => fileURLToPath(url))
  .find((root) => existsSync(join(root, "packages/gateway/src/providers/local/space-local-embeddings.py"))) ?? process.cwd();

export class LocalModelUnavailable extends Error {}

type Result = { vectors: number[][]; tokens: number };
type Job = { texts: string[]; resolve: (result: Result) => void; reject: (error: Error) => void };

class ModelWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private queue: Job[] = [];
  private running: (Job & { id: number; timer: NodeJS.Timeout }) | null = null;
  private failedAt = 0;
  private nextId = 1;

  constructor(private readonly name: string, private readonly args: { python: string; script: string; files: string[]; argv: string[] }) {}

  run(texts: string[], urgent: boolean): Promise<Result> {
    return new Promise((resolve, reject) => {
      if (urgent) this.queue.unshift({ texts, resolve, reject }); else this.queue.push({ texts, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    if (!this.child && this.queue.length) this.start();
    if (!this.child || !this.ready || this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    const id = this.nextId++;
    // A worker that does not answer in time is stuck: it is replaced, and the queue goes on with a new one.
    const timer = setTimeout(() => { job.reject(new LocalModelUnavailable("The local embedding model timed out.")); this.running = null; this.stop(); },
      30_000 + 10_000 * job.texts.length);
    this.running = { ...job, id, timer };
    this.child.stdin.write(`${JSON.stringify({ id, texts: job.texts })}\n`);
  }

  private start() {
    if (Date.now() - this.failedAt < 30_000 || ![this.args.python, this.args.script, ...this.args.files].every((file) => existsSync(file))) {
      this.failAll(new LocalModelUnavailable(`The local embedding model ${this.name} is not installed or failed to start.`));
      return;
    }
    const child = spawn(this.args.python, ["-I", this.args.script, ...this.args.argv], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.ready = false;
    let lastError = "";
    child.stdin.on("error", () => undefined);
    child.stderr.on("data", (chunk: Buffer) => { lastError = chunk.toString("utf8").trim().split("\n").at(-1)!.slice(0, 300); });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: { ready?: boolean; id?: number; vectors?: number[][]; tokens?: number; error?: string };
      try { message = JSON.parse(line) as typeof message; } catch { return; }
      if (message.ready) { this.ready = true; this.pump(); return; }
      const running = this.running;
      if (!running || message.id !== running.id) return;
      clearTimeout(running.timer);
      this.running = null;
      if (message.vectors?.length === running.texts.length) running.resolve({ vectors: message.vectors, tokens: message.tokens ?? 0 });
      else running.reject(new Error(`The local embedding model failed (${message.error ?? "incomplete answer"}).`));
      this.pump();
    });
    child.on("error", () => undefined);
    child.on("exit", (code) => {
      if (this.child !== child) return;
      const started = this.ready;
      this.child = null;
      this.ready = false;
      if (this.running) {
        clearTimeout(this.running.timer);
        this.running.reject(new LocalModelUnavailable("The local embedding model stopped."));
        this.running = null;
      }
      if (!started) {
        this.failedAt = Date.now();
        process.stderr.write(`space-gateway local embeddings ${this.name} failed to start (exit ${code}): ${lastError}\n`);
        this.failAll(new LocalModelUnavailable(`The local embedding model ${this.name} failed to start.`));
      } else if (this.queue.length) {
        this.pump();
      }
    });
  }

  private failAll(error: Error) {
    for (const job of this.queue.splice(0)) job.reject(error);
  }

  stop() {
    this.child?.stdin.end();
    this.child?.kill("SIGTERM");
  }
}

export class LocalEmbeddings {
  private workers = new Map<string, ModelWorker>();
  constructor(private readonly options: { modelsDir?: string; python?: string } = {}) {}

  /** Unit vectors in input order, zero-padded to `dimensions` (cosine and inner product are unchanged, so they fit a wider column). */
  async embed(model: string, texts: string[], kind: "query" | "document", dimensions: number | null): Promise<Result> {
    const spec = LOCAL_EMBEDDING_MODELS.get(model);
    if (!spec) throw new LocalModelUnavailable(`Unknown local embedding model ${model}.`);
    const worker = this.worker(model, spec);
    const prefix = kind === "query" ? spec.queryPrefix : spec.documentPrefix;
    const chunks: string[][] = [];
    for (let start = 0; start < texts.length; start += CHUNK) chunks.push(texts.slice(start, start + CHUNK).map((text) => prefix + text));
    const results = await Promise.all(chunks.map((chunk) => worker.run(chunk, kind === "query")));
    const padding = new Array<number>(Math.max(0, (dimensions ?? spec.dimensions) - spec.dimensions)).fill(0);
    return { vectors: results.flatMap((result) => result.vectors).map((vector) => (padding.length ? [...vector, ...padding] : vector)),
      tokens: results.reduce((sum, result) => sum + result.tokens, 0) };
  }

  private worker(model: string, spec: LocalEmbeddingModel) {
    let worker = this.workers.get(model);
    if (!worker) {
      const modelsDir = this.options.modelsDir ?? join(repoRoot(), "var/models");
      const dir = join(modelsDir, model, spec.revision);
      const files = [join(dir, spec.model.path), join(dir, spec.tokenizer.path)];
      worker = new ModelWorker(model, {
        python: this.options.python ?? join(modelsDir, "venv/bin/python3"),
        script: join(repoRoot(), "packages/gateway/src/providers/local/space-local-embeddings.py"),
        files, argv: [...files, String(spec.maxTokens), spec.pooling, String(THREADS)]
      });
      this.workers.set(model, worker);
    }
    return worker;
  }

  close() {
    for (const worker of this.workers.values()) worker.stop();
  }
}
