import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  background: false,
  connect: vi.fn(), create: vi.fn(), run: vi.fn(), tracing: vi.fn(), close: vi.fn(),
  metricsListen: vi.fn(), metricsStart: vi.fn(), chessStart: vi.fn(), chessClose: vi.fn(),
  telegramStart: vi.fn(), telegramStop: vi.fn(), streamingStart: vi.fn(), streamingStop: vi.fn(),
  options: { interceptors: { activity: [] }, sinks: { tracing: {} } }
}));

vi.mock("@space/contracts", () => ({
  assertDevInstanceIsolated: vi.fn(), instanceBackgroundJobEnabled: () => mocks.background
}));
vi.mock("@space/db", () => ({
  PostgresSpaceStore: { fromConnectionString: () => ({ createTelegramPersistence: () => ({}) }) },
  PostgresStreamingRepository: { fromConnectionString: () => ({}) },
  PostgresStreamingBotRepository: { fromConnectionString: () => ({}) }
}));
vi.mock("@space/streaming", () => ({ StreamingCredentialStore: class {} }));
vi.mock("@space/runtime", () => ({ TelegramDeliveryWorker: class {}, TelegramSecretStore: class {} }));
vi.mock("@temporalio/worker", () => ({
  NativeConnection: { connect: mocks.connect }, Runtime: { install: vi.fn() }, Worker: { create: mocks.create }
}));
vi.mock("../src/activities.js", () => ({}));
vi.mock("../src/worker-tracing.js", () => ({ createWorkerTracing: mocks.tracing }));
vi.mock("../src/worker-metrics.js", () => ({
  resolveTemporalCoreMetricsBind: () => null,
  resolveWorkerMetricsListen: mocks.metricsListen, startWorkerMetricsServer: mocks.metricsStart
}));
vi.mock("../src/worker-log.js", () => ({ workerLog: vi.fn() }));
vi.mock("../src/codex-cli-completion.js", () => ({ sweepCodexCliCompletions: vi.fn() }));
vi.mock("../src/telegram-notification-runtime.js", () => ({
  runTelegramNotificationCycle: vi.fn(),
  TelegramNotificationLoop: class { start = mocks.telegramStart; stop = mocks.telegramStop; }
}));
vi.mock("../src/streaming-bot-runtime.js", () => ({
  runStreamingBotCycle: vi.fn(), createSpaceBotMemoryStore: vi.fn(),
  StreamingBotLoop: class { start = mocks.streamingStart; stop = mocks.streamingStop; }
}));
vi.mock("../src/chess-cli-move.js", () => ({ CHESS_MOVE_SOCKET: "unused", startChessMoveServer: mocks.chessStart }));
vi.mock("../src/nous-turn.js", () => ({
  NOUS_TURN_MAX_BODY_BYTES: 1, NousTurnInputError: class extends Error {}, runNousTurn: vi.fn(), validateNousTurnInput: vi.fn()
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("SPACE_DATABASE_URL", "postgres://synthetic.invalid/unused");
  vi.stubEnv("SPACE_CHESS_MOVE_SOCKET", "unused");
  mocks.background = false;
  mocks.connect.mockResolvedValue({});
  mocks.create.mockResolvedValue({ run: mocks.run });
  mocks.run.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.tracing.mockReturnValue({ workerOptions: mocks.options, close: mocks.close });
  mocks.metricsListen.mockReturnValue(null);
  mocks.chessStart.mockResolvedValue({ close: mocks.chessClose });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const load = () => import("../src/worker.js");

describe("main worker tracing lifetime", () => {
  it("registers tracing and closes it after a successful worker run", async () => {
    await load();
    expect(mocks.tracing).toHaveBeenCalledWith("space-worker");
    expect(mocks.create.mock.calls[0][0]).toMatchObject(mocks.options);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.chessClose).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.invocationCallOrder[0]).toBeLessThan(mocks.close.mock.invocationCallOrder[0]);
  });

  it("closes tracing and preserves the error when worker creation rejects", async () => {
    const failure = new Error("synthetic Worker.create rejection");
    mocks.create.mockRejectedValue(failure);
    await expect(load()).rejects.toBe(failure);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.chessStart).not.toHaveBeenCalled();
    expect(mocks.telegramStop).not.toHaveBeenCalled();
    expect(mocks.streamingStop).not.toHaveBeenCalled();
  });

  it("closes tracing when startup fails after worker creation", async () => {
    const failure = new Error("synthetic metrics startup rejection");
    mocks.metricsListen.mockReturnValue({ port: 1234 });
    mocks.metricsStart.mockRejectedValue(failure);
    await expect(load()).rejects.toBe(failure);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.chessStart).not.toHaveBeenCalled();
  });

  it("stops initialized loops and closes tracing when later startup fails", async () => {
    mocks.background = true;
    const failure = new Error("synthetic streaming loop startup failure");
    mocks.streamingStart.mockImplementation(() => { throw failure; });
    await expect(load()).rejects.toBe(failure);
    expect(mocks.telegramStart).toHaveBeenCalledTimes(1);
    expect(mocks.telegramStop).toHaveBeenCalledTimes(1);
    expect(mocks.streamingStop).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.chessClose).not.toHaveBeenCalled();
  });

  it("cleans initialized resources and preserves a worker.run rejection", async () => {
    mocks.background = true;
    const failure = new Error("synthetic worker.run rejection");
    mocks.run.mockRejectedValue(failure);
    await expect(load()).rejects.toBe(failure);
    expect(mocks.telegramStop).toHaveBeenCalledTimes(1);
    expect(mocks.streamingStop).toHaveBeenCalledTimes(1);
    expect(mocks.chessClose).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.chessClose.mock.invocationCallOrder[0]).toBeLessThan(mocks.close.mock.invocationCallOrder[0]);
  });

  it("does not initialize tracing when the connection itself fails", async () => {
    const failure = new Error("synthetic connection rejection");
    mocks.connect.mockRejectedValue(failure);
    await expect(load()).rejects.toBe(failure);
    expect(mocks.tracing).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
});
