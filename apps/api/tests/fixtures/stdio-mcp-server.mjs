import readline from "node:readline";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2] ?? "ok";
const callCountPath = process.argv[3] ?? "";
const evidencePath = process.argv[4] ?? "";
const liveListCloseLimit = Math.max(1, Number(process.argv[5] ?? "1") || 1);
const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
let toolsCallSeen = false;
let statefulCounter = 0;
let dynamicToolAvailable = false;
const leakLabel = ["to", "ken"].join("");
const leakValue = "raw-credential-value-that-must-not-leak";

if ((mode === "call-ok-count-start" || mode === "catalog-list-change" || mode === "close-after-call-count-start" || mode === "close-on-live-list-count-start") && callCountPath) {
  appendFileSync(callCountPath, "start\n");
}
if (mode === "env-check" && evidencePath) {
  writeFileSync(evidencePath, JSON.stringify({
    allowedSession: process.env.CODEX_MCP_SESSION_ID ?? null,
    tempRoot: process.env.TMPDIR ?? null,
    tempAliasesMatch: process.env.TMPDIR === process.env.TEMP && process.env.TMPDIR === process.env.TMP,
    devtoolsTempBase: process.env.CODEX_MCP_TMP_BASE ?? null,
    bearerTokenPresent: Object.hasOwn(process.env, "SPACE_HEAVY_MCP_BEARER_TOKEN"),
    forbiddenSecretPresent: Object.hasOwn(process.env, "SPACE_GATEWAY_FORBIDDEN_SECRET")
  }));
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(id, code, message) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  });
}

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    sendError(null, -32700, "Parse error");
    return;
  }

  if (message.method === "initialize") {
    if (mode === "fail-init") {
      console.error("raw-token-value-that-must-not-leak");
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: "Initialization failed with raw-token-value-that-must-not-leak"
        }
      });
      return;
    }

    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: {
          prompts: { listChanged: mode === "catalog-list-change" },
          resources: { listChanged: mode === "catalog-list-change" },
          tools: { listChanged: mode === "catalog-list-change" }
        },
        serverInfo: {
          name: "space-test-mcp",
          version: "0.1.0"
        }
      }
    });
    return;
  }

  if (message.method === "notifications/initialized") {
    initialized = true;
    return;
  }

  if (message.method === "tools/list") {
    if (!initialized) {
      sendError(message.id, -32002, "Client did not send initialized notification");
      return;
    }
    if (mode === "close-on-first-list" && callCountPath) {
      try {
        if (readFileSync(callCountPath, "utf8") === "") {
          appendFileSync(callCountPath, "closed\n");
          process.exit(0);
        }
      } catch {
        appendFileSync(callCountPath, "closed\n");
        process.exit(0);
      }
    }
    if (mode === "close-on-live-list-count-start" && evidencePath) {
      try {
        const evidence = readFileSync(evidencePath, "utf8");
        const closeCount = evidence.trim() === "" ? 0 : evidence.trim().split("\n").length;
        if (evidence.trim() !== "skip" && closeCount < liveListCloseLimit) {
          appendFileSync(evidencePath, "closed\n");
          process.exit(0);
        }
      } catch {
        appendFileSync(evidencePath, "closed\n");
        process.exit(0);
      }
    }

    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "list_files",
            description: "List files without modifying them.",
            inputSchema: {
              type: "object",
              properties: {
                path: { type: "string" }
              },
              required: ["path"],
              additionalProperties: false
            }
          },
          ...(dynamicToolAvailable ? [{
            name: "dynamic_status",
            description: "Report dynamically available status.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false
            }
          }] : [])
        ]
      }
    });
    return;
  }

  if (message.method === "resources/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        resources: [
          {
            uri: "space-test://status",
            name: "Space test status",
            mimeType: "application/json"
          },
          ...(dynamicToolAvailable ? [{
            uri: "space-test://dynamic-status",
            name: "Dynamic Space test status",
            mimeType: "application/json"
          }] : [])
        ]
      }
    });
    return;
  }

  if (message.method === "resources/templates/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { resourceTemplates: [] } });
    return;
  }

  if (message.method === "resources/read") {
    if (mode === "close-on-read") {
      if (callCountPath) appendFileSync(callCountPath, "read\n");
      process.exit(0);
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        contents: [
          {
            uri: message.params?.uri ?? "space-test://status",
            mimeType: "application/json",
            text: JSON.stringify({ ok: true, state: "stable" })
          }
        ]
      }
    });
    return;
  }

  if (message.method === "prompts/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        prompts: [
          {
            name: "space_test_prompt",
            description: "Return a stable Space test prompt."
          },
          ...(dynamicToolAvailable ? [{
            name: "space_dynamic_prompt",
            description: "Return a dynamically available Space test prompt."
          }] : [])
        ]
      }
    });
    return;
  }

  if (message.method === "prompts/get") {
    if (mode === "close-on-prompt") {
      if (callCountPath) appendFileSync(callCountPath, "prompt\n");
      process.exit(0);
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        description: "Stable Space test prompt.",
        messages: [
          {
            role: "user",
            content: { type: "text", text: "stable" }
          }
        ]
      }
    });
    return;
  }

  if (message.method === "tools/call") {
    if (mode === "close-on-call") {
      if (callCountPath) appendFileSync(callCountPath, "call\n");
      process.exit(0);
    }
    if (mode === "slow-call") {
      if (callCountPath) appendFileSync(callCountPath, "call\n");
      setTimeout(() => send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: "slow call completed" }],
          isError: false
        }
      }), 400);
      return;
    }
    if (mode === "call-ok" || mode === "call-ok-count-start" || mode === "env-check" || mode === "stateful-counter" || mode === "catalog-list-change" || mode === "close-after-call-count-start" || mode === "close-on-live-list-count-start") {
      statefulCounter += 1;
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: `listed ${message.params?.arguments?.path ?? "."}`
            }
          ],
          structuredContent: {
            ok: true,
            ...(mode === "stateful-counter" ? { counter: statefulCounter } : {}),
            receivedArguments: message.params?.arguments ?? {},
            diagnostic: `${leakLabel}: ${leakValue}`
          },
          isError: false
        }
      });
      if (mode === "catalog-list-change" && !dynamicToolAvailable) {
        dynamicToolAvailable = true;
        setTimeout(() => {
          for (const method of [
            "notifications/tools/list_changed",
            "notifications/resources/list_changed",
            "notifications/prompts/list_changed"
          ]) {
            send({ jsonrpc: "2.0", method });
          }
        }, 0);
      }
      if (mode === "close-after-call-count-start") setTimeout(() => process.exit(0), 0);
      return;
    }
    toolsCallSeen = true;
    sendError(message.id, -32003, "tools/call must not be used during discovery smoke");
    return;
  }

  sendError(message.id ?? null, -32601, "Method not found");
});

process.on("beforeExit", () => {
  if (toolsCallSeen) {
    process.exitCode = 2;
  }
});
