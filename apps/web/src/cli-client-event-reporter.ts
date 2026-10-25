import type { CliTerminalClientEventInput } from "@space/contracts";

import { api } from "./api.js";

export const CLI_CLIENT_EVENT_REPORT_BURST_LIMIT = 64;
export const CLI_CLIENT_EVENT_REPORT_INTERVAL_MS = 400;
export const CLI_CLIENT_EVENT_REPORT_QUEUE_LIMIT = 512;

interface CliClientEventReporterOptions {
  burstLimit: number;
  intervalMs: number;
  queueLimit: number;
}

export interface CliClientEventReporter {
  report(event: CliTerminalClientEventInput): void;
  pendingCount(): number;
  dispose(): void;
}

export function createCliClientEventReporter(
  send: (event: CliTerminalClientEventInput) => Promise<unknown>,
  options: CliClientEventReporterOptions = {
    burstLimit: CLI_CLIENT_EVENT_REPORT_BURST_LIMIT,
    intervalMs: CLI_CLIENT_EVENT_REPORT_INTERVAL_MS,
    queueLimit: CLI_CLIENT_EVENT_REPORT_QUEUE_LIMIT
  }
): CliClientEventReporter {
  const queue: CliTerminalClientEventInput[] = [];
  let immediateCount = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const deliver = (event: CliTerminalClientEventInput) =>
    Promise.resolve()
      .then(() => send(event))
      .catch(() => undefined);

  const schedule = () => {
    if (disposed || timer !== null || queue.length === 0) return;
    timer = setTimeout(() => {
      const event = queue.shift();
      if (!event) {
        timer = null;
        return;
      }
      void deliver(event).finally(() => {
        timer = null;
        schedule();
      });
    }, options.intervalMs);
  };

  return {
    report(event) {
      if (disposed) return;
      if (immediateCount < options.burstLimit) {
        immediateCount += 1;
        void deliver(event);
        return;
      }
      if (queue.length >= options.queueLimit) queue.shift();
      queue.push(event);
      schedule();
    },
    pendingCount() {
      return queue.length;
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    }
  };
}

const sendCliClientEvent = (event: CliTerminalClientEventInput) => api.reportCliClientEvent(event);
let cliClientEventReporter = createCliClientEventReporter(sendCliClientEvent);

export function reportCliClientEventBounded(event: CliTerminalClientEventInput): void {
  cliClientEventReporter.report(event);
}

export function resetCliClientEventReporter(): void {
  cliClientEventReporter.dispose();
  cliClientEventReporter = createCliClientEventReporter(sendCliClientEvent);
}
