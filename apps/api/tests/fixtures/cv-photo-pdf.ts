// Minimal PDFs with image XObjects for the CV photo tests (synthetic bytes, no real images).
export const sampleJpeg = (size = 32, fill = 0x11) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, fill), Buffer.from([0xff, 0xd9])]);

export interface PdfImage { width: number; height: number; filter: string; data: Buffer; lengthRef?: boolean }

export function cvPdf(images: PdfImage[]): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n", "latin1")];
  images.forEach((image, index) => {
    const id = 10 + index * 2;
    const length = image.lengthRef ? `${id + 1} 0 R` : String(image.data.length);
    parts.push(Buffer.from(`${id} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter ${image.filter} /Length ${length} >>\nstream\n`, "latin1"));
    parts.push(image.data, Buffer.from("\nendstream\nendobj\n", "latin1"));
    if (image.lengthRef) parts.push(Buffer.from(`${id + 1} 0 obj\n${image.data.length}\nendobj\n`, "latin1"));
  });
  parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"));
  return Buffer.concat(parts);
}
