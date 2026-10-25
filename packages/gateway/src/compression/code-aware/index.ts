import { Language, Parser, type Node, type Tree } from "web-tree-sitter";

/**
 * CodeAwareCompressor, a TypeScript port of Headroom 0.37 `transforms/code_compressor.rs` (Apache-2.0, Headroom
 * Contributors). Source code is parsed with tree-sitter (the same grammar versions as Headroom's parity fixtures,
 * as WebAssembly); imports, signatures, type definitions, decorators and top-level code stay, and function bodies
 * keep only their first statements within a per-function line budget weighted by how important the function is.
 * The result must parse again without errors, otherwise the original is returned. Offsets are UTF-16 indexes into
 * the JavaScript string, so non-ASCII text slices correctly (Headroom's fixtures are ASCII, where both agree).
 */
export type CodeLanguage = "python" | "javascript" | "typescript" | "go" | "rust" | "java" | "c" | "cpp" | "unknown";
export type DocstringMode = "full" | "first_line" | "remove" | "none";

export interface CodeCompressorConfig {
  docstringMode: DocstringMode;
  targetCompressionRate: number;
  maxBodyLines: number;
  minTokensForCompression: number;
  languageHint: string | null;
  semanticAnalysis: boolean;
}

export const defaultCodeCompressorConfig: CodeCompressorConfig = {
  docstringMode: "first_line", targetCompressionRate: 0.2, maxBodyLines: 5, minTokensForCompression: 100, languageHint: null, semanticAnalysis: true
};

export interface CodeCompressionResult {
  compressed: string;
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
  language: CodeLanguage;
  languageConfidence: number;
  preservedImports: number;
  preservedSignatures: number;
  compressedBodies: number;
  syntaxValid: boolean;
  symbolScores: Record<string, number>;
}

interface LangConfig {
  importNodes: string[];
  functionNodes: string[];
  classNodes: string[];
  typeNodes: string[];
  bodyNodeTypes: string[];
  decoratorNode: string | null;
  commentPrefix: string;
  usesColonAfterSignature: boolean;
  packageNode: string | null;
}

const langConfigs: Record<Exclude<CodeLanguage, "unknown">, LangConfig> = {
  python: { importNodes: ["import_statement", "import_from_statement"], functionNodes: ["function_definition"], classNodes: ["class_definition"],
    typeNodes: ["type_alias_statement"], bodyNodeTypes: ["block"], decoratorNode: "decorated_definition", commentPrefix: "#", usesColonAfterSignature: true, packageNode: null },
  javascript: { importNodes: ["import_statement", "import_declaration"], functionNodes: ["function_declaration", "method_definition"], classNodes: ["class_declaration"],
    typeNodes: [], bodyNodeTypes: ["statement_block"], decoratorNode: null, commentPrefix: "//", usesColonAfterSignature: false, packageNode: null },
  typescript: { importNodes: ["import_statement", "import_declaration"], functionNodes: ["function_declaration", "method_definition"], classNodes: ["class_declaration"],
    typeNodes: ["interface_declaration", "type_alias_declaration"], bodyNodeTypes: ["statement_block"], decoratorNode: null, commentPrefix: "//", usesColonAfterSignature: false, packageNode: null },
  go: { importNodes: ["import_declaration"], functionNodes: ["function_declaration", "method_declaration"], classNodes: [], typeNodes: ["type_declaration"],
    bodyNodeTypes: ["block"], decoratorNode: null, commentPrefix: "//", usesColonAfterSignature: false, packageNode: "package_clause" },
  rust: { importNodes: ["use_declaration"], functionNodes: ["function_item"], classNodes: ["impl_item"], typeNodes: ["struct_item", "enum_item", "type_item", "trait_item"],
    bodyNodeTypes: ["block"], decoratorNode: null, commentPrefix: "//", usesColonAfterSignature: false, packageNode: null },
  java: { importNodes: ["import_declaration"], functionNodes: ["method_declaration", "constructor_declaration"], classNodes: ["class_declaration", "interface_declaration"],
    typeNodes: ["enum_declaration"], bodyNodeTypes: ["block"], decoratorNode: null, commentPrefix: "//", usesColonAfterSignature: false, packageNode: "package_declaration" },
  c: { importNodes: ["preproc_include"], functionNodes: ["function_definition"], classNodes: [], typeNodes: ["struct_specifier", "enum_specifier", "type_definition"],
    bodyNodeTypes: ["compound_statement"], decoratorNode: null, commentPrefix: "//", usesColonAfterSignature: false, packageNode: null },
  cpp: { importNodes: ["preproc_include"], functionNodes: ["function_definition"], classNodes: ["class_specifier"], typeNodes: ["struct_specifier", "enum_specifier", "type_definition"],
    bodyNodeTypes: ["compound_statement"], decoratorNode: null, commentPrefix: "//", usesColonAfterSignature: false, packageNode: null }
};

