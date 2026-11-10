import { NOUS_PROMPT_MAX_CHARS } from "@space/contracts";

/**
 * One part of a turn's prompt. `rank` says what is cut first when the whole passes the model's context share (lower first);
 * `readHow` names how Nous reads what a cut left out; `cut` says which end goes (the conversation keeps its newest part under its heading).
 */
export interface PromptPart { name: string; text: string; rank: number; readHow?: string; cut?: "head" | "tail" }

export interface PromptCut { name: string; whole: number; kept: number }

const SEPARATOR = "\n\n";

/**
 * Operator 1/11 14:53 BKK («φτιάξε οριστικά το πρόβλημα … μη καίει τόσα πολλά tokens χωρίς λόγο»): the prompt fits NOUS_PROMPT_MAX_CHARS
 * whatever the world holds. Parts are cut in rank order at a line boundary, each cut named with its size and how to read the rest, so
 * nothing is dropped silently and no turn ever fails "Invalid prompt." again. Under the bound the prompt is the parts joined, unchanged.
 */
export function fitPrompt(parts: ReadonlyArray<PromptPart>, max = NOUS_PROMPT_MAX_CHARS): { text: string; cuts: PromptCut[] } {
  const kept = parts.filter((part) => part.text).map((part) => ({ ...part }));
  const total = () => kept.reduce((sum, part) => sum + part.text.length, 0) + SEPARATOR.length * Math.max(0, kept.length - 1);
  const cuts: PromptCut[] = [];
  for (const part of [...kept].sort((left, right) => left.rank - right.rank)) {
    const over = total() - max;
    if (over <= 0) break;
    const whole = part.text.length;
    const note = (left: number) => `… (${part.name}: ${left.toLocaleString("en-US")} characters left out of this turn to fit the model's context${part.readHow ? `; ${part.readHow}` : ""})`;
    // A head cut keeps the part's heading line above the note; the kept lines are whole lines.
    const heading = part.cut === "head" ? part.text.slice(0, part.text.indexOf("\n") + 1) : "";
    const room = whole - over - heading.length - note(whole).length - 1;
    if (room <= 0 && whole <= heading.length + note(whole).length) continue;
    let body = "";
    if (room > 0 && part.cut === "head") { const tail = part.text.slice(whole - room); const nl = tail.indexOf("\n"); body = nl >= 0 ? tail.slice(nl + 1) : ""; }
    else if (room > 0) { const head = part.text.slice(0, room); const nl = head.lastIndexOf("\n"); body = nl > 0 ? head.slice(0, nl) : ""; }
    const left = note(whole - heading.length - body.length);
    part.text = part.cut === "head" ? `${heading}${left}${body ? `\n${body}` : ""}` : body ? `${body}\n${left}` : left;
    cuts.push({ name: part.name, whole, kept: heading.length + body.length });
  }
  return { text: kept.map((part) => part.text).join(SEPARATOR), cuts };
}

/** The world split at its "## " sections: the notes first to go, then the sections from the tail (the head holds the operator's facts, goals and requests). */
export function worldParts(world: string, rank: { notes: number; tail: number }): PromptPart[] {
  const readHow = "space_world reads the whole world now (a long answer is paged: space_tool_result {call, offset})";
  const sections = world.split(/\n(?=## )/);
  return sections.map((text, index) => {
    const end = text.indexOf("\n");
    const name = text.startsWith("## ") ? (end < 0 ? text : text.slice(0, end)).trim() : "the world's head";
    const notes = name === "## Your notes";
    return { name, text, readHow: notes ? "space_notes {key} reads one note whole, {q} searches them by words" : readHow,
      rank: notes ? rank.notes : rank.tail + (sections.length - 1 - index) };
  });
}
