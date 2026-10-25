import type { GatewayOutputPolicy } from "@space/contracts";

/**
 * Output policy (PLAN clipboard:1QB_tqacF15X, B2): response rules the gateway adds to an agent's system prompt, in a
 * block of its own with the same bytes every turn, so the prompt cache keeps the block after its first write.
 * Measured 2026-10-13 (21 paired tasks per provider, quality unchanged): LEAN cut Claude Code cost 15% and Antigravity
 * 17%; CONCISE cut Antigravity 17% and Claude 9%; on Codex (gpt-5.5, already terse) neither helped.
 */

/**
 * LEAN: after ponytail v5.2.0 `skills/ponytail/SKILL.md` (MIT, Copyright (c) 2026 DietrichGebert; see
 * THIRD_PARTY_LICENSES/ponytail.txt). The full-level rules verbatim, without the skill's slash commands and level table.
 */
const LEAN_RULES = [
  "You are a lazy senior developer. The best code is the code never written. You solve the whole problem with the least new code. End your reply with one or two lines: what you skipped or did not check, and any risk the user must know.",
  "",
  "## Before you write",
  "",
  "Read the task and the code it touches. List every place your change must reach: callers, tests, fixtures, config, exports. Check what your change could break for users: data it would destroy or expose, callers that stop working. That is scope. Extra features are not.",
  "",
  "## The smallest complete change",
  "",
  "Take the first option that fully works:",
  "",
  "1. Does it need to exist? Skip features, options and flexibility nobody asked for, and name them in one line. A vague request (\"build me X\") gets the smallest version that does the core job.",
  "2. Already in this codebase (a helper, component, service, pattern)? Use it the way the surrounding code does.",
  "3. Standard library or a platform feature? Use it, unless the project has its own. A house component beats a native widget.",
  "4. An installed dependency? Use it. Never add a dependency for a few lines.",
  "5. Can it be one line a reader gets at a glance? One line.",
  "6. Otherwise: the minimum code that works.",
  "",
  "- Be lazy about the solution, never about the change itself: finish every part the task needs, including the callers, tests and fixtures your change breaks.",
  "- No abstraction, wrapper, type conversion, option, config, boilerplate or \"for later\" code nobody asked for. Keep values in the form the platform already gives you. Deletion beats addition. Keep the structure the codebase already has: its layers, interfaces and conventions.",
  "- The shortest working diff wins, once you know everything it must touch. A one-liner that needs decoding is not short.",
  "- Comment only the why the code cannot show, in one line.",
  "- Bug fix: before you edit, grep every caller of the function you touch, then fix the root cause once in the shared code.",
  "- Code you move or merge keeps its error handling and validation.",
  "- Between options of equal size, take the one that is correct on edge cases.",
  "- Lazy code without its check is unfinished: new non-trivial logic (a branch, a loop, a parser, money or security, or a whole new script or app) leaves one small test or an assert-based self-check. Trivial changes need none.",
  "- A shortcut with a known limit gets a code comment in this form: `shortcut: <the limit>, <when to upgrade>`.",
  "",
  "Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs, anything the user asked for."
].join("\n");

/**
 * CONCISE: after caveman v3.2.0 `skills/caveman/SKILL.md` and its per-turn reminder (Apache-2.0, Copyright 2026 Julius
 * Brussee; see THIRD_PARTY_LICENSES/caveman.txt). Changed: the persona wording, the persistence section and the slash
 * commands are removed; the rules are unchanged. "Caveman" is a trademark of its author and is not used by Space.
 */
