/**
 * Extracts readable text from one attachment in a separate, memory-limited
 * process, so a large or malformed file never blocks the API event loop.
 *
 * argv: <kind> <source path> <output path> <max characters>
 * stdout: one JSON coverage object. The text is written to the output path.
 */
import { readFile, writeFile } from "node:fs/promises";

type Kind = "TEXT" | "PDF" | "DOCX" | "XLSX" | "PPTX";
interface Coverage { status: "FULL" | "PARTIAL" | "UNAVAILABLE"; method: string; chars: number | null; pages: number | null; truncated: boolean; reason: string | null }

const [kind, source, output, limitText] = process.argv.slice(2) as [Kind, string, string, string];
const maxChars = Math.max(1000, Number(limitText) || 400_000);
const maxPdfPages = 500;
const maxZipEntryBytes = 64 * 1024 * 1024;
const maxZipTotalBytes = 256 * 1024 * 1024;

class ReaderError extends Error {}
function finish(coverage: Coverage, text: string | null) {
  const write = text === null ? Promise.resolve() : writeFile(output, text, { encoding: "utf8", mode: 0o640 });
  return write.then(() => { process.stdout.write(JSON.stringify(coverage)); });
}
function bounded(text: string): { text: string; truncated: boolean } {
  return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated: false };
}
function result(method: string, raw: string, pages: number | null, partialReason: string | null = null): Promise<void> {
  const clean = raw.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!clean) return finish({ status: "UNAVAILABLE", method, chars: 0, pages, truncated: false, reason: partialReason ?? "The file contains no readable text." }, null);
  const { text, truncated } = bounded(clean);
  const reasons = [partialReason, truncated ? `Only the first ${maxChars.toLocaleString("en-US")} characters were kept.` : null].filter(Boolean);
  return finish({ status: reasons.length ? "PARTIAL" : "FULL", method, chars: text.length, pages, truncated, reason: reasons.join(" ") || null }, text);
}

async function zipEntries(path: string) {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await readFile(path));
  // Declared sizes are a first, cheap check; the process data limit is the hard bound.
  const declared = Object.values(zip.files).reduce((total, entry) => total + ((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0), 0);
  if (declared > maxZipTotalBytes) throw new ReaderError("The document expands to more data than can be read.");
  return {
    names: Object.keys(zip.files),
    async text(name: string): Promise<string | null> {
      const entry = zip.file(name);
      if (!entry) return null;
      // Refuse zip bombs before inflating an entry.
      const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
      if (size > maxZipEntryBytes) throw new ReaderError("A part of the document is too large to read.");
      return entry.async("string");
    }
  };
}
async function xml(text: string) {
  const { DOMParser } = await import("@xmldom/xmldom");
  const ignore = () => undefined;
  return new DOMParser({ errorHandler: { warning: ignore, error: ignore, fatalError: ignore } }).parseFromString(text, "text/xml");
}
function texts(node: { getElementsByTagName(name: string): ArrayLike<{ textContent: string | null }> }, tag: string): string[] {
  return Array.from(node.getElementsByTagName(tag)).map((element) => element.textContent ?? "");
}
const byNumber = (prefix: string) => (a: string, b: string) => Number(a.slice(prefix.length).replace(/\D/g, "")) - Number(b.slice(prefix.length).replace(/\D/g, ""));

