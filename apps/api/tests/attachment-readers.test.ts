import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyAttachment, describeCoverage, readAttachment, readAttachments, readBufferText, type AttachmentReadInput } from "../src/attachment-readers.js";

vi.setConfig({ testTimeout: 60_000 });
const workerPath = fileURLToPath(new URL("../src/attachment-reader-worker.ts", import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const dir = await mkdtemp(join(tmpdir(), "dot-readers-")); roots.push(dir); return dir; }
let counter = 0;
async function file(dir: string, name: string, data: string | Buffer, mimeType: string): Promise<AttachmentReadInput> {
  const sourcePath = join(dir, name);
  await writeFile(sourcePath, data);
  counter += 1;
  return { artifactId: `artifact:${counter}`, sourcePath, filename: name, mimeType, byteSize: Buffer.byteLength(data), sha256: counter.toString(16).padStart(64, "a") };
}
function pdf(pages: string[]): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  pages.forEach((text, i) => {
    const content = text ? `BT /F1 18 Tf 72 720 Td (${text}) Tj ET` : "";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(out)); out += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(out);
}
async function zip(entries: Record<string, string>): Promise<Buffer> {
  const archive = new JSZip();
  for (const [name, body] of Object.entries(entries)) archive.file(name, body);
  return archive.generateAsync({ type: "nodebuffer" });
}
const options = (outputDir: string) => ({ outputDir, workerPath, timeoutMs: 30_000 });

describe("attachment readers", () => {
  it("classifies files by type and extension", () => {
    expect(classifyAttachment("application/pdf", "a.bin")).toBe("PDF");
    expect(classifyAttachment("application/octet-stream", "report.docx")).toBe("DOCX");
    expect(classifyAttachment("application/octet-stream", "data.xlsx")).toBe("XLSX");
    expect(classifyAttachment("application/octet-stream", "deck.pptx")).toBe("PPTX");
    expect(classifyAttachment("application/octet-stream", "main.py")).toBe("TEXT");
    expect(classifyAttachment("image/svg+xml", "logo.svg")).toBe("TEXT");
    expect(classifyAttachment("image/png", "a.png")).toBe("IMAGE");
    expect(classifyAttachment("audio/mpeg", "a.mp3")).toBe("AUDIO");
    expect(classifyAttachment("video/mp4", "a.mp4")).toBe("VIDEO");
    expect(classifyAttachment("application/zip", "a.zip")).toBe("OTHER");
  });

  it("reads text fully, reports truncation and refuses binary data", async () => {
    const dir = await root();
    const out = join(dir, "out");
    const notes = await readAttachment(await file(dir, "notes.md", "# Plan\nShip on Friday.", "text/markdown"), options(out));
    expect(notes.coverage).toMatchObject({ status: "FULL", method: "text", chars: 22, truncated: false });
    expect(await readFile(notes.outputPath!, "utf8")).toBe("# Plan\nShip on Friday.");
    const long = await readAttachment(await file(dir, "long.txt", "x".repeat(3000), "text/plain"), { ...options(out), maxChars: 1000 });
    expect(long.coverage).toMatchObject({ status: "PARTIAL", chars: 1000, truncated: true, reason: expect.stringMatching(/first 1,000 characters/) });
    const binary = await readAttachment(await file(dir, "data.txt", Buffer.from([0x41, 0, 0x42]), "text/plain"), options(out));
    expect(binary).toMatchObject({ coverage: { status: "UNAVAILABLE", reason: "The file is binary, not text." }, outputPath: null });
  });

  it("reads PDF text page by page and flags pages without a text layer", async () => {
    const dir = await root();
    const out = join(dir, "out");
    const full = await readAttachment(await file(dir, "quote.pdf", pdf(["Supplier quote 1200 EUR", "Delivery in 14 days"]), "application/pdf"), options(out));
    expect(full.coverage).toMatchObject({ status: "FULL", method: "pdf-text", pages: 2 });
    const text = await readFile(full.outputPath!, "utf8");
    expect(text).toContain("--- Page 1 ---\nSupplier quote 1200 EUR");
    expect(text).toContain("--- Page 2 ---\nDelivery in 14 days");
    // A mail attachment held in memory reads the same way, in a folder removed afterwards (Nous space_mail_read, 2026-10-27).
    const buffer = await readBufferText(pdf(["Statement October", "Balance 1200 EUR"]), "statement.pdf", "application/pdf", { workerPath, timeoutMs: 30_000 });
    expect(buffer).toMatchObject({ status: "FULL", reason: null });
    expect(buffer.text).toContain("--- Page 2 ---\nBalance 1200 EUR");
    const mixed = await readAttachment(await file(dir, "mixed.pdf", pdf(["Only page with text", ""]), "application/pdf"), options(out));
    expect(mixed.coverage).toMatchObject({ status: "PARTIAL", reason: expect.stringMatching(/1 of 2 pages have no text layer/) });
    const scanned = await readAttachment(await file(dir, "scan.pdf", pdf(["", ""]), "application/pdf"), options(out));
    expect(scanned).toMatchObject({ coverage: { status: "UNAVAILABLE", reason: expect.stringMatching(/no text layer/) }, outputPath: null });
    const broken = await readAttachment(await file(dir, "broken.pdf", "not a pdf", "application/pdf"), options(out));
    // Reasons are fixed text: nothing from inside a file reaches the model through an error.
    expect(broken.coverage).toMatchObject({ status: "UNAVAILABLE", reason: "The file could not be read; it may be damaged or protected." });
  });

  it("reads Word, Excel and PowerPoint files", async () => {
    const dir = await root();
    const out = join(dir, "out");
    const docx = await zip({
      "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Contract renewal terms</w:t></w:r></w:p><w:p><w:r><w:t>Notice period: 30 days</w:t></w:r></w:p></w:body></w:document>`
    });
    const word = await readAttachment(await file(dir, "terms.docx", docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), options(out));
    expect(word.coverage).toMatchObject({ status: "FULL", method: "docx-text" });
    expect(await readFile(word.outputPath!, "utf8")).toMatch(/Contract renewal terms\s+Notice period: 30 days/);

    const xlsx = await zip({
      "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Prices" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Item</t></si><si><t>Laptop</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Price</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>1499.5</v></c></row></sheetData></worksheet>`
    });
    const sheet = await readAttachment(await file(dir, "prices.xlsx", xlsx, "application/octet-stream"), options(out));
    expect(sheet.coverage).toMatchObject({ status: "FULL", method: "xlsx-cells", pages: 1 });
    expect(await readFile(sheet.outputPath!, "utf8")).toBe("## Sheet: Prices\nA1=Item\tB1=Price\nA2=Laptop\tB2=1499.5");

    const slide = (text: string) => `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const pptx = await zip({ "ppt/slides/slide10.xml": slide("Appendix"), "ppt/slides/slide2.xml": slide("Roadmap"), "ppt/slides/slide1.xml": slide("Welcome") });
    const deck = await readAttachment(await file(dir, "deck.pptx", pptx, "application/octet-stream"), options(out));
    expect(deck.coverage).toMatchObject({ status: "FULL", method: "pptx-text", pages: 3 });
    expect(await readFile(deck.outputPath!, "utf8")).toBe("--- Slide 1 ---\nWelcome\n\n--- Slide 2 ---\nRoadmap\n\n--- Slide 3 ---\nAppendix");
  });

  it("uses vision for supported images and is honest about audio and other files", async () => {
    const dir = await root();
    const out = join(dir, "out");
    expect((await readAttachment(await file(dir, "a.png", "png", "image/png"), options(out))).coverage).toMatchObject({ status: "FULL", method: "vision" });
    expect((await readAttachment(await file(dir, "a.gif", "gif", "image/gif"), options(out))).coverage).toMatchObject({ status: "UNAVAILABLE" });
    expect((await readAttachment(await file(dir, "a.mp3", "mp3", "audio/mpeg"), options(out))).coverage)
      .toMatchObject({ status: "UNAVAILABLE", reason: expect.stringMatching(/No transcription service/) });
    expect((await readAttachment(await file(dir, "a.zip", "zip", "application/zip"), options(out))).coverage).toMatchObject({ status: "UNAVAILABLE", method: "none" });
    expect((await readAttachment({ ...await file(dir, "big.txt", "x", "text/plain"), byteSize: 60 * 1024 * 1024 }, options(out))).coverage)
      .toMatchObject({ status: "UNAVAILABLE", reason: expect.stringMatching(/too large/) });
  });

  it.skipIf(!existsSync("/usr/bin/ffmpeg") || !existsSync("/usr/bin/ffprobe"))("samples frames from a video", async () => {
    const dir = await root();
    const video = join(dir, "clip.mp4");
    execFileSync("/usr/bin/ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10", "-pix_fmt", "yuv420p", video]);
    const result = await readAttachment({ artifactId: "artifact:video", sourcePath: video, filename: "clip.mp4", mimeType: "video/mp4",
      byteSize: (await readFile(video)).byteLength, sha256: "b".repeat(64) }, options(join(dir, "out")));
    expect(result.coverage).toMatchObject({ status: "PARTIAL", method: "video-frames", reason: expect.stringMatching(/audio track is not transcribed/) });
    expect(result.coverage.pages).toBeGreaterThanOrEqual(1);
    expect(describeCoverage(result)).toMatch(/frames in .*-frames$/);
  });

  it("reuses an earlier read from a cache outside the workspace, never caches failures, and stops when the time budget runs out", async () => {
    const dir = await root();
    const out = join(dir, "out");
    const cacheDir = join(dir, "cache");
    const input = await file(dir, "plan.txt", "Plan A", "text/plain");
    const first = await readAttachment(input, { ...options(out), cacheDir });
    const again = await readAttachment(input, { ...options(out), cacheDir, workerPath: join(dir, "missing-worker.js") });
    expect(again).toEqual(first);
    // A crash is not remembered: the next read tries again.
    const flaky = await file(dir, "later.txt", "Later", "text/plain");
    expect((await readAttachment(flaky, { ...options(out), cacheDir, workerPath: join(dir, "missing-worker.js") })).coverage.status).toBe("UNAVAILABLE");
    expect((await readAttachment(flaky, { ...options(out), cacheDir })).coverage.status).toBe("FULL");
    // The cache is outside the workspace, so a Dot cannot forge coverage there.
    expect((await import("node:fs")).readdirSync(out).some((name) => name.endsWith(".json"))).toBe(false);
    const [late] = await readAttachments([await file(dir, "late.txt", "Late", "text/plain")], { ...options(out), budgetMs: 0 });
    expect(late!.coverage).toMatchObject({ status: "UNAVAILABLE", reason: expect.stringMatching(/ran out/) });
    expect(describeCoverage(first)).toBe(`read FULL (6 characters); text at ${first.outputPath}`);
  });
});

describe("dots-v1 evaluation fixtures", () => {
  it("read with the coverage their cases expect", async () => {
    const fixtures = fileURLToPath(new URL("../../../evals/dots-v1/fixtures/", import.meta.url));
    const out = await root();
    const types: Record<string, string> = { "orders.csv": "text/csv", "meeting-notes.md": "text/markdown", "invoice.pdf": "application/pdf",
      "scanned-receipt.pdf": "application/pdf", "budget.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "memo.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "red-square.png": "image/png" };
    const results = Object.fromEntries(await Promise.all(Object.entries(types).map(async ([name, mimeType]) => {
      const data = await readFile(join(fixtures, name));
      const result = await readAttachment(await file(await root(), name, data, mimeType), options(out));
      return [name, { status: result.coverage.status, text: result.outputPath ? await readFile(result.outputPath, "utf8") : "" }] as const;
    })));
    expect(results["orders.csv"]).toMatchObject({ status: "FULL", text: expect.stringContaining("A-103,North,310.00") });
    expect(results["meeting-notes.md"]).toMatchObject({ status: "FULL", text: expect.stringContaining("Helios Pack") });
    expect(results["invoice.pdf"]).toMatchObject({ status: "FULL", text: expect.stringContaining("1284.50") });
    expect(results["scanned-receipt.pdf"]!.status).toBe("UNAVAILABLE");
    expect(results["budget.xlsx"]).toMatchObject({ status: "FULL", text: expect.stringMatching(/B2=1800[\s\S]*B5=610/) });
    expect(results["memo.docx"]).toMatchObject({ status: "FULL", text: expect.stringContaining("2026-12-15") });
    expect(results["red-square.png"]!.status).toBe("FULL");
  });
});
