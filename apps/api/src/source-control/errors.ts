export class GitControlError extends Error {
  /** Set on the repository-create request itself: its outcome may be uncertain. */
  createAttempted?: boolean;
  /** Set when a create failed before its request was sent: nothing was created. */
  createNotSent?: boolean;
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message); }
}