const grammarFiles: Record<Exclude<CodeLanguage, "unknown">, string> = {
  python: "tree-sitter-python.wasm", javascript: "tree-sitter-javascript.wasm", typescript: "tree-sitter-typescript.wasm", go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm", java: "tree-sitter-java.wasm", c: "tree-sitter-c.wasm", cpp: "tree-sitter-cpp.wasm"
};

const parsers = new Map<CodeLanguage, Parser>();

/** Loads tree-sitter and the grammars (once per process); until then code passes through unchanged. */
export async function initCodeAware(grammarDirectory: URL | string): Promise<void> {
  if (parsers.size > 0) return;
  await Parser.init();
  const base = typeof grammarDirectory === "string" ? grammarDirectory : grammarDirectory.pathname;
  for (const [language, file] of Object.entries(grammarFiles) as [Exclude<CodeLanguage, "unknown">, string][]) {
    const parser = new Parser();
    parser.setLanguage(await Language.load(`${base.replace(/\/$/, "")}/${file}`));
    parsers.set(language, parser);
  }
}

export const codeAwareReady = () => parsers.size > 0;

function parse(code: string, language: CodeLanguage): Tree | null {
  const parser = parsers.get(language);
  return parser ? parser.parse(code) : null;
}

/** Rust `char::is_whitespace` and `str::trim*` (JavaScript's also strip U+FEFF). */
const WS = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const trimStart = (text: string) => text.replace(new RegExp(`^[${WS}]+`, "u"), "");
const trimEnd = (text: string) => text.replace(new RegExp(`[${WS}]+$`, "u"), "");
const trim = (text: string) => trimEnd(trimStart(text));
const charCount = (text: string) => [...text].length;
const charPrefix = (text: string, n: number) => [...text].slice(0, n).join("");

/** `len(text) // 4` in code points, at least 1. */
const estimateTokens = (text: string) => Math.max(1, Math.floor(charCount(text) / 4));

/** CPython `round(x)`: ties to even. */
function pyRoundInt(x: number): number {
  const r = Math.sign(x) * Math.round(Math.abs(x));
  return Math.abs(x - r) === 0.5 ? 2 * (Math.sign(x / 2) * Math.round(Math.abs(x / 2))) : r;
}

/** CPython `round(x, 3)`: correctly rounded, ties to even (exact ties are odd multiples of 1/16 here). */
function pyRound3(x: number): number {
  const scaled = x * 1000;
  if (Number.isInteger(x * 16) && Math.abs(scaled - Math.trunc(scaled)) === 0.5) {
    const low = Math.floor(scaled);
    return (low % 2 === 0 ? low : low + 1) / 1000;
  }
  return Number(x.toFixed(3));
}

const nodeText = (node: Node, code: string) => code.slice(node.startIndex, node.endIndex);

function definitionName(node: Node, code: string): string | null {
  for (const child of node.children) {
    if (!child) continue;
    if (child.type === "identifier" || child.type === "name" || child.type === "type_identifier" || child.type === "property_identifier") return nodeText(child, code);
  }
  return null;
}

function countErrorNodes(node: Node): number {
  let count = node.type === "ERROR" || node.isMissing ? 1 : 0;
  for (const child of node.children) if (child) count += countErrorNodes(child);
  return count;
}

function hasSyntaxIssues(node: Node): boolean {
  if (node.type === "ERROR" || node.isMissing) return true;
  return node.children.some((child) => child !== null && hasSyntaxIssues(child));
}

