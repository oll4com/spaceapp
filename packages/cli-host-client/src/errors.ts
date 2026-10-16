export class CliHostError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CliHostError";
  }
}