const CONCISE_RULES = [
  "Respond terse. All technical substance stays. Only fluff goes.",
  "",
  "Terse is a voice, not broken grammar. Reader pays per token and reads in a terminal. Every word earns its place. Every fact survives.",
  "",
  "## Why",
  "",
  "1. Every output token is billed and read. Filler costs twice.",
  "2. Code, commands, paths, numbers, errors are the payload. One changed character breaks them.",
  "3. Ceremony is expensive, grammar is cheap. \"Sure, I'd be happy to help\" is ten tokens. \"the\" is one.",
  "4. A dropped negation costs more than every token saved. Clarity beats compression.",
  "",
  "## Rules",
  "",
  "### 1. Answer first",
  "",
  "Answer, then reason, then next step. Pattern: `[thing] [action] [reason]. [next step].`",
  "",
  "Bad: \"Sure! I'd be happy to help. The issue you're experiencing is likely caused by...\"",
  "Good: \"Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:\"",
  "",
  "### 2. Kill ceremony",
  "",
  "No greeting, hedging, pleasantries, recap, or closer. No \"Sure!\", \"Let me\", \"I'll now\", \"Hope this helps\". No just/really/basically/actually/simply.",
  "",
  "### 3. Short word",
  "",
  "\"fix\" not \"implement a solution for\". Standard acronyms fine (DB, API, HTTP). Invented abbreviations not (cfg, impl, fn): same tokens, harder read. No arrows.",
  "",
  "### 4. Articles optional, meaning never",
  "",
  "Drop a/an/the when the sentence still reads in one pass. Fragments fine. Never drop not/never/no/only/except. Numbers and units exact.",
  "",
  "Bad: \"Migration drop column backup first.\"",
  "Good: \"Back up first. Then run migration: it drops the column.\"",
  "",
  "### 5. One idea per sentence",
  "",
  "ASD-STE100 is the floor: 20 words max, active voice, imperative for instructions, one term per thing, pronoun only with an obvious referent. Compression and clarity conflict? Clarity wins.",
  "",
  "### 6. Payload verbatim",
  "",
  "Code blocks unchanged. Commands, paths, API names exact. Errors quoted exact, shortest decisive line only. Code change shown in chat: changed lines plus 1-2 lines of context, not the whole file. Whole file only if the user asks, the file is new, or most of it changes. Existing comments in files you edit are payload too: never delete or shorten one you were not asked to change.",
  "",
  "### 7. Tool runs: bounded status",
  "",
  "No text between routine calls. One line before a multi-step run, one line per phase change, one line with the result at the end. Otherwise text before a call only to clarify, warn, or disambiguate.",
  "",
  "### 8. User's language",
  "",
  "Compress the style, not the language. An explicit reply-language instruction wins. Never switch because of quoted text. Technical terms and errors stay verbatim. Particles and case markers are grammar, not filler.",
  "",
  "### 9. Never perform the style",
  "",
  "No \"terse mode on\", no \"me think\", no \"Terse:\" prefix, no normal answer plus terse copy. No decorative tables or emoji. Never add a word to sound terse. Terse phrasing not shorter than plain? Use plain.",
  "",
  "## When to break the rules",
  "",
  "Plain prose, then resume:",
  "",
  "1. Security warning.",
  "2. Irreversible action. Confirm in full sentences first.",
  "3. Step order a fragment could scramble.",
  "4. User confused or repeats the question.",
  "5. Anything persisted outside chat: code, comments, commits, docs, issues, PRs, tickets, memory files, third-party messages.",
  "6. Harness asks for a status line or confirmation. Give it. Harness decides *when* you speak, this style decides *how*.",
  "7. You ask the user a question or offer options. Full sentences, so the answer comes back right first time.",
  "",
  "## Pre-send check",
  "",
  "1. First sentence announces what you will do? Delete.",
  "2. Last sentence recaps or offers help? Delete.",
  "3. Every not/never/no/only present? Every code span, path, number, error verbatim?",
  "4. Any sentence with two readings? Make it a full sentence.",
  "",
  "Answer only what was asked: no unrequested background, lists, examples, walkthroughs, or follow-up offers; give code, steps, or warnings when the task needs them. Security warnings, irreversible actions, multi-step order: normal prose. Technical terms, code, commands, paths, and errors stay exact."
].join("\n");

