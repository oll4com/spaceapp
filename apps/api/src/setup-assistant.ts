import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SpaceStore } from "@space/runtime";
import { readSetupAssistantProof } from "./installation-handoff.js";
import { readVerifiedFreeModel } from "./verified-free-model.js";
import { isolatedOpenCodeEnvironment, listFreeModels, openCodeExecutor, openCodeRunText, parseFreeModelCatalog } from "@space/opencode-control";

const credentialValue = /(?:sk-[a-zA-Z0-9_-]{12,}|AKIA[A-Z0-9]{16}|(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[=:]\s*\S+)/i;
const questionSchema = z.string().trim().min(1).max(1200).refine(value => !credentialValue.test(value), "Keep credentials in their dedicated connection forms.");
const responseSchema = z.object({ message: z.string().trim().min(1).max(1800).refine(value => !credentialValue.test(value)) }).strict();
const unavailable = { available: false as const, modelId: null, message: "The setup assistant is unavailable. Minimal starts with the free OpenCode assistant. Select only the tools you need; Live can be skipped without a provider connection." };
type Options = { store: SpaceStore; memoryRoot?: string; handoffRoot?: string; installationSecret?: string; scratchRoot: string; command?: string; signal?: AbortSignal;
  /** A public install has no OpenCode in core (1.1.7 decision B): the CLI container's OpenCode answers through the credential agent. */
  openCodeText?: (modelId: string, prompt: string, timeoutMs: number, signal?: AbortSignal) => Promise<string | null>;
  openCodeModels?: (provider: string) => Promise<string> };

/** Conversation uses only selected IDs/statuses and the authenticated allowlisted installation projection. */
export async function answerSetupQuestion(options: Options & { ownerId: string }, question: string) {
  const safeQuestion = questionSchema.parse(question);
  const [modelId, handoff, state] = await Promise.all([
    readVerifiedFreeModel(options.memoryRoot), readSetupAssistantProof(options.handoffRoot, options.memoryRoot, options.installationSecret, true),
    options.store.getSetupExecutionState(options.ownerId)
  ]);
  if (!modelId || !handoff?.completed) return unavailable;
  const currentRun = state?.runs.at(-1);
  // An upgraded installation's check ran after the upgrade, not before Docker (review 2026-10-21 #7).
  const context = { guidanceVersion: "first-setup:v2", modelId, installation: handoff.notes ?? null,
    assistantCheck: handoff.source === "INSTALLER" ? "before Docker setup" : "by setup after installation; no check ran before Docker setup",
    selection: state?.draft ? { persona: state.draft.persona, level: state.draft.level,
      featureIds: state.draft.requestedFeatureIds } : null,
    run: currentRun ? { status: currentRun.status,
      tasks: state!.tasks.filter(task => task.runId === currentRun.id).map(task => ({ featureId: task.featureId, actionId: task.actionId, status: task.status })) } : null };
  const prompt = "You are the SpaceApp setup assistant. Reply in English with only JSON containing message, a concise plain-text explanation. " +
    "Explain the current setup choices and progress. Minimal starts with free OpenCode; hardware profiles differ from UI levels. " +
    "Live is optional: credentials belong only in the dedicated secure connection form, or use Skip Live. " +
    "You cannot perform actions. Do not request secrets, run tools, propose commands or claim unverified readiness. " +
    `Safe installation state: ${JSON.stringify(context)}. User question: ${JSON.stringify(safeQuestion)}`;
  const respond = (answer: string | null) => {
    if (!answer || options.signal?.aborted) return null;
    // Some free models wrap the JSON in a ```json fence.
    const parsed = responseSchema.safeParse(JSON.parse(answer.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/, "$1")));
    return parsed.success ? parsed.data.message : null;
  };
  try {
    let message: string | null;
    if (options.openCodeText && options.openCodeModels) {
      if (!parseFreeModelCatalog(await options.openCodeModels("opencode")).includes(modelId)) return unavailable;
      message = respond(await options.openCodeText(modelId, prompt, 25_000, options.signal));
    } else message = await answerLocally(options, modelId, prompt, respond);
    if (!message || await readVerifiedFreeModel(options.memoryRoot) !== modelId) return unavailable;
    return { available: true as const, modelId, message };
  } catch { return unavailable; }
}

/** Space's own installation runs OpenCode here, in a throwaway home. */
async function answerLocally(options: Options, modelId: string, prompt: string, respond: (answer: string | null) => string | null) {
  await mkdir(options.scratchRoot, { recursive: true, mode: 0o700 });
  const { directory, env, work } = await isolatedOpenCodeEnvironment(options.scratchRoot);
  try {
    // OpenCode 2 reads its throwaway home's config: only read, in an empty folder. Zen refuses its free tier when every
    // tool is denied (2.0.32, 2026-10-20), and a custom OPENCODE_CONFIG path is refused too.
    await mkdir(join(env.XDG_CONFIG_HOME!, "opencode"), { recursive: true, mode: 0o700 });
    await writeFile(join(env.XDG_CONFIG_HOME!, "opencode", "opencode.json"), JSON.stringify({ permission: { "*": "deny", read: "allow" } }), { mode: 0o600 });
    const execute = openCodeExecutor(options.command ?? "/usr/local/bin/opencode");
    if (!(await listFreeModels({ env, cwd: work, execute, timeoutMs: 10_000, signal: options.signal })).includes(modelId)) return null;
    return respond(openCodeRunText(await execute(["run", "--standalone", "--format", "json", "--model", modelId, prompt],
      { env, cwd: work, timeoutMs: 25_000, signal: options.signal })));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function registerSetupAssistantRoutes(app: FastifyInstance, options: Options & { uiOrigin?: string }) {
  let active = false;
  app.post("/api/setup/assistant", { bodyLimit: 2048, config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (request, reply) => {
    const expected = `${request.protocol}://${request.host}`;
    if (request.user?.role !== "ADMIN" || request.user.automationScope || request.user.proofScope === "READ_ONLY" ||
      request.headers.origin !== expected && (!options.uiOrigin || request.headers.origin !== options.uiOrigin)) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "An interactive owner on this installation is required." } });
    }
    const input = z.object({ question: questionSchema }).strict().safeParse(request.body);
    if (!input.success) return reply.code(422).send({ error: { code: "SETUP_ASSISTANT_QUESTION_INVALID", message: "Ask a short setup question. Keep credentials in their dedicated connection forms." } });
    if (active) return reply.code(409).send({ error: { code: "SETUP_ASSISTANT_BUSY", message: "The setup assistant is answering a question. Try again shortly." } });
    active = true;
    const controller = new AbortController();
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.once("close", disconnect);
    try { return await answerSetupQuestion({ ...options, ownerId: request.user.id, signal: controller.signal }, input.data.question); }
    catch { return unavailable; }
    finally { active = false; reply.raw.removeListener("close", disconnect); }
  });
}
