import { normalizeMailAddress, type MailContactInput } from "@space/contracts";

// Contacts from a CSV file, pasted text or explicit rows. Nothing here touches the network; every address is normalized, and the caller
// counts what was refused. A CSV needs an address column (email, e-mail, mail, address, διεύθυνση) or a column that holds addresses;
// a name column (name, όνομα, first/last name) fills the name, every other column becomes an attribute.

export interface ParsedContacts { contacts: MailContactInput[]; invalid: number; duplicates: number }

/** RFC 4180 rows: quoted fields with doubled quotes and line breaks; the delimiter (comma, semicolon or tab) from the first line. */
export function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", ";", "\t"].map((candidate) => [candidate, firstLine.split(candidate).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === "\"" && text[index + 1] === "\"") { field += "\""; index++; } else if (char === "\"") quoted = false; else field += char;
    } else if (char === "\"" && field === "") quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field); field = "";
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

const ADDRESS_HEADER = /^(e-?mail(\s*address)?|mail|address|διεύθυνση(\s*email)?|email_address)$/i;
const NAME_HEADER = /^(name|full\s*name|όνομα|ονοματεπώνυμο|company|εταιρεία)$/i;
const FIRST_HEADER = /^(first\s*_?name|firstname|όνομα)$/i;
const LAST_HEADER = /^(last\s*_?name|lastname|surname|επώνυμο)$/i;
const attributeKey = (header: string) => header.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/[^A-Za-z0-9]+(.)?/g, (_, next: string | undefined) => (next ?? "").toUpperCase())
  .replace(/^[^A-Za-z]+/, "").replace(/^[A-Z]/, (first) => first.toLowerCase()).slice(0, 40);

function collect(entries: Array<{ address: string; name: string; attributes: Record<string, string> }>): ParsedContacts {
  const seen = new Map<string, MailContactInput>();
  let invalid = 0; let duplicates = 0;
  for (const entry of entries) {
    const address = normalizeMailAddress(entry.address);
    if (!address) { invalid++; continue; }
    if (seen.has(address)) { duplicates++; continue; }
    seen.set(address, { address, name: entry.name.trim().slice(0, 200), attributes: entry.attributes });
  }
  const contacts = [...seen.values()];
  return { contacts, invalid, duplicates };
}

export function contactsFromCsv(text: string): ParsedContacts {
  const rows = parseCsv(text);
  if (!rows.length) return { contacts: [], invalid: 0, duplicates: 0 };
  const headers = rows[0]!.map((cell) => cell.trim());
  let addressColumn = headers.findIndex((header) => ADDRESS_HEADER.test(header));
  const hasHeader = addressColumn >= 0 || !headers.some((cell) => cell.includes("@"));
  if (addressColumn < 0) addressColumn = (hasHeader ? rows[1] : rows[0])?.findIndex((cell) => cell.includes("@")) ?? -1;
  if (addressColumn < 0) throw new Error("No e-mail column found: name it email, or put the addresses in a column of their own.");
  const nameColumn = hasHeader ? headers.findIndex((header) => NAME_HEADER.test(header)) : -1;
  const firstColumn = hasHeader ? headers.findIndex((header) => FIRST_HEADER.test(header)) : -1;
  const lastColumn = hasHeader ? headers.findIndex((header) => LAST_HEADER.test(header)) : -1;
  const used = new Set([addressColumn, nameColumn, firstColumn, lastColumn]);
  const attributeColumns = hasHeader ? headers.map((header, index) => [index, attributeKey(header)] as const).filter(([index, key]) => !used.has(index) && key).slice(0, 40) : [];
  return collect((hasHeader ? rows.slice(1) : rows).map((row) => {
    const name = nameColumn >= 0 ? row[nameColumn] ?? "" : [firstColumn >= 0 ? row[firstColumn] : "", lastColumn >= 0 ? row[lastColumn] : ""].filter(Boolean).join(" ");
    const attributes = Object.fromEntries(attributeColumns.map(([index, key]) => [key, (row[index] ?? "").trim().slice(0, 500)]).filter(([, value]) => value));
    return { address: row[addressColumn] ?? "", name, attributes };
  }));
}

/** Every address in free text; `Name <address>` keeps the name. */
export function contactsFromText(text: string): ParsedContacts {
  const entries: Array<{ address: string; name: string; attributes: Record<string, string> }> = [];
  for (const match of text.matchAll(/(?:"?([^"<>,;\n]{1,120}?)"?\s*<)?([^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+)>?/g)) {
    entries.push({ address: match[2]!.replace(/[.]+$/, ""), name: match[1]?.trim() ?? "", attributes: {} });
  }
  return collect(entries);
}

export function contactsFromRows(rows: Array<{ address: string; name?: string; attributes?: Record<string, string> }>): ParsedContacts {
  return collect(rows.map((row) => ({ address: row.address, name: row.name ?? "", attributes: row.attributes ?? {} })));
}
