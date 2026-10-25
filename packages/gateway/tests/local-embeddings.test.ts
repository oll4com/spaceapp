import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool } from "../src/accounts/account-pool.js";
import { generateGatewayApiKey } from "../src/api-keys.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { LOCAL_EMBEDDING_MODELS, LocalEmbeddings } from "../src/providers/local/embeddings.js";
import { apiKeyRefresher, registerEmbeddingsRoute } from "../src/providers/openai-api/embeddings-proxy.js";
import { RequestLogWriter } from "../src/request-log-writer.js";
import { createGatewayServer } from "../src/server.js";

// The real weights and Python environment of this host (scripts/space-local-embeddings-setup.mjs); without them only the refusals run.
const modelsDir = process.env.SPACE_LOCAL_MODELS_DIR ?? "/opt/spaceapp/var/models";
const bge = LOCAL_EMBEDDING_MODELS.get("bge-m3")!;
const installed = existsSync(join(modelsDir, "venv/bin/python3")) && existsSync(join(modelsDir, "bge-m3", bge.revision, bge.model.path));
const instances: LocalEmbeddings[] = [];
afterAll(() => { for (const local of instances) local.close(); });

async function setup(local: LocalEmbeddings) {
  instances.push(local);
  const repository = new InMemoryGatewayRepository();
  const cipher = createCredentialCipher(Buffer.alloc(32, 6));
  const pool = new AccountPool({ provider: "OPENAI_API", repository, cipher: () => cipher, refresher: apiKeyRefresher });
  const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
  await repository.createApiKey({ keyId: `gw_key:${"9".repeat(32)}`, name: "space-gateway-internal", keyHash, keyPrefix, trafficClass: "BACKGROUND", allowedModels: [],
    enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null, limits: [], expiresAt: null, createdBy: null });
  const logs = new RequestLogWriter(repository, { intervalMs: 1 });
  const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => true,
    routes: (app, helpers) => registerEmbeddingsRoute(app, helpers, { pool, local, logs, settings: () => repository.getSettings(),
      fetchImpl: (() => { throw new Error("A local model never calls out."); }) as unknown as typeof fetch }) });
  return (payload: Record<string, unknown>) => server.app.inject({ method: "POST", url: "/v1/embeddings", headers: { authorization: `Bearer ${plainKey}` }, payload });
}

const cosine = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);

describe("local embedding models", () => {
  it("refuses a model that is not installed, dimensions below the model's, and never takes prototype names for a model", async () => {
    const embed = await setup(new LocalEmbeddings({ modelsDir: "/nonexistent/space-models" }));
    const missing = await embed({ model: "bge-m3", input: "Space Memory", dimensions: 1536 });
    expect(missing.statusCode).toBe(503);
    expect(missing.json()).toMatchObject({ error: { code: "model_unavailable" } });
    expect((await embed({ model: "bge-m3", input: "Space Memory", dimensions: 512 })).json()).toMatchObject({ error: { code: "invalid_request" } });
    expect((await embed({ model: "bge-m3", input: [] })).statusCode).toBe(400);
    // Not a local model: it goes to the OpenAI key pool, which has no account here.
    expect((await embed({ model: "constructor", input: "x" })).statusCode).toBe(503);
  });

  it.skipIf(!installed)("embeds Greek and English on this server's CPU, unit length, zero-padded to the 1536 column", async () => {
    const embed = await setup(new LocalEmbeddings({ modelsDir }));
    const docs = await embed({ model: "bge-m3", dimensions: 1536, task_type: "RETRIEVAL_DOCUMENT", input: [
      "Space Memory embeddings now run on a local model in Space Gateway, without OpenAI credits.",
      "The Vibe Music player keeps playing in the background on phones.",
      "Ο Space Gateway μοιράζει τα αιτήματα στους λογαριασμούς Codex και Claude."
    ] });
    expect(docs.statusCode).toBe(200);
    const payload = docs.json() as { model: string; data: { index: number; embedding: number[] }[]; usage: { prompt_tokens: number } };
    expect(payload.model).toBe("bge-m3");
    expect(payload.data.map((row) => row.index)).toEqual([0, 1, 2]);
    expect(payload.usage.prompt_tokens).toBeGreaterThan(20);
    for (const { embedding } of payload.data) {
      expect(embedding).toHaveLength(1536);
      expect(embedding.slice(1024).every((value) => value === 0)).toBe(true);
      expect(Math.sqrt(cosine(embedding, embedding))).toBeCloseTo(1, 4);
    }
    const query = await embed({ model: "bge-m3", dimensions: 1536, task_type: "RETRIEVAL_QUERY", input: "Πού τρέχουν τώρα τα embeddings της μνήμης;" });
    const [memory, music, gateway] = payload.data.map((row) => cosine(row.embedding, (query.json() as typeof payload).data[0]!.embedding));
    // A Greek question finds the English memory it is about.
    expect(memory!).toBeGreaterThan(music!);
    expect(memory!).toBeGreaterThan(gateway!);
  }, 120_000);
});
