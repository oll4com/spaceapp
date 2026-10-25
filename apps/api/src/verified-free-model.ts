import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { isFreeCostTier } from "@space/opencode-control";

const proofLifetimeMs = 24 * 60 * 60_000;
const modelIdPattern = /^opencode\/[a-z0-9][a-z0-9._-]{0,100}$/;

/**
 * A file is only a candidate model hint when its proof is recent, zero-cost and a real tool call (operator rule 2026-10-11).
 * OpenCode 2's first run and First Setup's selection write it; an OpenCode 1 text-only proof has no `verification`.
 */
export function verifiedFreeModelFromRecord(record: unknown, now = Date.now()): string | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const item = record as Record<string, unknown>;
  const verifiedAt = typeof item.verifiedAt === "string" ? Date.parse(item.verifiedAt) : NaN;
  // Every price dimension of the recorded tier must be zero (review 2026-10-21 #2), the same rule as the catalog filter.
  if (item.verification !== "tool-call" || typeof item.id !== "string" || !modelIdPattern.test(item.id) ||
      !isFreeCostTier(item.cost) ||
      !Number.isFinite(verifiedAt) || verifiedAt > now + 5 * 60_000 || now - verifiedAt > proofLifetimeMs) return null;
  return item.id;
}

export async function readVerifiedFreeModel(memoryRoot = process.env.SPACE_MEMORY_ROOT): Promise<string | null> {
  return (await readVerifiedFreeModelProof(memoryRoot))?.id ?? null;
}

/** The verified model with the time of its tool call. */
export async function readVerifiedFreeModelProof(
  memoryRoot = process.env.SPACE_MEMORY_ROOT
): Promise<{ id: string; verifiedAt: string } | null> {
  if (!memoryRoot) return null;
  const path = join(memoryRoot, "installation-model.json");
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4096) return null;
      const record = JSON.parse(await handle.readFile("utf8")) as { verifiedAt?: unknown };
      const id = verifiedFreeModelFromRecord(record);
      return id && typeof record.verifiedAt === "string" ? { id, verifiedAt: record.verifiedAt } : null;
    } finally { await handle.close(); }
  } catch { return null; }
}

