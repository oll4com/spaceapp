import type { NousModelChoice } from "@space/contracts";

/** The immutable launch selection shared by an active turn, its worker and its tool context. */
export type NousSelectedModel = NousModelChoice & { fallbackModel: string | null };
