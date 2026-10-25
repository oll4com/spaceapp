import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ClipboardItem } from "@space/contracts";
import type { NousNote } from "@space/db";
import { NOUS_LOG_NOTE } from "./digest.js";

/**
 * Notes housekeeping (plan clipboard:bTm-5PGrt9po U5): Nous writes a turn log note almost every turn, and on stable 690 note
 * keys filled its world (2026-10-20). Log notes untouched for 48 hours are appended to the owner's archive file of the day,
 * `<var>/nous-notes-archive/<owner>/<YYYY-MM-DD>.md`; a note is deleted only after the file took it. Until 2026-10-21 they
 * went to a clipboard AGENT_NOTE record per turn (212 in a day filled the operator's Notes, operator order 2026-10-21).
 */
export const NOUS_NOTE_ARCHIVE_AGE_MS = 48 * 3_600_000;
const CLIPBOARD_ARCHIVE = /^Nous: notes archive (\d{4}-\d{2}-\d{2}) \(part \d+\/\d+\)\n\n/;

export function notesToArchive(notes: NousNote[], now: number): NousNote[] {
  return notes.filter((note) => NOUS_LOG_NOTE.test(note.key) && Date.parse(note.updatedAt) < now - NOUS_NOTE_ARCHIVE_AGE_MS)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.key.localeCompare(right.key));
}

/** The notes as archive entries, in the given order, each whole. */
export function archiveText(notes: NousNote[]): string {
  return notes.map((note) => `### ${note.key} (updated ${note.updatedAt.slice(0, 16).replace("T", " ")} UTC)\n${note.text}\n\n`).join("");
}

export function createNotesArchive(deps: {
  root: string;
  remove(owner: string, key: string): Promise<void>;
  /** The owner's clipboard AGENT_NOTE records and their delete, to move the old archive records into the files. */
  clipboard?: { list(owner: string): Promise<ClipboardItem[]>; remove(owner: string, id: string): Promise<unknown> };
  /** An archive write that failed (its notes or record stay for the next run). */
  warn?(error: unknown): void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const running = new Set<string>();
  const clipboardMoved = new Set<string>();

  async function append(owner: string, date: string, text: string) {
    const folder = join(deps.root, encodeURIComponent(owner));
    await mkdir(folder, { recursive: true, mode: 0o750 });
    await appendFile(join(folder, `${date}.md`), text, { mode: 0o640 });
  }

  // shortcut: moves the clipboard archive records written before 2026-10-21 once per process; remove when no instance has any.
  async function moveClipboardArchives(owner: string, clipboard: NonNullable<typeof deps.clipboard>) {
    const records = (await clipboard.list(owner)).filter((record) => CLIPBOARD_ARCHIVE.test(record.text))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const record of records) {
      const [title, date] = CLIPBOARD_ARCHIVE.exec(record.text)!;
      // Without the title and the "older than 48 hours" line; the record goes only after the file took its notes.
      const rest = record.text.slice(title.length);
      await append(owner, date!, `${rest.slice(rest.indexOf("\n\n") + 2)}\n\n`);
      await clipboard.remove(owner, record.id);
    }
  }

  return {
    /** Archives the owner's old log notes; returns the keys that left the notes. */
    async run(owner: string, notes: NousNote[]): Promise<Set<string>> {
      const moved = new Set<string>();
      if (running.has(owner)) return moved;
      running.add(owner);
      try {
        if (deps.clipboard && !clipboardMoved.has(owner)) {
          await moveClipboardArchives(owner, deps.clipboard).then(() => { clipboardMoved.add(owner); }, (error) => deps.warn?.(error));
        }
        const due = notesToArchive(notes, now());
        if (!due.length) return moved;
        try { await append(owner, new Date(now()).toISOString().slice(0, 10), archiveText(due)); }
        catch (error) { deps.warn?.(error); return moved; }
        for (const note of due) {
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