async function readPdf() {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(await readFile(source)), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const document = await task.promise;
    const pages = document.numPages;
    const parts: string[] = [];
    let empty = 0, length = 0;
    const last = Math.min(pages, maxPdfPages);
    for (let number = 1; number <= last && length <= maxChars; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "")).join("").trim();
      if (!text) empty += 1;
      parts.push(`--- Page ${number} ---\n${text}`);
      length += text.length;
      page.cleanup();
    }
    const read = parts.length;
    const reasons = [read < pages ? `Read ${read} of ${pages} pages.` : null,
      empty ? `${empty} of ${read} pages have no text layer (scanned or image-only); view them visually.` : null].filter(Boolean).join(" ");
    if (empty === read) return finish({ status: "UNAVAILABLE", method: "pdf-text", chars: 0, pages, truncated: false,
      reason: "The PDF has no text layer (scanned or image-only); view it visually instead." }, null);
    return result("pdf-text", parts.join("\n\n"), pages, reasons || null);
  } finally {
    await task.destroy();
  }
}
async function readDocx() {
  await zipEntries(source);
  const { default: mammoth } = await import("mammoth");
  const extracted = await mammoth.extractRawText({ path: source });
  return result("docx-text", extracted.value, null);
}
async function readXlsx() {
  const zip = await zipEntries(source);
  const shared = await zip.text("xl/sharedStrings.xml");
  const strings = shared ? Array.from((await xml(shared)).getElementsByTagName("si")).map((item) => texts(item, "t").join("")) : [];
  const workbook = await zip.text("xl/workbook.xml");
  const rels = await zip.text("xl/_rels/workbook.xml.rels");
  const targets = new Map<string, string>();
  if (rels) for (const rel of Array.from((await xml(rels)).getElementsByTagName("Relationship"))) {
    targets.set(rel.getAttribute("Id") ?? "", `xl/${(rel.getAttribute("Target") ?? "").replace(/^\/?xl\//, "").replace(/^\//, "")}`);
  }
  const sheets = workbook ? Array.from((await xml(workbook)).getElementsByTagName("sheet")).map((sheet) => ({
    name: sheet.getAttribute("name") ?? "Sheet", path: targets.get(sheet.getAttribute("r:id") ?? "") ?? "" })) : [];
  const parts: string[] = [];
  for (const sheet of sheets.length ? sheets : zip.names.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort(byNumber("xl/worksheets/sheet")).map((path, index) => ({ name: `Sheet ${index + 1}`, path }))) {
    const body = sheet.path ? await zip.text(sheet.path) : null;
    if (body === null) continue;
    const rows = Array.from((await xml(body)).getElementsByTagName("row")).map((row) => Array.from(row.getElementsByTagName("c")).map((cell) => {
      const type = cell.getAttribute("t");
      const value = cell.getElementsByTagName("v")[0]?.textContent ?? "";
      const text = type === "s" ? strings[Number(value)] ?? "" : type === "inlineStr" ? texts(cell, "t").join("") : value;
      return `${cell.getAttribute("r") ?? ""}=${text.replace(/[\t\n]/g, " ")}`;
    }).filter((cell) => !cell.endsWith("=")).join("\t")).filter(Boolean);
    parts.push(`## Sheet: ${sheet.name}\n${rows.join("\n")}`);
    if (parts.join("\n").length > maxChars) break;
  }
  return result("xlsx-cells", parts.join("\n\n"), sheets.length || null);
}
async function readPptx() {
  const zip = await zipEntries(source);
  const slides = zip.names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort(byNumber("ppt/slides/slide"));
  const parts: string[] = [];
  for (const [index, name] of slides.entries()) {
    const body = await zip.text(name);
    const paragraphs = body ? Array.from((await xml(body)).getElementsByTagName("a:p")).map((paragraph) => texts(paragraph, "a:t").join("")).filter(Boolean) : [];
    parts.push(`--- Slide ${index + 1} ---\n${paragraphs.join("\n")}`);
  }
  return result("pptx-text", parts.join("\n\n"), slides.length || null);
}
async function readText() {
  const buffer = await readFile(source);
  if (buffer.subarray(0, 8192).includes(0)) {
    return finish({ status: "UNAVAILABLE", method: "text", chars: null, pages: null, truncated: false, reason: "The file is binary, not text." }, null);
  }
  return result("text", buffer.toString("utf8"), null);
}

const readers: Record<Kind, () => Promise<void>> = { TEXT: readText, PDF: readPdf, DOCX: readDocx, XLSX: readXlsx, PPTX: readPptx };
const reader = readers[kind];
if (!reader) throw new Error("Unknown attachment kind.");
// Reasons are fixed strings: text from inside a file never reaches the model through an error message.
await reader().catch((error: unknown) => finish({ status: "UNAVAILABLE", method: kind.toLowerCase(), chars: null, pages: null, truncated: false,
  reason: error instanceof ReaderError ? error.message : "The file could not be read; it may be damaged or protected." }, null));
