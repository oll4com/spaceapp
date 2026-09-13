/** Conservative command grammar. Free-form work always falls through to the supervisor. */
export type RoomQuickCommand =
  | { type: "OPEN_PANES"; count: number; mode: "TERMINAL" | "CHAT" | "BROWSER" | "YOUTUBE"; runtimeId?: string }
  | { type: "SEARCH"; query: string; engine: "GOOGLE" | "YOUTUBE"; paneId?: string }
  | { type: "MUSIC"; action: "PLAY" | "PAUSE" | "NEXT" | "PREVIOUS"; target: "AUTO" | "YOUTUBE" };

const runtimes: Record<string, string> = { codex: "cli:codex", opencode: "cli:opencode", claude: "cli:claude", gemini: "cli:gemini", kimi: "cli:kimi", grok: "cli:grok", deepseek: "cli:deepseek", cursor: "cli:cursor", copilot: "cli:copilot", hermes: "cli:hermes" };
const counts: Record<string, number> = { ενα: 1, μια: 1, εναν: 1, δυο: 2, τρια: 3, τεσσερα: 4, one: 1, two: 2, three: 3, four: 4, a: 1, an: 1 };
export function parseRoomQuickCommand(content: string): RoomQuickCommand | null {
  const original = content.normalize("NFC").trim().replace(/[.!！]+$/u, "").trim();
  const text = original.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (!text || text.length > 1000 || /[\n`]/.test(text)) return null;
  const polite = text.replace(/^(?:παρακαλω\s+|please\s+|θελω\s+(?:να\s+)?)/, "");
  const music = /^(?:(ξεκινα|ξεκινησε|παιξε|βαλε|start|play|resume)\s+(?:τη\s+|την\s+)?(?:μουσικη|music)|(?:σταματα|σταματησε|παυσε|pause|stop)\s+(?:τη\s+|την\s+)?(?:μουσικη|music)|(?:επομενο|next|προηγουμενο|previous)\s+(?:τραγουδι|κομματι|song|track))(?:\s+(?:στο|στον|on)\s+(?:το\s+)?youtube)?$/.exec(polite);
  if (music) return { type: "MUSIC", action: /^(?:επομενο|next)/.test(polite) ? "NEXT" : /^(?:προηγουμενο|previous)/.test(polite) ? "PREVIOUS" : /^(?:σταματα|σταματησε|παυσε|pause|stop)/.test(polite) ? "PAUSE" : "PLAY", target: polite.endsWith("youtube") ? "YOUTUBE" : "AUTO" };
  const search = /^(?:(?:ανοιξε|open)\s+(?:το\s+|a\s+)?(?:browser|broswer)(?:\s+pane)?\s+(?:και|and)\s+)?(?:κανε\s+)?(?:αναζητηση|αναζητησε|ψαξε|search)(?:\s+(?:στο|στον|on|in)\s+(?:το\s+)?(browser|broswer|google|youtube)(?:\s+pane)?)?\s*:?\s+(?:for\s+)?(.+)$/.exec(polite);
  if (search) {
    const query = original.slice(text.indexOf(search[2]!, text.length - search[2]!.length)).trim();
    if (!query || /\b(?:και μετα|and then)\b/u.test(search[2]!)) return null;
    return { type: "SEARCH", query, engine: search[1] === "youtube" ? "YOUTUBE" : "GOOGLE" };
  }
  const open = /^(?:ανοιξε|ανοιξεις|δημιουργησε|δημιουργησεις|open|create)\s+(?:(\d{1,2}|ενα|μια|εναν|δυο|τρια|τεσσερα|one|two|three|four|a|an)\s+)?(?:(codex|opencode|claude|gemini|kimi|grok|deepseek|cursor|copilot|hermes)\s*)?(?:(cli|chat|browser|broswer|youtube)\s*)?(?:panes?|πανελ|παραθυρα|παραθυρο|τερματικα|τερματικο)?$/.exec(polite);
  if (!open || (!open[2] && !open[3])) return null;
  const count = open[1] ? counts[open[1]] ?? Number(open[1]) : 1;
  if (!Number.isInteger(count) || count < 1 || count > 16) return null;
  const mode = open[3] === "chat" ? "CHAT" : /^(browser|broswer)$/.test(open[3] ?? "") ? "BROWSER" : open[3] === "youtube" ? "YOUTUBE" : "TERMINAL";
  // Provider-specific Chat requires catalog selection; keep that on the reasoning path.
  if (mode === "CHAT" && open[2] && open[2] !== "codex") return null;
  if (open[2] && ["BROWSER", "YOUTUBE"].includes(mode)) return null;
  return { type: "OPEN_PANES", count, mode, ...(mode === "TERMINAL" ? { runtimeId: runtimes[open[2] ?? "codex"] } : {}) };
}