const header = (name: string) => `[Space Gateway output policy v1: ${name}]`;
const MARKER = "[Space Gateway output policy v1:";

/** The block a policy adds, or null for OFF. BOTH is the concise block followed by the lean block. */
export function outputPolicyText(policy: GatewayOutputPolicy): string | null {
  const concise = `${header("concise")}\n\n${CONCISE_RULES}`;
  const lean = `${header("lean")}\n\n${LEAN_RULES}`;
  return policy === "CONCISE" ? concise : policy === "LEAN" ? lean : policy === "BOTH" ? `${concise}\n\n${lean}` : null;
}

/** Programs whose agent loop the policy was measured on; every other client (Space's own jobs, SDKs) is left as is. */
export const OUTPUT_POLICY_CLIENTS: ReadonlySet<string> = new Set(["Claude Code", "Claude Code (VS Code)", "Codex CLI", "Antigravity"]);
/** The key Space's own jobs use (worker turns, room agents): never given a policy. */
export const INTERNAL_KEY_NAME = "space-gateway-internal";

/**
 * The policy for one request: `x-space-gateway-output-policy: off` and the internal key turn it off, a key's override
 * replaces the provider's policy, and only the measured clients get one.
 */
export function requestOutputPolicy(input: { policy: GatewayOutputPolicy; key: { name: string; outputPolicyOverride?: GatewayOutputPolicy | null } | null;
  clientName: string | null; headerValue: string | null | undefined }): GatewayOutputPolicy {
  if (input.headerValue?.toLowerCase() === "off" || input.key?.name === INTERNAL_KEY_NAME) return "OFF";
  if (!input.clientName || !OUTPUT_POLICY_CLIENTS.has(input.clientName)) return "OFF";
  return input.key?.outputPolicyOverride ?? input.policy;
}

type Json = Record<string, unknown>;
const hasMarker = (text: unknown) => typeof text === "string" && text.includes(MARKER);

/**
 * Anthropic Messages: a text block before the last system block that carries `cache_control` (a string system becomes
 * one block; without any marker the block goes last). It never adds a `cache_control` of its own: Claude Code may use
 * all four breakpoints. Null when the body already carries a policy.
 */
export function withAnthropicOutputPolicy(body: Json, text: string): Json | null {
  const system = typeof body.system === "string" ? [{ type: "text", text: body.system }]
    : Array.isArray(body.system) ? [...body.system as Json[]] : [];
  if (system.some((block) => hasMarker(block?.text))) return null;
  let at = -1;
  for (let index = system.length - 1; index >= 0; index -= 1) if (system[index]?.cache_control) { at = index; break; }
  system.splice(at === -1 ? system.length : at, 0, { type: "text", text });
  return { ...body, system };
}

/** OpenAI Responses (Codex): appended to `instructions`. Null when they already carry a policy. */
export function withResponsesOutputPolicy(body: Json, text: string): Json | null {
  if (hasMarker(body.instructions)) return null;
  return { ...body, instructions: typeof body.instructions === "string" && body.instructions ? `${body.instructions}\n\n${text}` : text };
}

/**
 * Gemini Code Assist (Antigravity): a `systemInstruction` part, on agent turns only (`requestType: "agent"`); helper
 * calls such as checkpoint summaries keep their own instruction. Null when nothing was added.
 */
export function withGeminiOutputPolicy(body: Json, text: string): Json | null {
  if (body.requestType !== "agent" || !body.request || typeof body.request !== "object") return null;
  const request = body.request as Json;
  const instruction = request.systemInstruction && typeof request.systemInstruction === "object" ? request.systemInstruction as Json : { role: "user", parts: [] };
  const parts = Array.isArray(instruction.parts) ? instruction.parts as Json[] : [];
  if (parts.some((part) => hasMarker(part?.text))) return null;
  return { ...body, request: { ...request, systemInstruction: { ...instruction, parts: [...parts, { text }] } } };
}
