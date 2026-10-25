import mammoth from "mammoth";

const filePath = process.argv[2];

if (!filePath) {
  throw new Error("DOCX preview worker requires one file path.");
}

const result = await mammoth.convertToHtml({ path: filePath });
process.stdout.write(result.value);
