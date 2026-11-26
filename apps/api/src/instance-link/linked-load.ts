import type { NousLinkedLoad, NousLoad, NousLoadPart } from "@space/contracts";

// A linked SpaceApp's row on the Load page, the Live card and the Nous app's Resources (operator nous_msg:766c70a6). One built before
// /api/nous/load reached a link (spaceapp-hz on 0.2.5 answers 403) still gives CPU and Memory through its SYSTEM_HEALTH inspect and its
// working panes through its overview, all reads.

const SHOWN = new Set(["cpu", "memory", "load", "pressure", "panes"]);
type Metric = { id?: unknown; value?: unknown; total?: unknown };
type Agents = { running?: unknown; total?: unknown };

export type LinkedLoadInput = {
  link: { id: string; label: string; origins: string[] };
  load: NousLoad | null;
  /** Its SYSTEM_HEALTH inspect answer's metrics, read when /api/nous/load was refused. */
  health: Metric[] | null;
  /** Its overview's live.agents, from the minute's peer read. */
  agents: Agents | null;
  /** This read got its load or its health. */
  answered: boolean;
  /** When it last answered a read; null when it never has. */
  answeredAt: string | null;
  error: string | null;
};

const round = (value: number) => Math.round(value * 10) / 10;
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function linkedLoadRow({ link, load, health, agents, answered, answeredAt, error }: LinkedLoadInput): NousLinkedLoad {
  const host = link.origins.map((origin) => (URL.canParse(origin) ? new URL(origin).hostname : null)).find(Boolean) ?? null;
  const parts: NousLoadPart[] = load ? load.parts.filter((part) => SHOWN.has(part.key)) : [];
  if (!load && health) {
    const metric = (id: string) => health.find((entry) => entry.id === id);
    const cpu = num(metric("cpu")?.value), memory = num(metric("memory")?.value);
    const used = num(metric("memory-used")?.value), total = num(metric("memory-used")?.total);
    if (cpu !== null) parts.push({ key: "cpu", label: "CPU", percent: round(cpu), detail: "in use" });
    if (memory !== null) parts.push({ key: "memory", label: "Memory", percent: round(memory),
      detail: used !== null && total ? `${(used / 2 ** 30).toFixed(1)} of ${(total / 2 ** 30).toFixed(0)} GiB in use` : "in use" });
  }
  const running = num(agents?.running), open = num(agents?.total);
  if (answered && !parts.some((part) => part.key === "panes") && running !== null && open !== null)
    parts.push({ key: "panes", label: "CLI panes", percent: open ? round((100 * running) / open) : null, detail: `${running} of ${open} working` });
  return { id: link.id, label: link.label, host, answering: answered, answeredAt,
    overall: load?.overall ?? null, level: load?.level ?? null, parts, error };
}
