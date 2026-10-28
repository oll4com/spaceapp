# Workflow Histories Fixtures

This directory stores recorded execution histories for Temporal workflows in SpaceApp.

## Purpose

The workflow replay gate and regression test suites replay these recorded histories against current workflow definitions to verify determinism and prevent backward compatibility breaks for long-running workflows.

## Re-recording Histories

To re-record workflow execution histories:

```sh
npm run temporal:record-histories -w @space/worker
```

## Strict Invariant

Re-record histories **ONLY** together with a `patched()` change that preserves replay compatibility for existing running executions.
**NEVER** re-record histories simply to make a failing replay test pass. Doing so would mask breaking non-determinism changes in production workflows.
