/**
 * Re-export shim: the OTLP span exporter now lives in the shared workspace
 * package @space/otel-exporter so Temporal workers (and any other process)
 * can export spans with identical bounded-queue semantics. This module keeps
 * the original import path working.
 */
export * from "@space/otel-exporter";
