import type { JevDecideInput, JevDecideResult } from "@space/contracts";

export interface DecisionProvider {
  readonly id: string;
  readonly name: string;
  isAvailable(): Promise<boolean>;
  decide(request: JevDecideInput): Promise<JevDecideResult>;
}

export interface DecisionEngineOptions {
  providers?: DecisionProvider[];
  defaultProviderId?: string;
}
