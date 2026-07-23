import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  browserBookmarkImportResponseSchema,
  browserBookmarkListResponseSchema,
  browserBookmarkSchema,
  type BrowserBookmark,
  type PaneBrowserSession
} from "@space/contracts";

interface ChromeBookmarkNode {
  id?: string;
  name?: string;
  type?: string;
  url?: string;
  date_added?: string;
  children?: ChromeBookmarkNode[];
}

interface ChromeBookmarksFile {
  roots?: Record<string, ChromeBookmarkNode>;
  version?: number;
}

export interface BrowserBookmarkImportCandidate {
  title: string;
  url: string;
}

const maxImportCandidates = 500;
const maxImportTraversalNodes = 10000;

function defaultBookmarksFile(): ChromeBookmarksFile {
  return {
    roots: {
      bookmark_bar: { children: [], id: "1", name: "Bookmarks bar", type: "folder" },
      other: { children: [], id: "2", name: "Other bookmarks", type: "folder" },
      synced: { children: [], id: "3", name: "Mobile bookmarks", type: "folder" }
    },
    version: 1
  };
}

function bookmarksPath(profilePath: string): string {
  return join(profilePath, "Default", "Bookmarks");
}

function chromeDateToIso(value: string | undefined): string | null {
  if (!value) return null;
  const micros = Number.parseInt(value, 10);
  if (!Number.isFinite(micros)) return null;
  const epochOffsetMicros = 11644473600000000;
  const millis = Math.floor((micros - epochOffsetMicros) / 1000);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return new Date(millis).toISOString();
}

function isoToChromeDate(date = new Date()): string {
  const epochOffsetMicros = 11644473600000000;
  return String(date.getTime() * 1000 + epochOffsetMicros);
}

async function readBookmarksFile(profilePath: string): Promise<ChromeBookmarksFile> {
  try {
    const text = await readFile(bookmarksPath(profilePath), "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultBookmarksFile();
    return parsed as ChromeBookmarksFile;
  } catch {
    return defaultBookmarksFile();
  }
}

async function writeBookmarksFile(profilePath: string, data: ChromeBookmarksFile): Promise<void> {
  const file = bookmarksPath(profilePath);
  await mkdir(dirname(file), { recursive: true, mode: 0o750 });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o640 });
}

function collectBookmarks(node: ChromeBookmarkNode | undefined, output: BrowserBookmark[]) {
  if (!node) return;
  if (node.type === "url" && node.id && node.url) {
    const parsed = browserBookmarkSchema.safeParse({
      id: node.id,
      title: node.name || node.url,
      url: node.url,
      addedAt: chromeDateToIso(node.date_added)
    });
    if (parsed.success) output.push(parsed.data);
  }
  for (const child of node.children ?? []) collectBookmarks(child, output);
}

function maxBookmarkId(data: ChromeBookmarksFile): number {
  let max = 0;
  const visit = (node: ChromeBookmarkNode | undefined) => {
    if (!node) return;
    const numeric = Number.parseInt(node.id ?? "", 10);
    if (Number.isFinite(numeric)) max = Math.max(max, numeric);
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of Object.values(data.roots ?? {})) visit(root);
  return max;
}

function bookmarkBar(data: ChromeBookmarksFile): ChromeBookmarkNode {
  const roots = (data.roots ??= defaultBookmarksFile().roots ?? {});
  roots.bookmark_bar ??= { children: [], id: "1", name: "Bookmarks bar", type: "folder" };
  roots.bookmark_bar.children ??= [];
  return roots.bookmark_bar;
}

function importedFolder(data: ChromeBookmarksFile): ChromeBookmarkNode {
  const bar = bookmarkBar(data);
  const existing = bar.children!.find((child) => child.type === "folder" && child.name === "Space imports");
  if (existing) {
    existing.children ??= [];
    return existing;
  }
  const folder: ChromeBookmarkNode = {
    children: [],
    date_added: isoToChromeDate(),
    id: String(maxBookmarkId(data) + 1),
    name: "Space imports",
    type: "folder"
  };
  bar.children!.push(folder);
  return folder;
}

function normalizeBookmarkTitle(value: unknown, fallback: string): string {
  const title = typeof value === "string" ? value.trim() : "";
  return (title || fallback).slice(0, 300);
}

