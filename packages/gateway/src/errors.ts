/** OpenAI-style error envelope, the same shape codex-lb returns, so existing clients keep parsing it. */
export interface GatewayErrorEnvelope {
  error: { message: string; type: string; code: string };
}

export function gatewayError(code: string, message: string, type = "server_error"): GatewayErrorEnvelope {
  return { error: { message, type, code } };
}

export const gatewayErrors = {
  missingApiKey: () => gatewayError("invalid_api_key", "Missing API key. Send it as a Bearer token.", "authentication_error"),
  invalidApiKey: () => gatewayError("invalid_api_key", "Invalid API key.", "authentication_error"),
  inactiveApiKey: () => gatewayError("invalid_api_key", "This API key is disabled.", "authentication_error"),
  expiredApiKey: () => gatewayError("invalid_api_key", "This API key has expired.", "authentication_error"),
  noAccounts: () => gatewayError("no_accounts", "No accounts are available in Space Gateway.", "server_error"),
  keyRateLimited: () => gatewayError("rate_limit_exceeded", "This API key sent too many requests this minute.", "rate_limit_error"),
  draining: () => gatewayError("gateway_draining", "Space Gateway is restarting. Retry the request.", "server_error"),
  unavailable: () => gatewayError("gateway_unavailable", "Space Gateway storage is unavailable.", "server_error"),
  sourceNotAllowed: () => gatewayError("source_not_allowed", "This address may not use Space Gateway.", "permission_error"),
  lanRouteNotFound: () => gatewayError("not_found", "This path is not available on the LAN address.", "invalid_request_error")
};
