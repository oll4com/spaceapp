export class WorktreeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}
