import { tmpdir } from "node:os";
import { join } from "node:path";

// The app's startup imports the Startup Programs files the operator's data panes write on this server; a test app reading them got the
// operator's real programs (4/11: eight program-use inbox lines in nous.test.ts). A folder that does not exist imports nothing.
process.env.SPACE_NOUS_PROGRAMS_DIR = join(tmpdir(), "space-test-no-programs");
process.env.SPACE_NOUS_PROGRAMS_USAGE_FILE = join(tmpdir(), "space-test-no-programs", "usage-fields.json");
