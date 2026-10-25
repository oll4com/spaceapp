#!/usr/bin/env node

import process from "node:process";
import { run } from "../src/cli.mjs";

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`spaceapp: ${error?.message || String(error)}\n`);
  process.exitCode = 1;
}
