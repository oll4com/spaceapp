/** Shared CLI-host errors used by both the remote client and the PTY service. */
export class CliHostError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CliHostError";
  }
}
