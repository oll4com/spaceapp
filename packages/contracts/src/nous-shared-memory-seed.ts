import seed from "./nous-shared-memory-seed.json" with { type: "json" };
import { screenSharedMemory, sharedMemorySeedSchema } from "./nous-shared-memory.js";

export const sharedMemorySeed = sharedMemorySeedSchema.parse(seed);
const keys = new Set<string>();
for (const entry of sharedMemorySeed.entries) {
  const screened = screenSharedMemory(entry);
  if (!screened.ok || keys.has(entry.key)) throw new Error("The shared Nous memory seed failed its privacy or identity checks.");
  keys.add(entry.key);
}
