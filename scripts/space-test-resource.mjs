#!/usr/bin/env node
// R27-1: record a test VM, CT or snapshot this pane just created on a host. Under the operator's "May delete what Nous created"
// Nous may then delete it without a card; a VM, CT or snapshot with no record stays the operator's decision.
// Reaches the API with the pane's bridge token (as space-progress); the token is never printed.
import { pathToFileURL } from "node:url";
import { postProgress } from "./space-progress.mjs";

const KINDS = { vm: "VM", ct: "CT", snapshot: "SNAPSHOT" };
const USAGE = "Usage: space-test-resource <vm|ct> <host> <vmid> \"<what it is, what it was made from>\"\n"
  + "       space-test-resource snapshot <host> <vmid> <snapshot name> \"<what it is for>\"";

/** The record the API takes, from the command line. */
export function parseArgs(argv) {
  const kind = KINDS[argv[0]];
  if (!kind) throw new Error(`${argv[0] ? `Unknown kind: ${argv[0]}` : "Missing kind."}\n${USAGE}`);
  const [host, id, ...rest] = argv.slice(1);
  const [snapshot, note] = kind === "SNAPSHOT" ? rest : [undefined, ...rest];
  if (!host || !/^\d+$/.test(id ?? "") || (kind === "SNAPSHOT" && !snapshot) || !note?.trim() || rest.length !== (kind === "SNAPSHOT" ? 2 : 1)) throw new Error(USAGE);
  return { kind, host, vmid: Number(id), ...(snapshot ? { snapshot } : {}), note: note.trim() };
}

export async function main(argv, env = process.env) {
  const body = parseArgs(argv);
  const payload = await postProgress(body, env, "/api/cli/test-resources");
  return `Recorded ${body.kind.toLowerCase()} ${body.host} ${body.vmid}${body.snapshot ? `@${body.snapshot}` : ""} as created by this pane (${payload.id}).`;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).then((out) => console.log(out), (error) => { console.error(error.message.replace(/(token)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")); process.exit(1); });
}
