export interface BrowserControlHeldDetails {
  sessionId: string;
  paneId: string;
  roomId: string;
  leaseId: string;
  holderType: "OPERATOR";
  holderId: string;
  expiresAt: string;
  reason: string | null;
}

export class BrowserControlHeldError extends Error {
  readonly errorCode = "BROWSER_CONTROL_HELD";

  constructor(
    message: string,
    public readonly details: BrowserControlHeldDetails
  ) {
    super(message);
    this.name = "BrowserControlHeldError";
  }
}
