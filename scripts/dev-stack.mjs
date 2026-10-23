#!/usr/bin/env node
import { main } from './dev-stack/supervisor.mjs';
await main().catch(error => { console.error(`[dev-stack] ${error.message}`); process.exitCode = 1; });
