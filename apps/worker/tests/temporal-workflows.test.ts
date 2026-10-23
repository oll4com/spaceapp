/** One serial entry avoids compiling identical large workflow bundles in parallel. */
import { afterAll } from "vitest";
import { closeTemporalServer, reuseTemporalServer } from "./support/temporal-harness.js";
import "./temporal-basic-workflows.scenarios.js";
import "./temporal-supervisor.scenarios.js";
import "./temporal-replay.scenarios.js";

reuseTemporalServer();
afterAll(closeTemporalServer);
