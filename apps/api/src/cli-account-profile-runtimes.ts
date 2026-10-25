/** CLI runtimes that support multiple account profiles (moved verbatim from the composition root). */
import { cliAccountProfileRuntimeIds } from "./cli-runtime-descriptors.js";

export type CliAccountProfileRuntimeId = typeof cliAccountProfileRuntimeIds[number];

export function isCliAccountProfileRuntimeId(runtimeId: string): runtimeId is CliAccountProfileRuntimeId {
  return cliAccountProfileRuntimeIds.includes(runtimeId as CliAccountProfileRuntimeId);
}
