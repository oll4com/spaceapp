import type { NousModelChoice, NousProvider, NousRunProvider } from "@space/contracts";

/** The immutable launch selection shared by an active turn, its worker and its tool context ("opencode": a Space route's own runtime). */
export type NousSelectedModel = NousModelChoice & { provider?: NousProvider | NousRunProvider; fallbackModel: string | null;
  /** Space provider: the pools with no room for Nous when the model was picked (NousTokens.noRoom). */
  noRoom?: string[] };