const W = "[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\u200c\\u200d]";
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const S = "\\s";
const prefilter: [Exclude<CodeLanguage, "unknown">, RegExp[]][] = ([
  ["python", [`^${S}*(def|class|import|from|async def)${S}+${W}+`, `^${S}*@${W}+`, `^${S}*"""`, `^${S}*if __name__${S}*==`]],
  ["javascript", [`^${S}*(function|const|let|var|class|export)${S}+${W}+`, `^${S}*async${S}+(function|=>)`, `^${S}*module\\.exports`, `^${S}*(import|export)${S}+.*${S}+from${S}+['"]`]],
  ["typescript", [`^${S}*(interface|type|enum|namespace)${S}+${W}+`, `:${S}*(string|number|boolean|any|void|Promise)${B}`]],
  ["go", [`^${S}*(func|type|package|import)${S}+`, `^${S}*func${S}+\\([^)]+\\)${S}+${W}+`, `${B}struct${S}*\\{`]],
  ["rust", [`^${S}*(fn|struct|enum|impl|mod|use|pub)${S}+`, `^${S}*#\\[`]],
  ["java", [`^${S}*(public|private|protected)${S}+(class|interface|enum)`, `^${S}*package${S}+(?:${W}|\\.)+;`]],
  ["c", [`^${S}*#include${S}*[<"]`, `^${S}*(int|void|char|float|double)${S}+${W}+${S}*\\(`, `^${S}*typedef${S}+`]],
  ["cpp", [`^${S}*#include${S}*[<"]`, `${B}namespace${S}+${W}+`, `::${W}+`]]
] as [Exclude<CodeLanguage, "unknown">, string[]][]).map(([language, patterns]) => [language, patterns.map((source) => new RegExp(source, "gmu"))]);

/** Regex prefilter, then the candidate that parses with the fewest errors (most top-level nodes on ties). */
export function detectLanguage(code: string): { language: CodeLanguage; confidence: number } {
  if (!trim(code)) return { language: "unknown", confidence: 0 };
  const sample = charPrefix(code, 5000);
  const candidates: [CodeLanguage, number][] = [];
  for (const [language, patterns] of prefilter) {
    const score = patterns.reduce((sum, pattern) => sum + [...sample.matchAll(pattern)].length, 0);
    if (score > 0) candidates.push([language, score]);
  }
  if (candidates.length === 0) return { language: "unknown", confidence: 0 };
  const scoreOf = (language: CodeLanguage) => candidates.find(([item]) => item === language)?.[1];
  if ((scoreOf("typescript") ?? 0) >= 2 && scoreOf("javascript") !== undefined) candidates.find(([item]) => item === "javascript")![1] = 0;
  if ((scoreOf("cpp") ?? 0) >= 2 && scoreOf("c") !== undefined) candidates.find(([item]) => item === "c")![1] = 0;

  const source = charPrefix(code, 10000);
  let best: CodeLanguage = "unknown";
  let minErrors = Number.MAX_SAFE_INTEGER;
  let bestNodeCount = 0;
  const sorted = candidates.map((entry, index) => ({ entry, index })).sort((a, b) => b.entry[1] - a.entry[1] || a.index - b.index).map(({ entry }) => entry);
  for (const [language] of sorted) {
    if (scoreOf(language) === 0) continue;
    const tree = parse(source, language);
    if (!tree) continue;
    const errors = countErrorNodes(tree.rootNode);
    const nodes = tree.rootNode.childCount;
    tree.delete();
    if (errors < minErrors || (errors === minErrors && nodes > bestNodeCount)) {
      minErrors = errors;
      best = language;
      bestNodeCount = nodes;
    }
  }
  if (best !== "unknown") {
    const totalLines = Math.max(1, trim(code).split("\n").length);
    return { language: best, confidence: Math.min(1, Math.max(0.3, 1 - minErrors / totalLines)) };
  }
  let fallback = candidates[0]!;
  for (const candidate of candidates.slice(1)) if (candidate[1] > fallback[1]) fallback = candidate;
  if (fallback[1] === 0) return { language: "unknown", confidence: 0 };
  return { language: fallback[0], confidence: Math.min(1, 0.3 + fallback[1] * 0.1) };
}

interface SymbolAnalysis {
  scores: Map<string, number>;
  calls: Map<string, Set<string>>;
  bareNames: Map<string, string>;
  bodyLineCounts: Map<string, number>;
}

const emptyAnalysis = (): SymbolAnalysis => ({ scores: new Map(), calls: new Map(), bareNames: new Map(), bodyLineCounts: new Map() });

