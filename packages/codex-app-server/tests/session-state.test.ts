import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  buildCodexAppServerProcessEnv,
  type CodexAppServerStdioProcess,
  initialCodexAppServerTurnSessionState,
  isCodexAppServerTurnSessionComplete,
  parseCodexAppServerJsonRpcLine,
  reduceCodexAppServerTurnSessionState,
  runCodexAppServerStdioTurnSession
} from "../src/index.js";

function testCodexAppServerProcessEnv() {
  return buildCodexAppServerProcessEnv({
    baseEnv: {},
    codexHome: "/tmp/codex-app-server-test-home",
    credential: null
  });
}

const reduceOptions = {
  threadStartRequestId: 1,
  turnStartRequestId: 2
};

class FakeCodexAppServerProcess extends EventEmitter implements CodexAppServerStdioProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly writes: unknown[] = [];
  killed = false;

  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
        this.writes.push(message);
        this.respond(message);
      }
      return true;
    }
  };

  kill(): boolean {
    this.killed = true;
    return true;
  }

  private emitJson(message: unknown) {
    queueMicrotask(() => {
      this.stdout.emit("data", `${JSON.stringify(message)}\n`);
    });
  }

  private respond(message: { id?: number; method?: string; params?: Record<string, unknown> }) {
    if (message.method === "initialize") {
      this.emitJson({ id: message.id, result: { userAgent: "fake-codex" } });
    }
    if (message.method === "configRequirements/read") {
      this.emitJson({ id: message.id, result: { requirements: null } });
    }
    if (message.method === "thread/start") {
      this.emitJson({ id: message.id, result: { thread: { id: "thread:test-1" } } });
    }
    if (message.method === "thread/resume") {
      this.emitJson({ id: message.id, result: { thread: { id: message.params?.threadId } } });
    }
    if (message.method === "turn/start") {
      this.emitJson({ id: message.id, result: { turn: { id: "turn:test-1", status: "inProgress" } } });
      const threadId = typeof message.params?.threadId === "string" ? message.params.threadId : "thread:test-1";
      this.emitJson({
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: "turn:test-1",
            status: "completed",
            transcript: "do not persist this"
          }
        }
      });
    }
  }
}

class EarlyCompletedTurnProcess extends EventEmitter implements CodexAppServerStdioProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly writes: unknown[] = [];
  killed = false;

  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
        this.writes.push(message);
        this.respond(message);
      }
      return true;
    }
  };

  kill(): boolean {
    this.killed = true;
    return true;
  }

  private emitJson(message: unknown) {
    queueMicrotask(() => {
      this.stdout.emit("data", `${JSON.stringify(message)}\n`);
    });
  }

  private respond(message: { id?: number; method?: string; params?: Record<string, unknown> }) {
    if (message.method === "initialize") {
      this.emitJson({ id: message.id, result: { userAgent: "fake-codex" } });
    }
    if (message.method === "configRequirements/read") {
      this.emitJson({ id: message.id, result: { requirements: null } });
    }
    if (message.method === "thread/start") {
      this.emitJson({ id: message.id, result: { thread: { id: "thread:test-early-completed" } } });
    }
    if (message.method === "thread/resume") {
      this.emitJson({ id: message.id, result: { thread: { id: message.params?.threadId } } });
    }
    if (message.method === "turn/start") {
      this.emitJson({ id: message.id, result: { turn: { id: "turn:test-early-completed", status: "completed" } } });
      this.emitJson({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread:test-early-completed",
          turnId: "turn:test-early-completed",
          itemId: "item:test-message",
          delta: "SPACE_EARLY_COMPLETED_OK"
        }
      });
      this.emitJson({
        method: "item/completed",
        params: {
          threadId: "thread:test-early-completed",
          turnId: "turn:test-early-completed",
          item: {
            id: "item:test-message",
            type: "agentMessage",
            text: "SPACE_EARLY_COMPLETED_OK"
          }
        }
      });
      this.emitJson({
        method: "turn/completed",
        params: {
          threadId: "thread:test-early-completed",
          turn: {
            id: "turn:test-early-completed",
            status: "completed"
          }
        }
      });
    }
  }
}

