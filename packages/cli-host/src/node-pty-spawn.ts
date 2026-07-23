import { spawn } from "node-pty";
import type { CliHostSpawn } from "./types.js";

export const spawnNodePty: CliHostSpawn = (spec) =>
  spawn(spec.command, spec.args, {
    name: "xterm-256color",
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
    env: spec.env
  });
