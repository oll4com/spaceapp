/**
 * Remote CLI-host client surface. Importing this entry point must not load the
 * local PTY adapter; core talks to the separate CLI image over its Unix socket.
 * The package root retains the complete host API for existing callers.
 */
export * from "./types.js";
export * from "./framing.js";
export * from "./client.js";
export { CliHostError } from "./errors.js";
export * from "./output-filter.js";