describe("Codex App Server turn session state", () => {
  it("fails closed before spawning when the process environment is missing at runtime", async () => {
    let spawned = false;
    const options = {
      command: "codex",
      prompt: "must not spawn",
      spawnProcess: () => {
        spawned = true;
        return new FakeCodexAppServerProcess();
      }
    } as unknown as Parameters<typeof runCodexAppServerStdioTurnSession>[0];

    await expect(runCodexAppServerStdioTurnSession(options)).rejects.toThrow(
      "Codex App Server process environment is required."
    );
    expect(spawned).toBe(false);
  });

  it("fails closed before spawning when the environment did not come from the allowlist builder", async () => {
    let spawned = false;
    const options = {
      command: "codex",
      env: {
        PATH: "/usr/bin",
        SPACE_SESSION_SECRET: "session-secret-sentinel"
      },
      prompt: "must not spawn",
      spawnProcess: () => {
        spawned = true;
        return new FakeCodexAppServerProcess();
      }
    } as unknown as Parameters<typeof runCodexAppServerStdioTurnSession>[0];

    await expect(runCodexAppServerStdioTurnSession(options)).rejects.toThrow(
      "Codex App Server process environment must be built by the allowlist builder."
    );
    expect(spawned).toBe(false);
  });

  it("extracts sanitized ids and completion state from responses and notifications", () => {
    let state = initialCodexAppServerTurnSessionState();

    state = reduceCodexAppServerTurnSessionState(
      state,
      parseCodexAppServerJsonRpcLine('{"id":1,"result":{"thread":{"id":"thread:test-1"}}}'),
      reduceOptions
    );
    expect(state.threadId).toBe("thread:test-1");
    expect(state.notificationCount).toBe(0);

    state = reduceCodexAppServerTurnSessionState(
      state,
      {
        id: 2,
        result: {
          turn: {
            id: "turn:test-1",
            status: "inProgress"
          }
        }
      },
      reduceOptions
    );
    expect(state.turnId).toBe("turn:test-1");
    expect(state.turnStatus).toBe("inProgress");

    state = reduceCodexAppServerTurnSessionState(
      state,
      {
        method: "turn/completed",
        params: {
          threadId: "thread:test-1",
          turn: {
            id: "turn:test-1",
            status: "completed",
            ignoredTranscript: "do not persist this"
          }
        }
      },
      reduceOptions
    );

    expect(state).toMatchObject({
      threadId: "thread:test-1",
      turnId: "turn:test-1",
      turnStatus: "completed",
      notificationCount: 1,
      completedNotificationSeen: true
    });
    expect(isCodexAppServerTurnSessionComplete(state)).toBe(true);
    expect(JSON.stringify(state)).not.toContain("ignoredTranscript");
  });

  it("ignores unknown turn statuses and counts non-turn notifications without persisting payloads", () => {
    const state = reduceCodexAppServerTurnSessionState(
      initialCodexAppServerTurnSessionState(),
      {
        method: "item/completed",
        params: {
          item: {
            id: "item:test-1",
            text: "sensitive-ish content should not be copied"
          }
        }
      },
      reduceOptions
    );

    expect(state.notificationCount).toBe(1);
    expect(state.turnStatus).toBeNull();
    expect(JSON.stringify(state)).not.toContain("sensitive-ish");

    const invalidStatus = reduceCodexAppServerTurnSessionState(
      state,
      {
        id: 2,
        result: {
          turn: {
            id: "turn:test-2",
            status: "surprising"
          }
        }
      },
      reduceOptions
    );

    expect(invalidStatus.turnId).toBe("turn:test-2");
    expect(invalidStatus.turnStatus).toBeNull();
  });

  it("does not treat failed terminal notifications as successful completion", () => {
    const state = reduceCodexAppServerTurnSessionState(
      {
        ...initialCodexAppServerTurnSessionState(),
        threadId: "thread:test-1",
        turnId: "turn:test-1",
        turnStatus: "inProgress"
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread:test-1",
          turn: {
            id: "turn:test-1",
            status: "failed",
            transcript: "do not persist this"
          }
        }
      },
      reduceOptions
    );

    expect(state).toMatchObject({
      threadId: "thread:test-1",
      turnId: "turn:test-1",
      turnStatus: "failed",
      notificationCount: 1,
      completedNotificationSeen: true
    });
    expect(isCodexAppServerTurnSessionComplete(state)).toBe(false);
    expect(JSON.stringify(state)).not.toContain("do not persist this");
  });

  it("runs a stdio thread and turn session while returning only sanitized completion state", async () => {
    const fakeProcess = new FakeCodexAppServerProcess();

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testCodexAppServerProcessEnv(),
      prompt: "sensitive prompt should only be sent to the child process",
      model: "gpt-test",
      modelProvider: "codex-lb",
      reasoningEffort: "high",
      providerRoute: {
        providerId: "headroom-gateway",
        routeProfile: "headroom",
        backingProviderId: "codex-lb",
        baseUrl: "https://example.invalid:8787/v1"
      },
      timeoutMs: 1000,
      spawnProcess: () => fakeProcess
    });

    expect(state).toMatchObject({
      threadId: "thread:test-1",
      turnId: "turn:test-1",
      turnStatus: "completed",
      notificationCount: 1,
      completedNotificationSeen: true
    });
    expect(fakeProcess.killed).toBe(true);
    expect(JSON.stringify(state)).not.toContain("sensitive prompt");
    expect(JSON.stringify(state)).not.toContain("do not persist this");
    expect(fakeProcess.writes).toContainEqual(
      expect.objectContaining({
        method: "thread/start",
        params: expect.objectContaining({
          ephemeral: true,
          model: "gpt-test",
          modelProvider: "codex-lb",
          serviceName: "space-capability"
        })
      })
    );
    expect(fakeProcess.writes.find((message) => message.method === "thread/start")).not.toMatchObject({
      params: expect.objectContaining({
        providerRoute: expect.anything(),
        reasoningEffort: expect.anything()
      })
    });
    expect(fakeProcess.writes).toContainEqual(
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({
          model: "gpt-test",
          effort: "high"
        })
      })
    );
    expect(fakeProcess.writes.find((message) => message.method === "turn/start")).not.toMatchObject({
      params: expect.objectContaining({
        modelProvider: expect.anything(),
        providerRoute: expect.anything(),
        reasoningEffort: expect.anything()
      })
    });
  });

  it("waits for turn completion notifications before resolving completed turn/start responses", async () => {
    const fakeProcess = new EarlyCompletedTurnProcess();

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testCodexAppServerProcessEnv(),
      prompt: "return assistant text after early completed turn result",
      timeoutMs: 1000,
      spawnProcess: () => fakeProcess
    });

    expect(state).toMatchObject({
      threadId: "thread:test-early-completed",
      turnId: "turn:test-early-completed",
      turnStatus: "completed",
      completedNotificationSeen: true,
      agentMessageText: "SPACE_EARLY_COMPLETED_OK"
    });
    expect(fakeProcess.killed).toBe(true);
  });

  it("continues an existing thread without creating a new ephemeral thread", async () => {
    const fakeProcess = new FakeCodexAppServerProcess();

    const state = await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testCodexAppServerProcessEnv(),
      prompt: "continue this session",
      threadId: "thread:existing-1",
      ephemeral: false,
      model: "gpt-existing-thread",
      modelProvider: "codex-lb",
      reasoningEffort: "low",
      providerRoute: {
        providerId: "direct-auto-failover",
        routeProfile: "direct-auto",
        backingProviderId: "codex-lb",
        baseUrl: "http://127.0.0.1:2458/v1"
      },
      timeoutMs: 1000,
      spawnProcess: () => fakeProcess
    });

    expect(state.threadId).toBe("thread:existing-1");
    expect(fakeProcess.writes).not.toContainEqual(expect.objectContaining({ method: "thread/start" }));
    expect(fakeProcess.writes).toContainEqual(
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({
          threadId: "thread:existing-1",
          model: "gpt-existing-thread",
          effort: "low"
        })
      })
    );
    expect(fakeProcess.writes.find((message) => message.method === "turn/start")).not.toMatchObject({
      params: expect.objectContaining({
        modelProvider: expect.anything(),
        providerRoute: expect.anything(),
        reasoningEffort: expect.anything()
      })
    });
  });

  it("sends image attachments as local image paths accepted by the app-server protocol", async () => {
    const fakeProcess = new FakeCodexAppServerProcess();

    await runCodexAppServerStdioTurnSession({
      command: "codex",
      env: testCodexAppServerProcessEnv(),
      prompt: "describe the screenshot",
      imageAttachments: [
        {
          artifactId: "artifact:image-1",
          mimeType: "image/png",
          storageUri: "space-artifact://browser-evidence/capture/screenshot.png",
          sha256: "a".repeat(64),
          path: "/opt/spaceapp/var/artifacts/browser-evidence/capture/screenshot.png"
        }
      ],
      timeoutMs: 1000,
      spawnProcess: () => fakeProcess
    });

    const turnStart = fakeProcess.writes.find(
      (message): message is { method: string; params: { input: unknown[] } } =>
        typeof message === "object" &&
        message !== null &&
        "method" in message &&
        message.method === "turn/start"
    );

    expect(turnStart?.params.input).toContainEqual({
      type: "localImage",
      path: "/opt/spaceapp/var/artifacts/browser-evidence/capture/screenshot.png"
    });
  });
});
