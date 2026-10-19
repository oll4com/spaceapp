import { describe, expect, it } from "vitest";
import { extractCvPhoto } from "../src/job-apply/cv-photo.js";
import { cvPdf, sampleJpeg } from "./fixtures/cv-photo-pdf.js";

describe("CV photo extraction (operator rule 2026-10-17)", () => {
  it("copies the largest JPEG of the CV byte for byte, at its own size", () => {
    const photo = sampleJpeg(64, 0x22);
    const pdf = cvPdf([
      { width: 940, height: 1329, filter: "/FlateDecode", data: Buffer.alloc(80, 0x33) },
      { width: 32, height: 32, filter: "/DCTDecode", data: sampleJpeg(8) },
      { width: 600, height: 600, filter: "[ /DCTDecode ]", data: photo, lengthRef: true }
    ]);
    const extracted = extractCvPhoto(pdf);
    expect(extracted).toMatchObject({ width: 600, height: 600 });
    expect(extracted!.bytes.equals(photo)).toBe(true);
  });

  it("finds nothing without a complete plain JPEG stream", () => {
    expect(extractCvPhoto(cvPdf([{ width: 940, height: 1329, filter: "/FlateDecode", data: Buffer.alloc(80) }]))).toBeNull();
    expect(extractCvPhoto(cvPdf([{ width: 600, height: 600, filter: "[ /FlateDecode /DCTDecode ]", data: sampleJpeg() }]))).toBeNull();
    expect(extractCvPhoto(cvPdf([{ width: 600, height: 600, filter: "/DCTDecode", data: sampleJpeg().subarray(0, 20) }]))).toBeNull();
    expect(extractCvPhoto(Buffer.from("not a pdf"))).toBeNull();
  });
});
