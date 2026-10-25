/** Only known native rejection/closed failure metadata can authorize a retry.
 * Never infer rejection from a network error, timeout or arbitrary error string. */
export interface CodexRetryableFailure { retryAfterMs?: number }
export function codexRetryableFailure(value: unknown): CodexRetryableFailure | undefined {
 if (!value || typeof value !== 'object') return;
 const error=value as Record<string,unknown>;
 const data=error.data && typeof error.data==='object'?error.data as Record<string,unknown>:error;
 const code=data.codexErrorInfo ?? data.code;
 const message=typeof error.message==='string'?error.message:'';
 if (!['rateLimitExceeded','usageLimitExceeded','modelUnavailable','modelNotFound','flexUnavailable','serverOverloaded'].includes(String(code)) &&
     data.httpStatusCode!==429 && data.httpStatusCode!==503 &&
     !/\bmodel\b.{0,160}\b(?:does not exist|not available|unavailable|not supported)\b/i.test(message)) return;
 const retryAfter=data.retryAfter ?? data.retry_after;
 const milliseconds=typeof data.retryAfterMs==='number'?data.retryAfterMs:
  typeof retryAfter==='number'?retryAfter*1000:
  typeof retryAfter==='string'&&/^\d+(\.\d+)?$/.test(retryAfter)?Number(retryAfter)*1000:
  typeof retryAfter==='string'?Date.parse(retryAfter)-Date.now():undefined;
 return milliseconds!==undefined&&Number.isFinite(milliseconds)&&milliseconds>=0?{retryAfterMs:milliseconds}:{};
}
export class CodexManagedTurnDeliveryError extends Error {
 constructor(readonly delivery:'NOT_SENT'|'REJECTED'|'UNKNOWN',readonly retryableFailure?:CodexRetryableFailure){
  super(delivery==='UNKNOWN'?'Managed Codex turn acceptance is uncertain.':'Managed Codex turn was not accepted.');
 }
}

/** A matching native SETTINGS RPC response explicitly rejected the write. */
export class CodexSettingsRejectedError extends Error {
 constructor(readonly retryableFailure?: CodexRetryableFailure) {
  super('Native thread settings were rejected.');
  this.name = 'CodexSettingsRejectedError';
 }
}