function collectImportCandidates(node: ChromeBookmarkNode | undefined, output: BrowserBookmarkImportCandidate[], state: { visited: number; skipped: number }) {
  if (!node || output.length >= maxImportCandidates) return;
  state.visited += 1;
  if (state.visited > maxImportTraversalNodes) {
    state.skipped += 1;
    return;
  }
  if (node.type === "url") {
    if (typeof node.url === "string" && node.url.trim()) {
      output.push({
        title: normalizeBookmarkTitle(node.name, node.url),
        url: node.url.trim()
      });
    } else {
      state.skipped += 1;
    }
    return;
  }
  for (const child of node.children ?? []) collectImportCandidates(child, output, state);
}

export function parseChromeBookmarksImport(buffer: Buffer): { bookmarks: BrowserBookmarkImportCandidate[]; skippedCount: number } {
  const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Bookmark import must be a Chrome/Chromium Bookmarks JSON object.");
  }
  const file = parsed as ChromeBookmarksFile;
  const bookmarks: BrowserBookmarkImportCandidate[] = [];
  const state = { visited: 0, skipped: 0 };
  for (const root of Object.values(file.roots ?? {})) collectImportCandidates(root, bookmarks, state);
  return { bookmarks, skippedCount: state.skipped };
}

export async function listManagedBrowserBookmarks(session: PaneBrowserSession) {
  const data = await readBookmarksFile(session.profilePath);
  const bookmarks: BrowserBookmark[] = [];
  for (const root of Object.values(data.roots ?? {})) collectBookmarks(root, bookmarks);
  return browserBookmarkListResponseSchema.parse({
    sessionId: session.sessionId,
    paneId: session.paneId,
    roomId: session.roomId,
    bookmarks
  });
}

export async function addManagedBrowserBookmark(session: PaneBrowserSession, input: { title?: string; url: string }) {
  const data = await readBookmarksFile(session.profilePath);
  const bar = bookmarkBar(data);
  const id = String(maxBookmarkId(data) + 1);
  const bookmark: ChromeBookmarkNode = {
    date_added: isoToChromeDate(),
    id,
    name: input.title?.trim() || input.url,
    type: "url",
    url: input.url
  };
  bar.children!.push(bookmark);
  await writeBookmarksFile(session.profilePath, data);
  return browserBookmarkSchema.parse({
    id,
    title: bookmark.name,
    url: bookmark.url,
    addedAt: chromeDateToIso(bookmark.date_added)
  });
}

export async function importManagedBrowserBookmarks(
  session: PaneBrowserSession,
  input: { bookmarks: BrowserBookmarkImportCandidate[]; skippedCount?: number }
) {
  const data = await readBookmarksFile(session.profilePath);
  const existingBookmarks: BrowserBookmark[] = [];
  for (const root of Object.values(data.roots ?? {})) collectBookmarks(root, existingBookmarks);
  const existingUrls = new Set(existingBookmarks.map((bookmark) => bookmark.url));
  const folder = importedFolder(data);
  let nextId = maxBookmarkId(data) + 1;
  let importedCount = 0;
  let skippedCount = input.skippedCount ?? 0;
  for (const candidate of input.bookmarks.slice(0, maxImportCandidates)) {
    if (existingUrls.has(candidate.url)) {
      skippedCount += 1;
      continue;
    }
    const bookmark: ChromeBookmarkNode = {
      date_added: isoToChromeDate(),
      id: String(nextId++),
      name: normalizeBookmarkTitle(candidate.title, candidate.url),
      type: "url",
      url: candidate.url
    };
    folder.children!.push(bookmark);
    existingUrls.add(candidate.url);
    importedCount += 1;
  }
  if (input.bookmarks.length > maxImportCandidates) {
    skippedCount += input.bookmarks.length - maxImportCandidates;
  }
  await writeBookmarksFile(session.profilePath, data);
  const list = await listManagedBrowserBookmarks(session);
  return browserBookmarkImportResponseSchema.parse({
    ...list,
    importedCount,
    skippedCount
  });
}

export async function exportManagedBrowserBookmarks(session: PaneBrowserSession): Promise<ChromeBookmarksFile> {
  return readBookmarksFile(session.profilePath);
}
