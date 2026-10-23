/**
 * Shared identifier pattern for telemetry attributes. Values that are not
 * identifiers (prompts, paths, URLs, messages, user text) are never exported
 * as span attributes.
 */
export const identifierPattern = /^[A-Za-z0-9:._-]{1,200}$/;
