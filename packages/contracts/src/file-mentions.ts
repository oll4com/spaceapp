import { SPACE_AGENT_HOME, SPACE_INSTALL_ROOT } from "./host-paths.js";

// Files a text names (operator 4/11 13:55 BKK, nous_msg:8e7e6c25): an Agent File id or a path of the agent workspace or Nous's folder.
// The web turns each into a link to the Agent Files preview; the server files each path in Agent Files and writes its id beside it.

const ARTIFACT = String.raw`artifact:[A-Za-z0-9_-]{6,80}(?![A-Za-z0-9_-])`;
// shortcut: a path with spaces or brackets is not found; quote-free paths are what agents and Nous write.
/** A path inside a regular expression, its special characters escaped. */
const escaped = (path: string) => path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const PATH = String.raw`(?:~\/agent-workspace\/|${escaped(SPACE_AGENT_HOME)}\/agent-workspace\/|${escaped(SPACE_INSTALL_ROOT)}\/var\/nous-workspace\/|nous\/)` +
  String.raw`[^\s"'\`<>()[\]{}|*]*\.[A-Za-z0-9]{1,10}(?![A-Za-z0-9_-])`;
const FILE_MENTION = new RegExp(String.raw`(?<![\w.:/~-])(?:${ARTIFACT}|${PATH})`, "g");

export interface FileMention {
  start: number;
  end: number;
  /** The id (`artifact:…`) or the path as written. */
  text: string;
  kind: "artifact" | "path";
}

export function findFileMentions(text: string): FileMention[] {
  return [...text.matchAll(FILE_MENTION)].map((match) => ({
    start: match.index, end: match.index + match[0].length, text: match[0], kind: match[0].startsWith("artifact:") ? "artifact" as const : "path" as const
  }));
}

/** The Agent Files folder a mentioned file goes to: interview preparation under Documents/Interviews, the rest under Documents/Reports. */
export function fileMentionFolder(path: string, hint = ""): string {
  return /interview/i.test(`${path} ${hint}`) ? "Documents/Interviews" : "Documents/Reports";
}

/**
 * A file a Needs you card names (`payload.files`, operator nous_msg:0cb8d563 «θελω να βλεπω κατευθειαν το αρχειο και να μπορώ να το ανοιξω
 * απο εδω»): the web's chip and the Nous app show its name and open it (`/api/artifacts/<id>/file`).
 */
export interface AgentFileRef { artifactId: string; name: string; folder: string | null; mime: string }

const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const wordsOf = (text: string) => new Set(fold(text).match(/[\p{L}\p{N}]{2,}/gu) ?? []);
const squash = (text: string) => fold(text).replace(/\s*[/›>»]\s*/g, "/");
/** `needle` in `haystack` (both folded) with no letter or digit right before or after it. */
const containsWord = (haystack: string, needle: string) => {
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    if (!/[\p{L}\p{N}]/u.test(haystack[at - 1] ?? "") && !/[\p{L}\p{N}]/u.test(haystack[at + needle.length] ?? "")) return true;
  }
  return false;
};
const stemOf = (name: string) => name.replace(/\.[A-Za-z0-9]{1,10}$/, "");
const AGENT_FILES_AT = /Agent Files\s*[›>»:/]\s*/gi;

/**
 * The owner's Agent Files a card's text names: by `artifact:<id>`, by file name (or a name without its extension of 12+ characters or
 * several words), and for "Agent Files › Folder" naming no file of that folder, the folder's only file or those whose name shares the most
 * words with the text (the folder's own words aside). In `files`' order.
 */
export function agentFilesNamedIn(text: string, files: readonly AgentFileRef[]): AgentFileRef[] {
  const folded = fold(text);
  const ids = new Set(findFileMentions(text).filter((mention) => mention.kind === "artifact").map((mention) => mention.text));
  const found = new Set(files.filter((file) => {
    const stem = fold(stemOf(file.name));
    return ids.has(file.artifactId) || (file.name.length >= 5 && containsWord(folded, fold(file.name)))
      || ((stem.length >= 12 || /\s/.test(stem.trim())) && containsWord(folded, stem));
  }));
  const folders = [...new Set(files.map((file) => file.folder).filter((folder): folder is string => Boolean(folder)))]
    .sort((left, right) => right.length - left.length);
  const textWords = wordsOf(text);
  for (const at of text.matchAll(AGENT_FILES_AT)) {
    const after = squash(text.slice(at.index + at[0].length));
    const folder = folders.find((name) => after.startsWith(squash(name)) && !/[\p{L}\p{N}]/u.test(after[squash(name).length] ?? ""));
    const inFolder = files.filter((file) => file.folder === folder);
    if (!folder || inFolder.some((file) => found.has(file))) continue;
    const folderWords = wordsOf(folder);
    const score = (file: AgentFileRef) => [...wordsOf(stemOf(file.name))].filter((word) => textWords.has(word) && !folderWords.has(word)).length;
    const best = Math.max(...inFolder.map(score));
    for (const file of inFolder) if (inFolder.length === 1 || (best > 0 && score(file) === best)) found.add(file);
  }
  return files.filter((file) => found.has(file));
}

/** A card's `payload.files` as the server resolved them; none on a card raised before 6/11 until Needs you is read. */
export function needsYouFiles(record: { payload: Record<string, unknown> }): AgentFileRef[] {
  const files = record.payload.files;
  return Array.isArray(files) ? files.filter((file): file is AgentFileRef => typeof file === "object" && file !== null
    && typeof (file as AgentFileRef).artifactId === "string" && typeof (file as AgentFileRef).name === "string") : [];
}
