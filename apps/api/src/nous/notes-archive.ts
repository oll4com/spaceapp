import type { NousNote } from "@space/db";
import { NOUS_LOG_NOTE } from "./digest.js";

/**
 * Notes housekeeping (plan clipboard:bTm-5PGrt9po U5): Nous writes a turn log note almost every turn, and on stable 690 note
 * keys filled its world (2026-10-20). Log notes untouched for 48 hours move into clipboard AGENT_NOTE archives, "Nous: notes
 * archive <date> (part n/N)", each within the clipboard's agent note limit; a note is deleted only after the records holding it were saved.
 */
export const NOUS_NOTE_ARCHIVE_AGE_MS = 48 * 3_600_000;

export function notesToArchive(notes: NousNote[], now: number): NousNote[] {
  return notes.filter((note) => NOUS_LOG_NOTE.test(note.key) && Date.parse(note.updatedAt) < now - NOUS_NOTE_ARCHIVE_AGE_MS)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.key.localeCompare(right.key));
}

/**
 * One archive record's text at most (stable 2026-10-20: one 100,000-character archive failed "Agent notes may contain at most
 * 10000 characters", so nothing was archived). Below agentClipboardNoteMaxCharacters, with room for the header.
 */
export const NOUS_NOTE_ARCHIVE_PART_CHARS = 9_500;
const HEADER_RESERVE = 200;

/**
 * The archive records, oldest notes first, each at most NOUS_NOTE_ARCHIVE_PART_CHARS characters. A note is never cut unless it
 * alone is over the limit: then it is split into numbered pieces, one or more per record. `keys`: the notes with a piece in it.
 */
export function archiveTexts(notes: NousNote[], now: number): Array<{ text: string; keys: string[] }> {
  const date = new Date(now).toISOString().slice(0, 10);
  const budget = NOUS_NOTE_ARCHIVE_PART_CHARS - HEADER_RESERVE;
  const heading = (note: NousNote, piece?: string) => `### ${note.key} (updated ${note.updatedAt.slice(0, 16).replace("T", " ")} UTC${piece ? `, piece ${piece}` : ""})\n`;
  const pieces: Array<{ key: string; text: string }> = [];
  for (const note of notes) {
    const whole = `${heading(note)}${note.text}`;
    if (whole.length <= budget) { pieces.push({ key: note.key, text: whole }); continue; }
    // Code points, so a split never cuts a character in two.
    const chars = Array.from(note.text);
    const size = budget - heading(note, "999/999").length;
    const count = Math.ceil(chars.length / size);
    for (let index = 0; index < count; index += 1) {
      pieces.push({ key: note.key, text: `${heading(note, `${index + 1}/${count}`)}${chars.slice(index * size, (index + 1) * size).join("")}` });
    }
  }
  const parts: Array<{ entries: string[]; keys: string[] }> = [];
  for (const piece of pieces) {
    const last = parts.at(-1);
    if (last && last.entries.join("\n\n").length + 2 + piece.text.length <= budget) {
      last.entries.push(piece.text);
      if (!last.keys.includes(piece.key)) last.keys.push(piece.key);
    } else parts.push({ entries: [piece.text], keys: [piece.key] });
  }
  return parts.map((part, index) => ({ keys: part.keys,
    text: `Nous: notes archive ${date} (part ${index + 1}/${parts.length})\n\nNous's turn and day log notes older than 48 hours, moved out of its world.\n\n${part.entries.join("\n\n")}` }));
}

export function createNotesArchive(deps: {
  save(owner: string, text: string): Promise<unknown>;
  remove(owner: string, key: string): Promise<void>;
  /** A record that could not be saved (its notes stay for the next run). */
  warn?(error: unknown): void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const running = new Set<string>();
  return {
    /** Archives the owner's old log notes; returns the keys that left the notes. */
    async run(owner: string, notes: NousNote[]): Promise<Set<string>> {
      const moved = new Set<string>();
      const due = notesToArchive(notes, now());
      if (!due.length || running.has(owner)) return moved;
      running.add(owner);
      try {
        // A note goes only after every record holding it was saved; a failed record keeps its notes for the next tick.
        const unsaved = new Set<string>();
        for (const part of archiveTexts(due, now())) {
          try { await deps.save(owner, part.text); }
          catch (error) { deps.warn?.(error); for (const key of part.keys) unsaved.add(key); }
        }
        for (const note of due) {
          if (unsaved.has(note.key)) continue;
          await deps.remove(owner, note.key);
          moved.add(note.key);
        }
      } finally {
        running.delete(owner);
      }
      return moved;
    }
  };
}
