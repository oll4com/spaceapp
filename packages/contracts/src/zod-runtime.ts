import { z } from "zod";

// In a browser, zod's fast path probes `new Function`, which the app's script policy reports as an eval violation
// (security addendum step 7). The interpreted path validates the same; the server keeps the fast one.
if (typeof document !== "undefined") z.config({ jitless: true });
