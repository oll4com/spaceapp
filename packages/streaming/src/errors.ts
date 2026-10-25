export class StreamingProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transient: boolean,
    readonly status: number | null = null
  ) {
    super(message);
    this.name = "StreamingProviderError";
  }
}