const CONTEXT_DELIMS = /[\s,;:.()[\]{}"'，、；：。．！？（）【】「」『』《》〈〉·…—　]+/u;
const CJK = /[\u3000-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF]/u;

function symbolInContext(name: string, words: Set<string>, context: string, hasCjk: boolean): boolean {
  if (words.size === 0 || !name) return false;
  if (words.has(name)) return true;
  return context.includes(name) && (charCount(name) > 3 || hasCjk);
}

const isPublic = (name: string, language: CodeLanguage) => (!name ? false : language === "go" ? /^\p{Uppercase}/u.test(name) : !name.startsWith("_"));
const sortedCalls = (calls: Set<string>) => [...calls].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function analyzeSymbols(root: Node, code: string, language: CodeLanguage, context: string, config: CodeCompressorConfig): SymbolAnalysis {
  if (!config.semanticAnalysis || language === "unknown") return emptyAnalysis();
  const lang = langConfigs[language];
  const isDef = (type: string) => lang.functionNodes.includes(type) || lang.classNodes.includes(type);
  const definitions = new Map<string, Node>();
  const bareNames = new Map<string, string>();
  const collectDefinitions = (node: Node, parent: string): void => {
    if (isDef(node.type)) {
      const short = definitionName(node, code);
      if (short !== null) {
        const qualified = parent ? `${parent}.${short}` : short;
        definitions.set(qualified, node);
        bareNames.set(qualified, short);
        for (const child of node.children) if (child) collectDefinitions(child, qualified);
        return;
      }
    }
    if (lang.decoratorNode && node.type === lang.decoratorNode) {
      for (const child of node.children) {
        if (!child || !isDef(child.type)) continue;
        const short = definitionName(child, code);
        if (short === null) continue;
        const qualified = parent ? `${parent}.${short}` : short;
        definitions.set(qualified, child);
        bareNames.set(qualified, short);
        for (const grandchild of child.children) if (grandchild) collectDefinitions(grandchild, qualified);
        return;
      }
    }
    for (const child of node.children) if (child) collectDefinitions(child, parent);
  };
  collectDefinitions(root, "");
  if (definitions.size === 0) return emptyAnalysis();

  const identifiers = new Map<string, number>();
  const collectIdentifiers = (node: Node): void => {
    if (node.type === "identifier" || node.type === "property_identifier" || node.type === "type_identifier") {
      const name = nodeText(node, code);
      identifiers.set(name, (identifiers.get(name) ?? 0) + 1);
    }
    for (const child of node.children) if (child) collectIdentifiers(child);
  };
  collectIdentifiers(root);

  const definedShort = new Set(bareNames.values());
  const calls = new Map<string, Set<string>>();
  const bodyLineCounts = new Map<string, number>();
  for (const [qname, node] of definitions) {
    const own = bareNames.get(qname) ?? "";
    const found = new Set<string>();
    const collectCalls = (current: Node): void => {
      if (current.type === "identifier" || current.type === "property_identifier") {
        const name = nodeText(current, code);
        if (definedShort.has(name) && name !== own) found.add(name);
      }
      for (const child of current.children) if (child) collectCalls(child);
    };
    collectCalls(node);
    calls.set(qname, found);
    bodyLineCounts.set(qname, Math.max(1, nodeText(node, code).split("\n").length - 2));
  }
  const defCount = new Map<string, number>();
  for (const short of bareNames.values()) defCount.set(short, (defCount.get(short) ?? 0) + 1);

  const lowered = context.toLowerCase();
  const words = context ? new Set(lowered.split(CONTEXT_DELIMS).filter(Boolean)) : new Set<string>();
  const contextCjk = context ? CJK.test(lowered) : false;
  const raw = new Map<string, number>();
  for (const qname of definitions.keys()) {
    const short = bareNames.get(qname)!;
    const refs = Math.max(0, (identifiers.get(short) ?? 0) - (defCount.get(short) ?? 1));
    let value = refs + (isPublic(short, language) ? 1 : 0) + (calls.get(qname)?.size ?? 0) * 0.5;
    if (language === "python" && short.startsWith("__") && short.endsWith("__")) value += 2;
    else if (language === "go" && /^\p{Uppercase}/u.test(short)) value += 1;
    if (symbolInContext(short.toLowerCase(), words, lowered, contextCjk)) value += 3;
    raw.set(qname, value);
  }
  const values = [...raw.values()];
  const min = Math.min(...values);
  const range = Math.max(...values) - min;
  const scores = new Map<string, number>();
  for (const [qname, value] of raw) scores.set(qname, range > 0 ? pyRound3((value - min) / range) : 0.5);
  return { scores, calls, bareNames, bodyLineCounts };
}

function allocateBodyBudget(analysis: SymbolAnalysis, code: string, config: CodeCompressorConfig): Map<string, number> {
  const limits = new Map<string, number>();
  if (analysis.scores.size === 0 || analysis.bodyLineCounts.size === 0) return limits;
  const totalLines = trim(code).split("\n").length;
  const totalBodyLines = [...analysis.bodyLineCounts.values()].reduce((sum, value) => sum + value, 0);
  const fixedLines = Math.max(0, totalLines - totalBodyLines);
  const bodyBudget = Math.max(0, totalLines * config.targetCompressionRate - fixedLines);
  if (totalBodyLines === 0) return limits;
  const weights = new Map<string, number>();
  for (const [name, score] of analysis.scores) weights.set(name, Math.max(score, 0.05) * (analysis.bodyLineCounts.get(name) ?? 0));
  let totalWeight = 0;
  for (const weight of weights.values()) totalWeight += weight;
  if (totalWeight === 0) {
    const perFunction = Math.max(0, Math.trunc(bodyBudget / Math.max(analysis.scores.size, 1)));
    for (const name of analysis.scores.keys()) limits.set(name, Math.min(perFunction, analysis.bodyLineCounts.get(name) ?? 0));
    return limits;
  }
  for (const qname of analysis.scores.keys()) {
    const allocation = (bodyBudget * (weights.get(qname) ?? 0)) / totalWeight;
    const limit = Math.min(pyRoundInt(allocation), analysis.bodyLineCounts.get(qname) ?? 0);
    limits.set(qname, limit);
    const short = analysis.bareNames.get(qname) ?? qname;
    const existing = limits.get(short);
    if (existing === undefined || limit > existing) limits.set(short, limit);
  }
  return limits;
}

function leadingWhitespace(line: string): string {
  return line.slice(0, line.length - trimStart(line).length);
}

function detectIndent(lines: string[]): string {
  for (const line of lines) if (trim(line)) return leadingWhitespace(line);
  return "    ";
}

function firstLineDocstring(firstLine: string, bodyLines: string[], start: number): string {
  const indent = leadingWhitespace(firstLine);
  const stripped = trim(firstLine);
  let quote = "\"\"\"";
  let contentStart = 0;
  for (const opener of ["r\"\"\"", "r'''", "\"\"\"", "'''"]) {
    if (stripped.startsWith(opener)) { quote = opener.slice(opener.length - 3); contentStart = opener.length; break; }
  }
  const stripQuotes = (text: string) => {
    let value = text;
    for (const q of ["\"\"\"", "'''"]) if (value.endsWith(q)) value = trim(value.slice(0, value.length - q.length));
    return value;
  };
  const firstContent = stripQuotes(trim(stripped.slice(contentStart)));
  if (firstContent) return `${indent}${stripped.slice(0, contentStart)}${firstContent}${quote}`;
  if (start + 1 < bodyLines.length) {
    const second = stripQuotes(trim(bodyLines[start + 1]!));
    return second ? `${indent}${quote}${second}${quote}` : firstLine;
  }
  return firstLine;
}

const SKIP_TYPES = new Set(["{", "}", ";", ",", "comment", "line_comment", "block_comment"]);

interface Structure {
  imports: string[];
  typeDefinitions: string[];
  classDefinitions: string[];
  functionSignatures: string[];
  topLevelCode: string[];
}

class Extractor {
  readonly lines: string[];
  readonly lang: LangConfig;
  constructor(readonly code: string, readonly language: Exclude<CodeLanguage, "unknown">, readonly limits: Map<string, number>,
    readonly analysis: SymbolAnalysis, readonly config: CodeCompressorConfig) {
    this.lines = code.split("\n");
    this.lang = langConfigs[language];
  }

  private text(node: Node) { return nodeText(node, this.code); }
  private rows(start: number, end: number) { return this.lines.slice(start, end + 1); }

  extract(root: Node): Structure {
    const structure: Structure = { imports: [], typeDefinitions: [], classDefinitions: [], functionSignatures: [], topLevelCode: [] };
    const captured = new Set<string>();
    this.visit(root, structure, captured);
    for (const child of root.children) {
      if (!child || captured.has(`${child.startIndex}:${child.endIndex}`)) continue;
      const text = trim(this.text(child));
      if (text) structure.topLevelCode.push(text);
    }
    return structure;
  }

  private visit(node: Node, structure: Structure, captured: Set<string>): void {
    const type = node.type;
    const key = `${node.startIndex}:${node.endIndex}`;
    const lang = this.lang;
    if (lang.packageNode === type) { structure.imports.unshift(this.text(node)); captured.add(key); return; }
    if (lang.importNodes.includes(type)) { structure.imports.push(this.text(node)); captured.add(key); return; }
    if (type === "export_statement") {
      let found = false;
      for (const child of node.children) {
        if (!child || !(lang.functionNodes.includes(child.type) || lang.classNodes.includes(child.type))) continue;
        found = true;
        structure.functionSignatures.push(`${this.code.slice(node.startIndex, child.startIndex)}${this.compressFunction(child)}${this.code.slice(child.endIndex, node.endIndex)}`);
        break;
      }
      if (!found) structure.imports.push(this.text(node));
      captured.add(key);
      return;
    }
    if (lang.decoratorNode === type) {
      const decorators: string[] = [];
      let definition: string | null = null;
      let hasClass = false;
      for (const child of node.children) {
        if (!child) continue;
        if (child.type === "decorator") decorators.push(this.text(child));
        else if (lang.functionNodes.includes(child.type)) definition = this.compressFunction(child);
        else if (lang.classNodes.includes(child.type)) definition = this.compressClass(child);
        if (lang.classNodes.includes(child.type)) hasClass = true;
      }
      if (definition !== null && decorators.length > 0) (hasClass ? structure.classDefinitions : structure.functionSignatures).push(`${decorators.join("\n")}\n${definition}`);
      else if (definition !== null) structure.functionSignatures.push(definition);
      captured.add(key);
      return;
    }
    if (lang.functionNodes.includes(type)) { structure.functionSignatures.push(this.compressFunction(node)); captured.add(key); return; }
    if (lang.classNodes.includes(type)) { structure.classDefinitions.push(this.compressClass(node)); captured.add(key); return; }
    if (lang.typeNodes.includes(type)) { structure.typeDefinitions.push(this.text(node)); captured.add(key); return; }
    for (const child of node.children) if (child) this.visit(child, structure, captured);
  }

  private omittedComment(name: string | null, omitted: number, indent: string): string {
    let callsInfo = "";
    if (name !== null) {
      const candidates = [name, ...[...this.analysis.calls.keys()].filter((key) => key.endsWith(`.${name}`))];
      for (const candidate of candidates) {
        const called = this.analysis.calls.get(candidate);
        if (!called) continue;
        if (called.size > 0) {
          callsInfo = `; calls: ${sortedCalls(called).slice(0, 5).join(", ")}`;
          if (called.size > 5) callsInfo += ` +${called.size - 5} more`;
        }
        break;
      }
    }
    return `${indent}${this.lang.commentPrefix} [${omitted} lines omitted${callsInfo}]`;
  }

  compressFunction(node: Node): string {
    const startRow = node.startPosition.row;
    const nodeLines = this.rows(startRow, node.endPosition.row);
    const fullText = nodeLines.join("\n");
    const name = definitionName(node, this.code);
    const limit = name !== null && this.limits.size > 0 && this.limits.has(name) ? Math.min(this.limits.get(name)!, this.config.maxBodyLines) : this.config.maxBodyLines;
    if (nodeLines.length <= limit + 2) return fullText;
    const body = node.children.find((child): child is Node => child !== null && this.lang.bodyNodeTypes.includes(child.type));
    if (!body) return fullText;
    const sigEnd = body.startPosition.row - startRow;
    const bodyEndRel = body.endPosition.row - startRow + 1;
    let signatureLines: string[];
    let bodyLines: string[];
    let afterLines: string[];
    let braceInSignature: boolean;
    if (sigEnd === 0 && !this.lang.usesColonAfterSignature) {
      signatureLines = [trimEnd(nodeLines[0]!)];
      bodyLines = nodeLines.slice(1, bodyEndRel);
      afterLines = nodeLines.slice(bodyEndRel);
      braceInSignature = true;
    } else {
      signatureLines = nodeLines.slice(0, sigEnd);
      bodyLines = nodeLines.slice(sigEnd, bodyEndRel);
      afterLines = nodeLines.slice(bodyEndRel);
      braceInSignature = false;
    }
    let openingBrace: string | null = null;
    let closingBrace: string | null = null;
    if (!this.lang.usesColonAfterSignature) {
      if (!braceInSignature && bodyLines.length > 0 && trimStart(bodyLines[0]!).startsWith("{")) {
        openingBrace = bodyLines[0]!;
        bodyLines = bodyLines.slice(1);
      }
      if (bodyLines.length > 0 && trimEnd(bodyLines[bodyLines.length - 1]!).endsWith("}")) {
        closingBrace = bodyLines[bodyLines.length - 1]!;
        bodyLines = bodyLines.slice(0, -1);
      }
    }

    let docstring = "";
    let docstringSkip = 0;
    if (this.language === "python" && body.childCount > 0) {
      const first = body.child(0)!;
      const isDocstring = first.type === "string" || (first.type === "expression_statement" && first.childCount > 0 && first.child(0)!.type === "string");
      if (isDocstring) {
        const count = first.endPosition.row - first.startPosition.row + 1;
        const start = first.startPosition.row - body.startPosition.row;
        if (this.config.docstringMode === "full") {
          if (start < bodyLines.length) docstring = bodyLines.slice(start, Math.min(start + count, bodyLines.length)).join("\n");
        } else if (this.config.docstringMode === "first_line") {
          if (count === 1) docstring = bodyLines[start] ?? "";
          else if (bodyLines[start] !== undefined) docstring = firstLineDocstring(bodyLines[start]!, bodyLines, start);
        }
        docstringSkip = start + count;
      }
    }
    const indent = bodyLines.length > 0 ? detectIndent(bodyLines) : "    ";
    const docstringEndRow = docstringSkip > 0 && body.childCount > 0 ? body.startPosition.row + docstringSkip - 1 : -1;
    const statements: [number, number][] = [];
    for (const child of body.children) {
      if (!child || child.startPosition.row <= docstringEndRow || SKIP_TYPES.has(child.type) || !child.isNamed) continue;
      statements.push([child.startPosition.row, child.endPosition.row]);
    }
    const totalBody = statements.reduce((sum, [start, end]) => sum + (end - start + 1), 0);
    const kept: string[] = [];
    let keptCount = 0;
    for (const [start, end] of statements) {
      const lines = this.rows(start, end);
      if (keptCount + lines.length > limit && kept.length > 0) break;
      kept.push(...lines);
      keptCount += lines.length;
    }
    const omitted = totalBody - keptCount;
    const parts: string[] = [];
    if (signatureLines.length > 0) parts.push(...signatureLines);
    else parts.push(trimEnd(this.code.slice(node.startIndex, body.startIndex)));
    if (openingBrace !== null) parts.push(openingBrace);
    if (docstring && this.config.docstringMode !== "none" && this.config.docstringMode !== "remove") parts.push(docstring);
    parts.push(...kept);
    if (omitted > 0) {
      parts.push(this.omittedComment(name, omitted, indent));
      if (this.lang.usesColonAfterSignature) parts.push(`${indent}pass`);
    }
    if (closingBrace !== null) parts.push(closingBrace);
    else parts.push(...afterLines);
    return parts.join("\n");
  }

  compressClass(node: Node): string {
    const startRow = node.startPosition.row;
    const nodeLines = this.rows(startRow, node.endPosition.row);
    const body = node.children.find((child): child is Node => child !== null && this.lang.bodyNodeTypes.includes(child.type));
    if (!body) return nodeLines.join("\n");
    const sigEnd = body.startPosition.row - startRow;
    const header = sigEnd > 0 ? nodeLines.slice(0, sigEnd) : [nodeLines[0]!];
    const parts: string[] = [];
    for (const child of body.children) {
      if (!child) continue;
      const childText = this.rows(child.startPosition.row, child.endPosition.row).join("\n");
      if (this.lang.functionNodes.includes(child.type)) parts.push(this.compressFunction(child));
      else if (this.lang.decoratorNode === child.type) {
        const decorators: string[] = [];
        let method: string | null = null;
        for (const inner of child.children) {
          if (!inner) continue;
          if (inner.type === "decorator") decorators.push(this.text(inner));
          else if (this.lang.functionNodes.includes(inner.type)) method = this.compressFunction(inner);
        }
        parts.push(method !== null ? (decorators.length > 0 ? `${decorators.join("\n")}\n${method}` : method) : childText);
      } else if (this.lang.classNodes.includes(child.type)) parts.push(this.compressClass(child));
      else if (trim(childText)) parts.push(childText);
    }
    const result = [...header, ...parts];
    const afterLines = nodeLines.slice(body.endPosition.row - startRow + 1);
    if (afterLines.length > 0) result.push(...afterLines);
    else if (!this.lang.usesColonAfterSignature) {
      const last = nodeLines[nodeLines.length - 1] ?? "";
      if (trim(last) === "}") result.push(last);
    }
    return result.join("\n");
  }
}

function assemble(structure: Structure): string {
  const parts: string[] = [];
  for (const section of [structure.imports, structure.typeDefinitions, structure.classDefinitions, structure.functionSignatures, structure.topLevelCode]) {
    if (section.length > 0) parts.push(...section, "");
  }
  while (parts.length > 0 && !trim(parts[parts.length - 1]!)) parts.pop();
  return parts.join("\n");
}

function passthrough(code: string, tokens: number, language: CodeLanguage, confidence: number): CodeCompressionResult {
  return { compressed: code, originalTokens: tokens, compressedTokens: tokens, compressionRatio: 1, language, languageConfidence: confidence, preservedImports: 0,
    preservedSignatures: 0, compressedBodies: 0, syntaxValid: true, symbolScores: {} };
}

/** Compresses source code; anything it cannot parse cleanly, or would shrink below 5%, comes back unchanged. */
export function compressCode(code: string, options: { language?: string | null; context?: string; config?: Partial<CodeCompressorConfig> } = {}): CodeCompressionResult {
  const config = { ...defaultCodeCompressorConfig, ...options.config };
  if (!trim(code)) return passthrough(code, 0, "unknown", 0);
  const originalTokens = estimateTokens(code);
  if (originalTokens < config.minTokensForCompression) return passthrough(code, originalTokens, "unknown", 0);
  const named = options.language ?? config.languageHint;
  let language: CodeLanguage;
  let confidence: number;
  if (named) {
    const lower = named.toLowerCase();
    language = lower in langConfigs ? lower as CodeLanguage : "unknown";
    confidence = 1;
  } else ({ language, confidence } = detectLanguage(code));
  if (language === "unknown") return passthrough(code, originalTokens, "unknown", 0);
  const tree = parse(code, language);
  if (!tree) return passthrough(code, originalTokens, language, confidence);
  let compressed: string;
  let structure: Structure;
  const symbolScores: Record<string, number> = {};
  try {
    const analysis = analyzeSymbols(tree.rootNode, code, language, options.context ?? "", config);
    const limits = allocateBodyBudget(analysis, code, config);
    structure = new Extractor(code, language, limits, analysis, config).extract(tree.rootNode);
    for (const [qname, score] of analysis.scores) {
      const short = analysis.bareNames.get(qname) ?? qname;
      if (!(short in symbolScores) || score > symbolScores[short]!) symbolScores[short] = score;
    }
    compressed = assemble(structure);
  } catch {
    return passthrough(code, originalTokens, language, confidence);
  } finally {
    tree.delete();
  }
  const compressedTokens = estimateTokens(compressed);
  const check = parse(compressed, language);
  const syntaxValid = check ? !hasSyntaxIssues(check.rootNode) : false;
  check?.delete();
  if (!syntaxValid) return passthrough(code, originalTokens, language, confidence);
  const ratio = compressedTokens / Math.max(originalTokens, 1);
  if (ratio < 0.05) return passthrough(code, originalTokens, language, confidence);
  return { compressed, originalTokens, compressedTokens, compressionRatio: ratio, language, languageConfidence: confidence,
    preservedImports: structure.imports.length, preservedSignatures: structure.functionSignatures.length, compressedBodies: 0, syntaxValid, symbolScores };
}
