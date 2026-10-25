import type { FastifyInstance } from "fastify";

/**
 * Job Copilot mail triage: every 15 minutes, application emails of each owner's Google accounts that allowed
 * organizing mail are filed under the Job Applications labels (stable only; a dev copy would act on real Gmail).
 * Single-flight; the first pass runs two minutes after the API is ready. Moved out of the composition root.
 */
export function scheduleJobApplyMailTriage(app: FastifyInstance, input: { enabled: boolean; triage(onError: (owner: string, error: unknown) => void): Promise<unknown> }): void {
  let timer: NodeJS.Timeout | null = null;
  let first: NodeJS.Timeout | null = null;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await input.triage((owner, error) => app.log.warn({ err: error, owner }, "Job Copilot mail triage failed for an owner"));
    } finally {
      running = false;
    }
  };
  const tick = () => void run().catch((error) => app.log.warn({ err: error }, "Job Copilot mail triage failed"));
  app.addHook("onReady", async () => {
    if (!input.enabled) return;
    first = setTimeout(tick, 2 * 60_000);
    first.unref();
    timer = setInterval(tick, 15 * 60_000);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    if (first) clearTimeout(first);
    if (timer) clearInterval(timer);
  });
}
