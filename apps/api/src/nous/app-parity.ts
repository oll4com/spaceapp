/**
 * RCA 31/10 (operator 16:05 BKK «το quotas στην 0.2.9 δεν έχει καμία αλλαγή, τα requests καμία αλλαγή!!», his rule «σε όλα τα nous παντού»): the
 * day's Nous dock and quota changes reached the SpaceApp web only, and the 29/10 Done fix never reached the app. The Nous app is its own
 * client, built in an App Studio pane outside this repository, so nothing told Nous a port was due. Each new commit on dev that changes
 * what the Nous dock shows now brings Nous one line to brief the port.
 */
export const NOUS_APP_PARITY_PATHS = ["apps/web/src/features/nous", "apps/web/src/features/desktop-widgets", "apps/web/src/features/toolbar-metrics"];
const CHECK_MS = 10 * 60_000;

export function createNousAppParityWatch(deps: { git(args: string[]): Promise<string>; now?: () => number }) {
  let seen: string | null = null;
  let checkedAt = 0;
  return {
    /** The line for Nous when dev gained such commits since the last look (checked at most every 10 minutes), else null. */
    async check(): Promise<string | null> {
      const now = deps.now?.() ?? Date.now();
      if (now - checkedAt < CHECK_MS) return null;
      checkedAt = now;
      const head = (await deps.git(["rev-parse", "--verify", "dev"])).trim();
      // The first look after an API start only remembers dev: what came before is not news.
      if (!seen || head === seen) { seen = head; return null; }
      const log = await deps.git(["log", "--no-merges", "--format=%x1e%h %s", "--name-only", `${seen}..${head}`, "--", ...NOUS_APP_PARITY_PATHS]);
      seen = head;
      const commits = log.split("\x1e").map((record) => record.trim().split("\n").filter(Boolean)).filter((lines) => lines.length > 1)
        .map(([title, ...files]) => `${title!} (${files.map((file) => file.replace(/^apps\/web\/src\/features\//, "")).join(", ")})`);
      if (!commits.length) return null;
      return `The Nous dock changed on dev (${commits.length} commit${commits.length === 1 ? "" : "s"}): ${commits.join("; ")}. `
        + "The Nous app is its own client and has none of it until it is ported (operator rule «σε όλα τα nous παντού»): brief the Nous app's App Studio pane "
        + "now with each change the operator would see, and release no Nous app version before they are in it.";
    }
  };
}
