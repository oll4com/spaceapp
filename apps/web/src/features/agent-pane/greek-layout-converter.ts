/**
 * Greek / Latin QWERTY keyboard layout converter and mistyped layout detector.
 *
 * Automatically detects and fixes text typed with the wrong keyboard layout:
 * - English QWERTY typed with Greek layout intentions: e.g. "l;auow" -> "λάθος", "kallhm;era" -> "καλλημέρα"
 * - Greek typed with English layout intentions: e.g. "τηε" -> "the", "γιτ στατυς" -> "git status", "μψπ ψοντρολ" -> "mcp control"
 * - Preserves valid English technical terms & code identifiers: e.g. "mcp", "control", "docker", "server", "paneId"
 */

export const QWERTY_TO_GREEK_CHAR_MAP: Readonly<Record<string, string>> = {
  a: "α", b: "β", c: "ψ", d: "δ", e: "ε", f: "φ", g: "γ", h: "η",
  i: "ι", j: "ξ", k: "κ", l: "λ", m: "μ", n: "ν", o: "ο", p: "π",
  r: "ρ", s: "σ", t: "τ", u: "θ", v: "ω", w: "ς", x: "χ", y: "υ", z: "ζ",
  A: "Α", B: "Β", C: "Ψ", D: "Δ", E: "Ε", F: "Φ", G: "Γ", H: "Η",
  I: "Ι", J: "Ξ", K: "Κ", L: "Λ", M: "Μ", N: "Ν", O: "Ο", P: "Π",
  R: "Ρ", S: "Σ", T: "Τ", U: "Θ", V: "Ω", W: "Σ", X: "Χ", Y: "Υ", Z: "Ζ",
  q: ";", Q: ":"
};

export const GREEK_TONOS_MAP: Readonly<Record<string, string>> = {
  a: "ά", e: "έ", h: "ή", i: "ί", o: "ό", y: "ύ", v: "ώ", u: "ύ", w: "ώ",
  A: "Ά", E: "Έ", H: "Ή", I: "Ί", O: "Ό", Y: "Ύ", V: "Ώ", U: "Ύ", W: "Ώ"
};

export const GREEK_DIALYTIKA_MAP: Readonly<Record<string, string>> = {
  i: "ϊ", y: "ϋ",
  I: "Ϊ", Y: "Ϋ"
};

export const GREEK_TONOS_DIALYTIKA_MAP: Readonly<Record<string, string>> = {
  i: "ΐ", y: "ΰ",
  I: "ΐ", Y: "ΰ"
};

export const GREEK_TO_QWERTY_CHAR_MAP: Readonly<Record<string, string>> = {
  α: "a", β: "b", ψ: "c", δ: "d", ε: "e", φ: "f", γ: "g", η: "h",
  ι: "i", ξ: "j", κ: "k", λ: "l", μ: "m", ν: "n", ο: "o", π: "p",
  ρ: "r", σ: "s", ς: "s", τ: "t", θ: "u", ω: "v", χ: "x", υ: "y", ζ: "z",
  Α: "A", Β: "B", Ψ: "C", Δ: "D", Ε: "E", Φ: "F", Γ: "G", Η: "H",
  Ι: "I", Ξ: "J", Κ: "K", Λ: "L", Μ: "M", Ν: "N", Ο: "O", Π: "P",
  Ρ: "R", Σ: "S", Τ: "T", Θ: "U", Ω: "V", Χ: "X", Υ: "Y", Ζ: "Z",
  ά: "a", έ: "e", ή: "h", ί: "i", ό: "o", ύ: "y", ώ: "v",
  Ά: "A", Έ: "E", Ή: "H", Ί: "I", Ό: "O", Ύ: "Y", Ώ: "V",
  ϊ: "i", ϋ: "y", ΐ: "i", ΰ: "y",
  Ϊ: "I", Ϋ: "Y",
  ";": ";", "·": ":"
};

export interface GreekTokenDebugEntry {
  token: string;
  lower: string;
  hasDeadKey: boolean;
  isCodeOrIdentifier: boolean;
  isPreservedEnglish: boolean;
  isHomophone: boolean;
  greeklishMatch?: string;
  qwertyConverted: string;
  isRecognizedGreek: boolean;
  action: "PRESERVE_DEADKEY" | "PRESERVE_CODE" | "PRESERVE_ENGLISH" | "CONVERT_HOMOPHONE" | "CONVERT_GREEKLISH" | "CONVERT_QWERTY" | "UNTOUCHED_UNRECOGNIZED";
  result: string;
  reasonDescription: string;
}

export interface GreekLayoutDebugReport {
  id: number;
  timestamp: string;
  source: "detectLayoutMismatch" | "convertQwertyToGreek" | "toggleKeyboardLayout" | "applyLayoutFix" | "inspect";
  input: string;
  output: string;
  changed: boolean;
  direction?: "toGreek" | "toQwerty";
  confidence?: number;
  detectionReason?: string;
  tokens: GreekTokenDebugEntry[];
}

let debugSequence = 0;
let debugInspectionDepth = 0;
const debugHistory: GreekLayoutDebugReport[] = [];
const MAX_DEBUG_HISTORY = 100;

export function recordGreekLayoutDebug(report: Omit<GreekLayoutDebugReport, "id" | "timestamp">): GreekLayoutDebugReport | null {
  if (debugInspectionDepth === 0) return null;
  const fullReport: GreekLayoutDebugReport = {
    id: ++debugSequence,
    timestamp: new Date().toISOString(),
    ...report
  };

  debugHistory.push(fullReport);
  if (debugHistory.length > MAX_DEBUG_HISTORY) {
    debugHistory.shift();
  }

  if (typeof window !== "undefined") {
    (window as any).__SPACE_GREEK_LAYOUT_DEBUG_LAST__ = fullReport;
    (window as any).__SPACE_GREEK_LAYOUT_DEBUG_HISTORY__ = debugHistory;
  }

  // Active console reporting with full token breakdown
  try {
    const icon = fullReport.changed ? "🔄" : "⏸️";
    const label = `[GreekLayoutDebug #${fullReport.id}] ${icon} ${fullReport.source}: "${fullReport.input.slice(0, 40)}${fullReport.input.length > 40 ? "…" : ""}" -> "${fullReport.output.slice(0, 40)}${fullReport.output.length > 40 ? "…" : ""}"`;
    if (typeof console.groupCollapsed === "function") {
      console.groupCollapsed(label);
      console.log("Original Input:", fullReport.input);
      console.log("Converted Output:", fullReport.output);
      console.log("Changed:", fullReport.changed);
      if (fullReport.detectionReason) {
        console.log("Detection Reason:", fullReport.detectionReason, `(confidence: ${fullReport.confidence ?? 0})`);
      }
      if (fullReport.tokens.length > 0) {
        console.table(fullReport.tokens.map((t) => ({
          token: t.token,
          action: t.action,
          result: t.result,
          reason: t.reasonDescription
        })));
        const unconverted = fullReport.tokens.filter((t) => t.action === "UNTOUCHED_UNRECOGNIZED");
        if (unconverted.length > 0) {
          console.warn("[GreekLayoutDebug] Tokens kept as-is (unrecognized):", unconverted.map((t) => t.token));
        }
      }
      console.groupEnd();
    } else {
      console.log(label, fullReport);
    }
  } catch {}

  return fullReport;
}

if (typeof window !== "undefined") {
  (window as any).__SPACE_GREEK_LAYOUT_DEBUG__ = {
    inspect: (text: string) => {
      debugInspectionDepth++;
      try {
        const detection = detectKeyboardLayoutMismatch(text);
        const converted = convertQwertyToGreek(text);
        return {
          text,
          detection,
          converted,
          lastReport: (window as any).__SPACE_GREEK_LAYOUT_DEBUG_LAST__
        };
      } finally {
        debugInspectionDepth--;
      }
    },
    getLastReport: () => (window as any).__SPACE_GREEK_LAYOUT_DEBUG_LAST__,
    getHistory: () => (window as any).__SPACE_GREEK_LAYOUT_DEBUG_HISTORY__ ?? [],
    clearHistory: () => {
      debugHistory.length = 0;
      (window as any).__SPACE_GREEK_LAYOUT_DEBUG_LAST__ = null;
    }
  };
}


/**
 * Checks whether a token contains Greek dead-key tonos or dialytika combinations.
 * In Greek QWERTY typing, ";" followed by a vowel or ":" followed by i/y indicates dead key intent.
 */
export function hasGreekDeadKey(token: string): boolean {
  return /;[aehiouywvAEHIOUYWV]/.test(token) || /:[iyIY]/.test(token);
}

/**
 * Checks whether a token represents a code identifier, path, acronym, or programming token.
 * Examples: "paneId", "CodexComposer", "space-web", "package.json", "MCP", "API", "/opt/spaceapp", "v2", "vm207".
 */
export function isCodeOrIdentifier(token: string): boolean {
  if (!token || token.length < 2) return false;
  // All-caps acronyms: MCP, API, CLI, OSK, URL, HTTP, JSON, PR, ID, VM, IP, DNS, etc.
  if (/^[A-Z0-9]{2,}$/.test(token) && /[A-Z]/.test(token)) {
    return true;
  }
  // Mixed letters and digits: v2, vm207, port4911, h264, utf8, mp4, etc.
  if (/\d/.test(token) && /[a-zA-Z]/.test(token)) {
    return true;
  }
  // camelCase or PascalCase: paneId, roomId, useState, CodexComposer, TerminalPane
  if (/[a-z]/.test(token) && /[A-Z]/.test(token)) {
    return true;
  }
  // Paths, filenames, kebab-case, snake_case: space-web, docker-compose, package.json, /opt/spaceapp
  if (/[-_./\\]/.test(token) && /[a-zA-Z]/.test(token)) {
    return true;
  }
  return false;
}

/**
 * Comprehensive set of English technical terms, CLI tools, programming symbols,
 * and common English words that should NOT be converted to Greek when typing.
 */
export const PRESERVED_ENGLISH_WORDS: ReadonlySet<string> = new Set([
  // Technical, CLI & dev keywords
  "mcp", "control", "server", "client", "docker", "container", "containers", "service", "services",
  "terminal", "composer", "agent", "agents", "model", "models", "prompt", "prompts", "token", "tokens",
  "context", "stream", "streaming", "branch", "branches", "commit", "commits", "push", "pull", "fetch",
  "merge", "rebase", "stash", "checkout", "clone", "status", "diff", "log", "logs", "test", "tests",
  "testing", "build", "builds", "building", "deploy", "deployment", "deployments", "restart", "start",
  "stop", "reload", "kill", "clean", "cleanup", "reset", "config", "configs", "configuration", "settings",
  "options", "debug", "debugging", "debugger", "trace", "tracing", "info", "warn", "warning", "warnings",
  "error", "errors", "bug", "bugs", "fix", "fixes", "fixed", "fixing", "patch", "patches", "issue", "issues",
  "feature", "features", "release", "releases", "version", "versions", "task", "tasks", "todo", "done",
  "run", "running", "runner", "script", "scripts", "node", "nodejs", "npm", "pnpm", "yarn", "bun", "git",
  "github", "gitlab", "linux", "ubuntu", "debian", "bash", "sh", "zsh", "shell", "ssh", "curl", "wget",
  "grep", "systemctl", "journalctl", "systemd", "nginx", "redis", "postgres", "postgresql", "mysql",
  "sqlite", "mongo", "mongodb", "db", "database", "table", "tables", "column", "columns", "row", "rows",
  "query", "queries", "schema", "migration", "migrations", "api", "apis", "rest", "graphql", "grpc",
  "http", "https", "tcp", "udp", "port", "ports", "host", "hosts", "hostname", "ip", "dns", "domain",
  "domains", "url", "urls", "uri", "uris", "path", "paths", "route", "routes", "router", "endpoint",
  "endpoints", "request", "requests", "response", "responses", "header", "headers", "body", "payload",
  "cookie", "cookies", "session", "sessions", "auth", "login", "logout", "signin", "signout", "signup",
  "user", "users", "username", "password", "key", "keys", "secret", "secrets", "cert", "certs", "certificate",
  "ssl", "tls", "proxy", "cors", "websocket", "socket", "sockets", "hook", "hooks", "state", "props",
  "component", "components", "element", "elements", "dom", "css", "html", "json", "yaml", "yml", "xml",
  "markdown", "md", "file", "files", "folder", "folders", "dir", "directory", "directories", "read",
  "reading", "write", "writing", "edit", "editing", "view", "views", "create", "creating", "delete",
  "deleting", "remove", "removing", "update", "updating", "install", "installing", "uninstall", "upgrade",
  "downgrade", "import", "export", "function", "functions", "class", "classes", "const", "let", "var",
  "type", "types", "interface", "interfaces", "enum", "enums", "async", "await", "promise", "promises",
  "callback", "callbacks", "event", "events", "listener", "listeners", "handler", "handlers", "click",
  "clicking", "press", "pressing", "input", "inputs", "output", "outputs", "keyboard", "layout", "shortcut",
  "shortcuts", "button", "buttons", "dock", "pane", "panes", "panel", "panels", "window", "windows",
  "tab", "tabs", "room", "rooms", "space", "spaces", "workspace", "workspaces", "chat", "message",
  "messages", "voice", "audio", "video", "image", "images", "upload", "uploads", "download", "downloads",
  "sync", "syncing", "clipboard", "copy", "paste", "cut", "undo", "redo", "select", "clear", "search",
  "find", "filter", "sort", "map", "reduce", "length", "size", "width", "height", "top", "bottom",
  "max", "min", "limit", "default",
  "left", "right", "center", "color", "colors", "background", "font", "fonts", "text", "icon", "icons", "border", "margin",
  "padding", "display", "flex", "grid", "block", "inline", "hidden", "visible", "opacity", "index",
  "theme", "themes", "theming", "white", "black", "dark", "light", "gray", "grey", "red", "green", "blue",
  "yellow", "orange", "purple", "cyan", "magenta", "mode", "modes", "style", "styles", "styling",
  "card", "cards", "modal", "modals", "dialog", "dialogs", "menu", "menus", "navbar", "sidebar", "toolbar", "statusbar", "footer",
  "badge", "badges", "avatar", "avatars", "tooltip", "tooltips", "accordion", "slider", "toggle", "toggles", "switch", "switches",
  "lag", "lagging", "lags", "stutter", "stuttering", "freeze", "freezes", "freezing", "fps", "latency", "performance", "speed",
  "mention", "mentioned", "mentioning", "internal", "external", "intervals", "preparation", "prepare", "prepares",
  "attachment", "attachments", "heading", "headings", "screens", "screenshot", "screenshots", "link", "links", "layouts",
  "value", "values", "item", "items", "list", "lists", "array", "arrays", "object", "objects", "string",
  "strings", "number", "numbers", "boolean", "null", "undefined", "true", "false", "id", "ids", "name",
  "names", "title", "titles", "description", "label", "labels", "placeholder", "code", "data", "time",
  "date", "timeout", "interval", "delay", "duration", "cache", "memory", "cpu", "disk", "ram", "process",
  "processes", "pid", "thread", "threads", "queue", "queues", "worker", "workers", "pool", "cluster",
  "admin", "guest", "role", "roles", "rule", "rules", "policy", "policies", "permission", "permissions",
  "group", "groups", "team", "teams", "project", "projects", "org", "repo", "repos", "repository", "pr",
  "mr", "review", "conflict", "conflicts", "origin", "remote", "remotes", "upstream", "downstream", "fork",
  "gateway", "env", "environment", "production", "staging", "development", "dev", "prod", "preview",
  "ci", "cd", "pipeline", "action", "actions", "workflow", "workflows", "job", "jobs", "hash", "tag",
  "tags", "head", "main", "master", "minor", "major", "changelog", "docs", "readme", "license", "package",
  "packages", "dependency", "dependencies", "bundle", "asset", "assets", "public", "private", "static",
  "template", "templates", "controller", "controllers", "util", "utils", "helper", "helpers", "middleware",
  "plugin", "plugins", "module", "modules", "core", "app", "apps", "web", "mobile", "desktop", "backend",
  "frontend", "fullstack", "sdk", "ui", "ux", "gui", "tui", "osk", "llm", "ai", "ml", "gpt", "claude",
  "gemini", "codex", "reasonix", "deepseek", "openai", "anthropic", "google", "spaceapp",

  // Everyday English conversational and operational vocabulary
  "the", "this", "that", "these", "those", "it", "its", "what", "which", "who", "whom", "whose", "where",
  "when", "why", "how", "all", "any", "both", "each", "every", "few", "more", "most", "other", "some",
  "such", "no", "not", "only", "own", "same", "so", "than", "too", "very", "can", "will", "just",
  "should", "would", "could", "may", "might", "must", "shall", "now", "then", "here", "there", "again",
  "further", "once", "about", "above", "across", "after", "against", "along", "among", "around", "at",
  "before", "behind", "below", "beneath", "beside", "between", "beyond", "by", "down", "during", "except",
  "for", "from", "in", "inside", "into", "near", "of", "off", "on", "onto", "out", "outside", "over",
  "through", "throughout", "till", "to", "toward", "under", "until", "up", "upon", "with", "within",
  "without", "and", "or", "but", "nor", "yet", "because", "since", "unless", "while", "although", "though",
  "if", "as", "hello", "hi", "hey", "ok", "okay", "yes", "sure", "please", "thanks", "thank", "you",
  "welcome", "sorry", "help", "good", "bad", "new", "old", "first", "last", "next", "best", "better",
  "fast", "slow", "hard", "easy", "simple", "real", "wrong", "full", "empty", "active", "ready",
  "open", "closed", "safe", "great", "small", "big", "high", "low", "large", "early", "late", "important",
  "able", "check", "make", "show", "send", "want", "need", "like", "look", "give", "tell", "work",
  "call", "try", "ask", "feel", "leave", "put", "mean", "keep", "begin", "seem", "talk", "turn",
  "hear", "play", "move", "live", "believe", "hold", "bring", "happen", "provide", "sit", "stand",
  "lose", "pay", "meet", "include", "continue", "set", "learn", "change", "lead", "understand", "watch",
  "follow", "speak", "allow", "add", "spend", "grow", "walk", "win", "offer", "remember", "love",
  "consider", "appear", "buy", "wait", "serve", "die", "expect", "stay", "fall", "reach", "remain",
  "suggest", "raise", "pass", "sell", "require", "report", "decide", "window", "view", "flow", "draw",
  "know", "review", "preview", "literature", "use", "uses", "used", "using", "tool", "tools"
]);

/**
 * English tokens that overlap with Greek QWERTY mistypes of very common Greek words.
 * When typing Greek in QWERTY, these should still convert to their Greek counterparts
 * (e.g. "to" -> "το", "me" -> "με", "as" -> "ας", "an" -> "αν", "den" -> "δεν").
 */
export const GREEK_QWERTY_HOMOPHONES: ReadonlySet<string> = new Set([
  "to", "me", "as", "an", "den"
]);

/**
 * Returns true if the token is a recognized English word or technical keyword
 * that should be preserved in Latin, excluding Greek QWERTY homophones.
 */
export function isPreservedEnglishWord(token: string): boolean {
  if (!token) return false;
  const lower = token.toLowerCase();
  if (GREEK_QWERTY_HOMOPHONES.has(lower)) {
    return false;
  }
  return PRESERVED_ENGLISH_WORDS.has(lower) || englishSpellingCandidates(lower).length > 0;
}

/** One insertion, deletion, substitution or adjacent transposition. */
function isOneSpellingEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1) ||
      (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

const spellingCache = new Map<string, string[]>();
function englishSpellingCandidates(lower: string): string[] {
  // Never guess short words, identifiers, or a recognized Greek transliteration.
  if (!/^[a-z]{7,32}$/.test(lower) || PRESERVED_ENGLISH_WORDS.has(lower) ||
    GREEKLISH_WORDS.has(lower) || isRecognizedGreekLayout(lower)) return [];
  const cached = spellingCache.get(lower);
  if (cached) return cached;
  const matches = [...PRESERVED_ENGLISH_WORDS].filter((word) => word.length >= 5 && isOneSpellingEdit(lower, word));
  if (spellingCache.size >= 256) spellingCache.delete(spellingCache.keys().next().value!);
  spellingCache.set(lower, matches);
  return matches;
}

function correctEnglishSpelling(token: string): string {
  const titleCase = /^[A-Z][a-z]+$/.test(token);
  if (!/^[a-z]+$/.test(token) && !titleCase) return token;
  const candidates = englishSpellingCandidates(token.toLowerCase());
  if (candidates.length !== 1) return token;
  const corrected = candidates[0]!;
  return titleCase ? corrected[0]!.toUpperCase() + corrected.slice(1) : corrected;
}

function correctEnglishProse(input: string): string {
  return mapProse(input, (prose) => prose.replace(/[\p{L}\p{N}_./\\-]+/gu, correctEnglishSpelling));
}

/**
 * Converts Latin QWERTY characters into Greek monotonic text character-by-character,
 * resolving dead keys for tonos (";"), dialytika (":"), combined tonos+dialytika (";:" / ":;"),
 * and word-final sigma ("ς").
 */
export function convertQwertyToGreekCharByChar(input: string): string {
  if (!input) return "";

  let result = "";
  let i = 0;
  const len = input.length;

  while (i < len) {
    // 1. Combined Dialytika + Tonos: ";:" or ":;"
    if (i + 2 < len && ((input[i] === ";" && input[i + 1] === ":") || (input[i] === ":" && input[i + 1] === ";"))) {
      const nextChar = input[i + 2];
      if (nextChar && GREEK_TONOS_DIALYTIKA_MAP[nextChar]) {
        result += GREEK_TONOS_DIALYTIKA_MAP[nextChar];
        i += 3;
        continue;
      }
    }

    // 2. Tonos dead key: ";" followed by a vowel or w/u
    if (input[i] === ";" && i + 1 < len) {
      const nextChar = input[i + 1];
      if (nextChar && GREEK_TONOS_MAP[nextChar]) {
        result += GREEK_TONOS_MAP[nextChar];
        i += 2;
        continue;
      }
    }

    // 3. Dialytika dead key: ":" followed by i or y
    if (input[i] === ":" && i + 1 < len) {
      const nextChar = input[i + 1];
      if (nextChar && GREEK_DIALYTIKA_MAP[nextChar]) {
        result += GREEK_DIALYTIKA_MAP[nextChar];
        i += 2;
        continue;
      }
    }

    // 4. Standard mapping
    const ch = input[i];
    if (ch) {
      result += QWERTY_TO_GREEK_CHAR_MAP[ch] ?? ch;
    }
    i++;
  }

  // Convert non-terminal sigma 'σ' to final sigma 'ς' at word boundaries
  return result.replace(/σ(?=[^\p{L}]|$)/gu, "ς");
}

/**
 * Smart zero-hardcoding Greeklish transliteration engine based on universal phonetic rules.
 * Automatically handles Greeklish digraphs (th, ou, ch, ps, ks, mp, nt, gk, ts, tz, sh, sx),
 * diphthongs (au, eu), word-final sigma (w -> ς), and middle-vowel omega (w -> ω).
 */
export function smartTransliterateWord(token: string): string {
  if (!token) return "";
  if (hasGreekDeadKey(token)) {
    return convertQwertyToGreekCharByChar(token);
  }

  const isCapitalized = /^[A-Z][a-z]/.test(token);
  const isAllUpper = /^[A-Z0-9]+$/.test(token) && token.length > 1;
  const lower = token.toLowerCase();

  // 1. Direct dictionary match for known accented Greek words
  const vocab = GREEKLISH_WORDS.get(lower);
  if (vocab) {
    if (isAllUpper) return vocab.toUpperCase();
    if (isCapitalized) return vocab[0]!.toUpperCase() + vocab.slice(1);
    return vocab;
  }

  // 2. Universal digraph and multigraph replacements
  let s = lower;
  s = s.replace(/ou|oy/g, "ου");
  s = s.replace(/th/g, "θ");
  s = s.replace(/ch/g, "χ");
  s = s.replace(/ps/g, "ψ");
  s = s.replace(/ks/g, "ξ");
  s = s.replace(/mp/g, "μπ");
  s = s.replace(/nt/g, "ντ");
  s = s.replace(/gk/g, "γκ");
  s = s.replace(/ts/g, "τσ");
  s = s.replace(/tz/g, "τζ");
  s = s.replace(/sh/g, "σ");
  s = s.replace(/sx/g, "σχ");

  s = s.replace(/au/g, "αυ");
  s = s.replace(/eu/g, "ευ");

  let res = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (/[\u0370-\u03FF]/.test(ch)) {
      res += ch;
      continue;
    }
    if (ch === "w") {
      // In Greek, final sigma 'ς' only occurs at the end of words following a vowel.
      // In all other positions (middle of word, or following a consonant at end of verb e.g. thelw), it is omega 'ω'.
      if (i === s.length - 1) {
        const prev = i > 0 ? s[i - 1]! : "";
        if (/[aehiouyvαεηιουω]/.test(prev)) {
          res += "ς";
        } else {
          res += "ω";
        }
      } else {
        res += "ω";
      }
      continue;
    }
    const mapped = QWERTY_TO_GREEK_CHAR_MAP[ch] ?? ch;
    res += mapped;
  }

  res = res.replace(/σ(?=[^\p{L}]|$)/gu, "ς");

  if (isAllUpper) return res.toUpperCase();
  if (isCapitalized && res.length > 0) return res[0]!.toUpperCase() + res.slice(1);
  return res;
}

/**
 * Converts Latin QWERTY characters into Greek monotonic text.
 * By default (`preserveEnglishWords: true`), recognized English technical terms,
 * commands (e.g. "mcp", "control", "docker", "server"), and code identifiers
 * (e.g. "paneId", "package.json", "space-web") are preserved untouched.
 */
export function convertQwertyToGreek(
  input: string,
  options?: { preserveEnglishWords?: boolean }
): string {
  if (!input) return "";

  const preserve = options?.preserveEnglishWords ?? true;
  if (!preserve) {
    const raw = convertQwertyToGreekCharByChar(input);
    recordGreekLayoutDebug({
      source: "convertQwertyToGreek",
      input,
      output: raw,
      changed: raw !== input,
      direction: "toGreek",
      tokens: []
    });
    return raw;
  }

  const hasGreekContext = /[\u0370-\u03FF]/.test(input);
  const inputTokens = input.match(/[\p{L}\p{N}_./\\-]+/gu) ?? [];
  const hasDistinctiveGreek = hasGreekContext || hasGreekDeadKey(input) || inputTokens.some((t) => {
    const l = t.toLowerCase();
    if (PRESERVED_ENGLISH_WORDS.has(l) || GREEK_QWERTY_HOMOPHONES.has(l) || isCodeOrIdentifier(t)) return false;
    return isRecognizedGreekLayout(l) || GREEKLISH_WORDS.has(l);
  });
  const debugTokens: GreekTokenDebugEntry[] | null = debugInspectionDepth > 0 ? [] : null;
  // Match word-like clusters including internal/leading dead keys
  const tokenRegex = /([a-zA-Z0-9_./\\-]+(?:[;:]+[a-zA-Z0-9_./\\-]+)*|[;:]+[a-zA-Z0-9_./\\-]+)/g;
  const result = mapProse(input, (prose) => prose.replace(tokenRegex, (token) => {
    const lower = token.toLowerCase();
    const deadKey = hasGreekDeadKey(token);
    const codeId = isCodeOrIdentifier(token);
    const homophone = GREEK_QWERTY_HOMOPHONES.has(lower);
    const preservedEnglish = PRESERVED_ENGLISH_WORDS.has(lower);
    const qwertyChar = convertQwertyToGreekCharByChar(token);
    const greeklishCandidate = GREEKLISH_WORDS.get(lower);
    const recognizedLayout = isRecognizedGreekLayout(lower);

    // 1. Greek dead key (;a, :i, ;:i) is 100% intentional Greek QWERTY typing
    if (deadKey) {
      debugTokens?.push({
        token, lower, hasDeadKey: true, isCodeOrIdentifier: codeId, isPreservedEnglish: preservedEnglish,
        isHomophone: homophone, qwertyConverted: qwertyChar, isRecognizedGreek: true,
        action: "PRESERVE_DEADKEY", result: qwertyChar,
        reasonDescription: "Greek dead key tonos/dialytika sequence"
      });
      return qwertyChar;
    }
    // 2. Code or identifiers (camelCase, snake_case, paths, acronyms)
    if (codeId) {
      debugTokens?.push({
        token, lower, hasDeadKey: false, isCodeOrIdentifier: true, isPreservedEnglish: preservedEnglish,
        isHomophone: homophone, qwertyConverted: qwertyChar, isRecognizedGreek: false,
        action: "PRESERVE_CODE", result: token,
        reasonDescription: "Code identifier, path, acronym, or programming symbol"
      });
      return token;
    }
    // 3. Greek QWERTY homophones (to -> το, me -> με, as -> ας, an -> αν, den -> δεν)
    // Only converted if there is surrounding Greek context or distinctive Greek words in the input.
    if (homophone) {
      if (hasDistinctiveGreek) {
        debugTokens?.push({
          token, lower, hasDeadKey: false, isCodeOrIdentifier: false, isPreservedEnglish: preservedEnglish,
          isHomophone: true, qwertyConverted: qwertyChar, isRecognizedGreek: true,
          action: "CONVERT_HOMOPHONE", result: qwertyChar,
          reasonDescription: "Greek QWERTY homophone word in Greek context"
        });
        return qwertyChar;
      }
      debugTokens?.push({
        token, lower, hasDeadKey: false, isCodeOrIdentifier: false, isPreservedEnglish: true,
        isHomophone: true, qwertyConverted: qwertyChar, isRecognizedGreek: false,
        action: "PRESERVE_ENGLISH", result: token,
        reasonDescription: "English homophone preserved in English context"
      });
      return token;
    }
    // 4. Preserved English keywords (mcp, control, docker, server, git, etc.)
    if (preservedEnglish) {
      debugTokens?.push({
        token, lower, hasDeadKey: false, isCodeOrIdentifier: false, isPreservedEnglish: true,
        isHomophone: false, qwertyConverted: qwertyChar, isRecognizedGreek: false,
        action: "PRESERVE_ENGLISH", result: token,
        reasonDescription: "Preserved English technical keyword or common word"
      });
      return token;
    }
    // 5. Correct only unambiguous English typos if not in Greek context
    if (!hasGreekContext && englishSpellingCandidates(lower).length > 0) {
      const res = correctEnglishSpelling(token);
      debugTokens?.push({
        token, lower, hasDeadKey: false, isCodeOrIdentifier: false, isPreservedEnglish: false,
        isHomophone: false, qwertyConverted: qwertyChar, isRecognizedGreek: false,
        action: "PRESERVE_ENGLISH", result: res,
        reasonDescription: `English spelling candidate corrected: "${token}" -> "${res}"`
      });
      return res;
    }
    // 6. Recognized Greek layout
    if (recognizedLayout) {
      debugTokens?.push({
        token, lower, hasDeadKey: false, isCodeOrIdentifier: false, isPreservedEnglish: false,
        isHomophone: false, qwertyConverted: qwertyChar, isRecognizedGreek: true,
        action: "CONVERT_QWERTY", result: qwertyChar,
        reasonDescription: `Recognized Greek morphology / QWERTY layout: "${token}" -> "${qwertyChar}"`
      });
      return qwertyChar;
    }
    // 7. Greeklish vocabulary match for non-layout words (e.g. pethxe -> πέτυχε, arxizoun -> αρχίζουν)
    if (greeklishCandidate) {
      const titleCase = /^[A-Z][a-z]+$/.test(token);
      const res = titleCase ? greeklishCandidate[0]!.toUpperCase() + greeklishCandidate.slice(1) : greeklishCandidate;
      debugTokens?.push({
        token, lower, hasDeadKey: false, isCodeOrIdentifier: false, isPreservedEnglish: false,
        isHomophone: false, greeklishMatch: greeklishCandidate, qwertyConverted: qwertyChar, isRecognizedGreek: true,
        action: "CONVERT_GREEKLISH", result: res,
        reasonDescription: `Greeklish vocabulary match: "${token}" -> "${res}"`
      });
      return res;
    }
    // 8. Context-Aware Inversion (Pillar 1): In text that already contains Greek,
    // any non-technical, non-code Latin token is assumed to be Greek and converted,
    // provided it forms valid Greek morphology or Greeklish.
    if (hasGreekContext) {
      const isGreekCandidate = isRecognizedGreekLayout(lower) || GREEKLISH_WORDS.has(lower) ||
        (!qwertyChar.includes(";") && !qwertyChar.includes(":") && !/[a-zA-Z]/.test(qwertyChar) && /[αεηιουωάέήίόύώ]/u.test(qwertyChar) && /(?:[αειοωάέίόώ]|[αειοωάέίόώ][ςν])$/u.test(qwertyChar) && (COMMON_GREEK_WORDS.has(qwertyChar) || RECOGNIZED_GREEK_LAYOUT_WORDS.has(qwertyChar) || scoreGreekMismatch(token) >= 3));
      if (isGreekCandidate) {
        const transliterated = smartTransliterateWord(token);
        const res = transliterated || (COMMON_GREEK_WORDS.has(qwertyChar) || RECOGNIZED_GREEK_LAYOUT_WORDS.has(qwertyChar) ? qwertyChar : token);
        if (res !== token) {
          debugTokens?.push({
            token, lower, hasDeadKey: false, isCodeOrIdentifier: false, isPreservedEnglish: false,
            isHomophone: false, qwertyConverted: qwertyChar, isRecognizedGreek: true,
            action: "CONVERT_QWERTY", result: res,
            reasonDescription: `Context-aware Greek conversion in Greek sentence: "${token}" -> "${res}"`
          });
          return res;
        }
      }
    }

    // 9. Unrecognized token: kept as-is
    debugTokens?.push({
      token, lower, hasDeadKey: false, isCodeOrIdentifier: false, isPreservedEnglish: false,
      isHomophone: false, qwertyConverted: qwertyChar, isRecognizedGreek: false,
      action: "UNTOUCHED_UNRECOGNIZED", result: token,
      reasonDescription: `Not recognized as Greek layout or Greeklish; kept intact to prevent corruption: "${token}"`
    });
    return token;
  }));

  recordGreekLayoutDebug({
    source: "convertQwertyToGreek",
    input,
    output: result,
    changed: result !== input,
    direction: "toGreek",
    tokens: debugTokens ?? []
  });

  return result;
}

/**
 * Converts Greek characters into Latin QWERTY keys.
 */
export function convertGreekToQwerty(input: string): string {
  if (!input) return "";

  let result = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch) {
      result += GREEK_TO_QWERTY_CHAR_MAP[ch] ?? ch;
    }
  }
  return result;
}

export interface LayoutMismatchDetection {
  requiresConfirmation?: boolean;
  hasMismatch: boolean;
  direction: "toGreek" | "toQwerty";
  convertedText: string;
  confidence: number;
  reason: string;
}

export const COMMON_GREEK_WORDS = new Set([
  "και", "κι", "να", "για", "πως", "θα", "το", "τα", "τη", "την", "της", "του", "των", "τον", "τους", "τις", "ο", "η", "οι",
  "στο", "στη", "στην", "στον", "στους", "στις", "στα", "ενα", "ενας", "μια", "μιας", "ενός", "ενως",
  "μου", "σου", "του", "της", "μας", "σας", "τους", "τον", "την", "τα",
  "ειμαι", "εισαι", "ειναι", "ειμαστε", "ειστε", "ηταν", "ησουν", "ημασταν", "ησασταν",
  "αυτο", "αυτα", "αυτη", "αυτης", "αυτος", "αυτου", "αυτον", "αυτοι", "αυτων", "αυτους", "αυτες",
  "εκεινο", "εκεινη", "εκεινος", "εκεινα",
  "ποιος", "ποια", "ποιο", "ποιοι", "ποιες", "ποιων", "ποιους", "ποτε", "γιατι",
  "ολα", "ολοι", "ολη", "ολης", "ολος", "ολων", "ολους", "ολες",
  "αλλο", "αλλη", "αλης", "αλλος", "αλλων", "αλλους", "αλλες", "αλλα",
  "κατι", "καποιος", "καποια", "καποιο", "καποιοι", "τιποτα", "κανεις", "κανενας",
  "με", "σε", "τι", "που", "δεν", "μη", "μην", "ομως", "ωστε", "ενω", "αν", "εαν", "αφου", "μολις", "οταν", "σαν",
  "τωρα", "εδω", "εκει", "καλα", "πολυ", "λιγο", "πιο", "πρωτα", "μετα", "πριν", "παντα", "ποτε", "μαζι", "μονο",
  "επισης", "ακομα", "ακομη", "ξανα", "σωστα", "σωστο", "λαθος", "δηλαδη", "ισως", "βεβαια",
  "εχω", "εχεις", "εχει", "εχουμε", "εχετε", "εχουν", "εχουνε", "ειχα",
  "κανω", "κανεις", "κανει", "κανουμε", "κανετε", "κανουν", "κανουνε", "κανε", "καν",
  "θελω", "θελεις", "θελει", "θελουμε", "θελετε", "θελουν",
  "πρεπει", "μπορει", "μπορω", "μπορεις", "μπορουμε", "μπορειτε", "μπορουν",
  "βλεπω", "βλεπεις", "βλεπει", "βλεπουμε", "βλεπετε", "βλεπουν",
  "ξερω", "ξερεις", "ξερει", "ξερουμε", "ξερετε", "ξερουν",
  "δω", "δεις", "δει", "δουμε", "δειτε", "δουν",
  "παταω", "πατας", "παταει", "πατησω", "πατησεις", "πατησει", "πατησα", "πατησαμε", "πατηστε",
  "γραφω", "γραφεις", "γραφει", "γραψω", "γραψεις", "γραψει", "γραψαμε", "γραψε", "γραψτε",
  "δουλευει", "δουλεψει", "δουλευουν", "δουλεψουν", "δουλευε",
  "φτιαξω", "φτιαξεις", "φτιαξει", "φτιαξουμε", "φτιαξε", "φτιαξτε",
  "λειτουργει", "λειτουργουν", "λειτουργησει",
  "τρεξω", "τρεξει", "τρεξουμε", "τρεξε",
  "αλλαξω", "αλλαξει", "αλλαξε",
  "ανοιξω", "ανοιξει", "ανοιξε", "κλεισω", "κλεισει", "κλεισε",
  "στειλω", "στειλει", "στειλε", "στελνω",
  "προσθετω", "προσθεσω", "προσθεσε", "προσθεσα", "προσθεσουμε", "προσθεστε",
  "διορθωσω", "διορθωσει", "διορθωσε", "διορθωσα", "διορθωση",
  "ενημερωσω", "ενημερωσει", "ενημερωσε", "ενημερωστε", "ενημερωση",
  "συμπληρωσω", "συμπληρωσει", "συμπληρωσε",
  "εμφανιζει", "εμφανισει", "εμφανιζεται", "δειχνει",
  "ευχαριστω", "παρακαλω", "ναι", "οχι", "μερα", "καλημερα", "καλησπερα", "γειασου", "γεια",
  "μνημη", "μνημης", "κειμενο", "κειμενα", "επιπλεον", "αρχικη", "αρχικο", "τελικο", "αρχειο", "αρχεια",
  "φακελος", "φακελο", "κουμπι", "πληκτρολογιο", "εικονιδιο", "σημειο", "σημεια", "δοκιμη", "δοκιμες",
  "προβλημα", "προβληματα", "ελεγχος", "ελεγχο", "ελεγξε", "βελτιωση", "βελτιωσεις", "ρυθμιση", "ρυθμισεις", "λυση", "λυσεις", "εφαρμογη", "εφαρμογης", "αναφορα",
  "πετυχε", "πετυχα", "αρχιζουν", "αρχισε", "αρχισαν", "αρχιζει", "υπαρχει", "υπαρχουν", "επιλογη", "επιλογες", "εκει"
]);

const AMBIGUOUS_WORDS = new Set(["το", "με"]);

// Keep executable/literal content out of both detection and correction. In
// particular, a URL query or email can contain Greek-looking words/dead keys.
function mapProse(input: string, convert: (prose: string) => string): string {
  const literals = /```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|$)|(?:https?:\/\/|www\.)[^\s<>]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\/[\w.-]+)+|\b[\w.-]+\.[a-z]{2,}(?:\/[\w./?=&%-]*)?/gi;
  let offset = 0;
  let output = "";
  for (const match of input.matchAll(literals)) {
    output += convert(input.slice(offset, match.index)) + match[0];
    offset = match.index + match[0].length;
  }
  return output + convert(input.slice(offset));
}

// Deliberately bounded vocabulary: unknown words/names stay intact. These are
// user-text conversions, not UI translations or a general spelling checker.
const GREEKLISH_WORDS = new Map<string, string>();
for (const [greek, aliases] of [
  ["βελτίωσε", "beltivse beltiwse beltiose veltiwse veltiose veltivse"],
  ["βελτίωση", "beltivsh beltiwsi veltiosi veltiwsi"],
  ["εργαλείο", "ergaleio ergalio"], ["εργαλεία", "ergaleia ergalia"],
  ["θέλω", "thelo thelw uelv"], ["θέλεις", "theleis thelis ueleis"],
  ["μπορείς", "mporeis mporis boreis boris"], ["μπορώ", "mporo mporw boro borw"],
  ["μπορεί", "mporei mpori"], ["περιέχει", "periexei periechei periexi"],
  ["ορθογράφο", "orthografo oruografo"], ["ορθογραφία", "orthografia oruografia"],
  ["ώστε", "oste wste vste"], ["γίνονται", "ginontai ginonte"],
  ["αλλαγές", "allages"], ["κείμενα", "keimena kimena"], ["πρέπει", "prepei prepi"],
  ["βοήθεια", "voitheia boitheia voithia boithia"],
  ["βοήθησε", "voithise boithise voithhse boithhse"],
  ["διόρθωσε", "diorthose diorthwse dioruvse"],
  ["πρόσθεσε", "prosthese prosuese"], ["άλλαξε", "allaxe allakse allaje"],
  ["άνοιξε", "anoixe anoikse anoije"], ["κλείσε", "kleise klise"],
  ["γράψε", "grapse grace"], ["δείξε", "deixe deikse deije"],
  ["εξήγησε", "exigise eksigise ejhghse"], ["έλεγξε", "elegxe elegkse"],
  ["συνέχισε", "synexise sinexise synehise"],
  ["ευχαριστώ", "euxaristo efharisto eyxaristv"],
  ["παρακαλώ", "parakalo parakalw parakalv"],
  ["καλημέρα", "kalimera kalhmera"], ["καλησπέρα", "kalispera kalhspera"],
  ["δουλεύει", "douleuei doulevei doyleyei"],
  ["δουλεύουν", "douleuoun doulevoun doyleyoyn"],
  ["δούμε", "doume doyme"], ["κάνουμε", "kanoume kanoyme"],
  ["κάνε", "kane"], ["κάνει", "kanei kani"], ["κάνεις", "kaneis kanis kaneiw"],
  ["είναι", "einai ine"], ["είμαι", "eimai ime"], ["είσαι", "eisai ise"],
  ["σωστά", "sosta swsta svsta"], ["λάθος", "lathos lauos"],
  ["τώρα", "tora twra tvra"], ["εδώ", "edo edw edv"],
  ["αυτό", "ayto auto afto"], ["αυτή", "ayth auth afti"],
  ["αυτά", "ayta auta afta"], ["αυτές", "aytes autes aftes"],
  ["καλύτερα", "kalytera kalitera"], ["καλύτερο", "kalytero kalitero"],
  ["περισσότερα", "perissotera perisotera"], ["γρήγορα", "grigora grhgora"],
  ["λίγο", "ligo"], ["πολύ", "poly poli"], ["όλα", "ola"],
  ["ένα", "ena"], ["άλλο", "allo"], ["κάτι", "kati"],
  ["μου", "mou moy"], ["σου", "sou soy"], ["μας", "mas"], ["σας", "sas"],
  ["το", "to"], ["τα", "ta"], ["τη", "th"], ["τι", "ti"], ["την", "thn tin"],
  ["τον", "ton"], ["του", "tou toy"], ["τις", "tis"],
  ["στο", "sto"], ["στη", "sth sti"], ["στην", "sthn stin"],
  ["στον", "ston"], ["στα", "sta"], ["και", "kai ke"],
  ["να", "na"], ["θα", "tha ua"], ["για", "gia"],
  ["με", "me"], ["σε", "se"], ["δεν", "den"], ["μην", "min mhn"],
  ["που", "pou poy"], ["πως", "pos pws pvw"],
  ["πέτυχε", "pethxe petixe petuxe petyxe petihe"],
  ["πέτυχα", "pethxa petixa petuxa petyxa"],
  ["αρχίζουν", "arxizoun arhizoun archizoun arxizoyn arhizoyn"],
  ["αρχίζει", "arxizei arhizei archizei"],
  ["άρχισε", "arxise arhise archise"],
  ["αρχίσουν", "arxisoun arhisoun archisoun"],
  ["υπάρχει", "yparxei iparxei yparxi iparxi"],
  ["υπάρχουν", "yparxoun iparxoun yparxoyn iparxoyn"],
  ["επιλογή", "epilogi epilogh"],
  ["επιλογές", "epiloges"],
  ["εκεί", "ekei eki"],
  ["γιατί", "giati giath"],
  ["όχι", "oxi ohi ochi"],
] as const) {
  for (const alias of aliases.split(" ")) GREEKLISH_WORDS.set(alias, greek);
}

const RECOGNIZED_GREEK_LAYOUT_WORDS = new Set([
  ...COMMON_GREEK_WORDS, ...[...GREEKLISH_WORDS.values()].map((word) => word.normalize("NFD").replace(/\p{M}/gu, "")),
  "καλος", "ανθρωπος", "κοσμος", "ενημερωστε", "καλησπερας"
]);
export function isRecognizedGreekLayout(token: string): boolean {
  if (!token) return false;
  if (token.length === 1) {
    const l = token.toLowerCase();
    return l === "o" || l === "h";
  }
  const greek = convertQwertyToGreekCharByChar(token).replace(/;$/, "");
  if (greek.includes(";") || /[a-zA-Z]/.test(greek)) return false;
  if (RECOGNIZED_GREEK_LAYOUT_WORDS.has(greek)) return true;
  const hasGreekEnding = /(?:mata|ma|seis|shs|sh|smo|smos|smous|smwn|etai|ontai|otan|ontan|hke|hka|hkes|hkame|hkate|hkan|hkane|hxe|hxa|hxan|hsei|hsw|hsoun|isei|isw|isoun|wsei|wsw|wsoun|hxe|yxe|yxa|exe|exa|apse|apsa|wse|wsa|ise|isa|oume|oun|oune|oun|ete|ei|eis|ika|iko|ikos|ikhs|ikwn|ia|io|ios|ias|iwn|eia|eies|eiwn|othta|othtes|os|h|as|hs|es|ous|wn|w|ou|an|ane|ame|ate|[aiowAIOW])$/i.test(token) ||
    /(?:omata|ματα|μα|σεις|σης|ση|σμο|σμος|σμους|σμων|εται|ονται|οταν|ονταν|ηκε|ηκα|ηκες|ηκαμε|ηκατε|ηκαν|ηκανε|ηξε|ηξα|ηξαν|ησει|ησω|ησουν|ισει|ισω|ισουν|ωσει|ωσω|ωσουν|ηχε|υχε|υχα|εξε|εξα|αψε|αψα|ωσε|ωσα|ισε|ισα|ουμε|ουν|ουνε|οθν|ετε|ει|εις|ικα|ικο|ικος|ικης|ικων|ια|ιο|ιος|ιας|ιων|εια|ειες|ειων|οτητα|οτητες|ος|η|ας|ης|ες|ους|ων|ω|ου|αν|ανε|αμε|ατε|[αειοωάέίόώ]|[αειοωάέίόώ][ςν])$/u.test(greek);
  const hasGreekPhonotactics = /(?:gx|xt|xrh|mnh|lhm|rhm|phm|[txkpdmnbgz]v|v[wsrktpxmn]|[a-zA-Z]+v\b|[aehioyuvw]w\b)/i.test(token);
  const hasVerbEndingE = /[βγδζθκλμνξπρστφχψ]ε$/u.test(greek) && greek.length >= 3;
  const hasVowel = /[αεηιουωάέήίόύώ]/u.test(greek);
  return (hasGreekEnding || hasGreekPhonotactics || hasVerbEndingE) && hasVowel && greek.length >= 2;
}

function convertRecognizedGreeklish(input: string): string | null {
  const tokenRegex = /[\p{L}\p{N}_./\\-]+/gu;
  let distinctiveWord = false;
  const converted = mapProse(input, (prose) => prose.replace(tokenRegex, (token) => {
    const lower = token.toLowerCase();
    const greek = GREEKLISH_WORDS.get(lower);
    // Title case is prose; acronyms, camelCase and technical words are not.
    const titleCase = /^[A-Z][a-z]+$/.test(token);
    if (!greek || isPreservedEnglishWord(token) || (!titleCase && isCodeOrIdentifier(token))) return correctEnglishSpelling(token);
    if (token.length >= 4 && lower !== "auto" && lower !== "boris" && lower !== "poli" &&
      !COMMON_GREEK_WORDS.has(convertQwertyToGreekCharByChar(lower))) {
      distinctiveWord = true;
    }
    return titleCase ? greek[0]!.toUpperCase() + greek.slice(1) : greek;
  }));
  return distinctiveWord ? converted : null;
}

/**
 * Detects whether the given input text was typed with the wrong keyboard layout.
 */
export function detectKeyboardLayoutMismatch(input: string): LayoutMismatchDetection {
  const detection = detectLayoutMismatch(input);
  let finalDetection = detection;
  // The same proposal drives preview, button and shortcut; applying it is
  // always explicit. Spelling correction never rewrites code/literals.
  if (!detection.hasMismatch && !/for\s*\(|let\s+|const\s+|import\s+|\bfunction\b|=>|[{}]/.test(input)) {
    const corrected = correctEnglishProse(input);
    if (corrected !== input) {
      finalDetection = {
        hasMismatch: true, direction: "toGreek", convertedText: corrected,
        confidence: 0.94, requiresConfirmation: true, reason: "Detected an unambiguous English spelling correction."
      };
    }
  }
  const result = finalDetection.convertedText === input ? { ...finalDetection, hasMismatch: false, confidence: 0 } : finalDetection;

  recordGreekLayoutDebug({
    source: "detectLayoutMismatch",
    input,
    output: result.convertedText,
    changed: result.hasMismatch,
    direction: result.direction,
    confidence: result.confidence,
    detectionReason: result.reason,
    tokens: []
  });

  return result;
}

/**
 * Statistical phonetic and morphological score evaluating whether a Latin text
 * represents mistyped Greek QWERTY or Greeklish rather than intentional English.
 */
export function scoreGreekMismatch(text: string): number {
  let score = 0;
  // Dead keys are 100% intentional Greek typing
  if (/;[aehiouywvAEHIOUYWV]/.test(text)) score += 10;
  if (/:[iyIY]/.test(text)) score += 8;

  // Greek question mark key 'q' or final sigma 'w' at end of words
  const qwMatches = text.match(/\b[a-zA-Z]+(?:[aehioyuvw]w|[aehioyuvw]wq)\b/g);
  if (qwMatches) {
    for (const m of qwMatches) {
      if (!isPreservedEnglishWord(m) && !isCodeOrIdentifier(m)) {
        score += 5;
      }
    }
  }

  // QWERTY 'v' used for 'ω' in non-English patterns (e.g. tvra, enhmervste, pvw, beltivse, vste, parakalv)
  if (/(?:[txkpdmnbgz]v|v[wsrktpxmn]|[a-zA-Z]+v\b)/i.test(text)) {
    const vMatches = text.match(/\b[a-zA-Z]*(?:[txkpdmnbgz]v|v[wsrktpxmn]|[a-zA-Z]+v\b)[a-zA-Z]*\b/gi);
    if (vMatches) {
      for (const m of vMatches) {
        if (!isPreservedEnglishWord(m) && !isCodeOrIdentifier(m)) {
          score += 4;
        }
      }
    }
  }

  // Greek-specific consonant clusters that do not appear in standard English words:
  // gx, xt, xrh, mnh, lhm, rhm, phm, sx, thx
  if (/\b[a-zA-Z]*(?:gx|xt|xrh|mnh|lhm|rhm|phm|sx|thx)[a-zA-Z]*\b/i.test(text)) {
    score += 4;
  }

  // Common Greek morphological endings in Latin layout:
  // -oume, -oun, -oune, -oyme, -oyn, -mata, -seis, -smos, -smous, -smwn, -ontas, -wntas, -hke, -hkan, -hsan, -ate, -ame, -aste, -este
  const greekEndings = /\b[a-zA-Z]+(?:oume|oun|oune|oyme|oyn|mata|seis|smos|smous|smwn|ontas|wntas|hke|hkan|hsan|ate|ame|aste|este)\b/gi;
  const endingMatches = text.match(greekEndings);
  if (endingMatches) {
    for (const m of endingMatches) {
      if (!isPreservedEnglishWord(m) && !isCodeOrIdentifier(m)) {
        score += 4;
      }
    }
  }

  // Common Greeklish digraphs (th, ou, oy, ch, ps, ks) in non-English tokens
  const greeklishDigraphs = /\b[a-zA-Z]*(?:th|ou|oy|ch|ps|ks)[a-zA-Z]*\b/gi;
  const digraphMatches = text.match(greeklishDigraphs);
  if (digraphMatches) {
    for (const m of digraphMatches) {
      if (!isPreservedEnglishWord(m) && !isCodeOrIdentifier(m)) {
        score += 3;
      }
    }
  }

  return score;
}

function detectLayoutMismatch(input: string): LayoutMismatchDetection {
  // Mask literals without exposing their contents to language heuristics.
  let proseOnly = "";
  mapProse(input, (prose) => { proseOnly += ` ${prose}`; return prose; });
  const trimmed = proseOnly.trim();
  const negative: LayoutMismatchDetection = {
    hasMismatch: false,
    direction: "toGreek",
    convertedText: input,
    confidence: 0,
    reason: ""
  };

  if (!trimmed || trimmed.length < 2) {
    return negative;
  }

  // Avoid false positives in code snippets like "for(let i=0;i<10;i++)" or CSS
  const looksLikeCode = /for\s*\(|let\s+|const\s+|import\s+|\bfunction\b|=>|[{}]/.test(trimmed);

  if (looksLikeCode) return negative;

  // Explicit dead keys retain exact keyboard semantics; phonetic Greeklish
  // needs word-level spelling instead (e.g. "thelo", "beltivse", "ergaleio").
  const greeklish = hasGreekDeadKey(trimmed) ? null : convertRecognizedGreeklish(input);
  if (greeklish !== null && greeklish !== input) {
    return {
      hasMismatch: true, direction: "toGreek", convertedText: greeklish,
      confidence: 0.97, reason: "Detected recognized Greeklish words."
    };
  }

  // 1. High Confidence: Dead key tonos pattern ";[aehiouywv]"
  // In standard English text, semicolon is followed by a space, never a lowercase letter in a word.
  // E.g., "l;auow", "k;aneiw", "pr;oblhma", "d;wse", ";ola"
  const deadKeyTonosRegex = /;[aehiouywvAEHIOUYWV]/;
  if (!looksLikeCode && deadKeyTonosRegex.test(trimmed)) {
    const converted = convertQwertyToGreek(input);
    return {
      hasMismatch: true,
      direction: "toGreek",
      convertedText: converted,
      confidence: 0.99,
      reason: "Detected Greek dead-key tonos sequence (; + vowel) in Latin text."
    };
  }

  // 2. High Confidence: Dead key dialytika ":[iy]"
  const deadKeyDialytikaRegex = /:[iyIY]/;
  if (deadKeyDialytikaRegex.test(trimmed)) {
    const looksLikeUrlOrTime = /https?:\/\/|:\d{2}/.test(trimmed);
    if (!looksLikeUrlOrTime) {
      const converted = convertQwertyToGreek(input);
      return {
        hasMismatch: true,
        direction: "toGreek",
        convertedText: converted,
        confidence: 0.95,
        reason: "Detected Greek dead-key dialytika sequence (: + i/y) in Latin text."
      };
    }
  }

  // 3. Greek question mark key 'q' or final sigma 'w' in Greek-like QWERTY word endings
  // E.g. "ti kaneiwq", "l;auow", "kalhsperaw", "authw", "pvw"
  // Words matching English vocabulary (e.g. "show", "window", "view", "new") are excluded.
  const candidateMatches = trimmed.match(/\b[a-zA-Z]+(?:[aehioyuvw]w|[aehioyuvw]wq)\b/g);
  if (!looksLikeCode && candidateMatches && candidateMatches.length > 0) {
    const greekMistypeWords = candidateMatches.filter((w) => !isPreservedEnglishWord(w) && !isCodeOrIdentifier(w));
    if (greekMistypeWords.length > 0) {
      const converted = convertQwertyToGreek(input);
      return {
        hasMismatch: true,
        direction: "toGreek",
        convertedText: converted,
        confidence: 0.90,
        reason: `Detected Greek syllable ending (final sigma 'w' or question mark 'q') in Latin text: ${greekMistypeWords.join(", ")}`
      };
    }
  }

  const hasGreek = /[\u0370-\u03FF]/.test(trimmed);
  const hasLatin = /[a-zA-Z]/.test(trimmed);

  // 4. Mixed text check: sentence already contains Greek, and newly typed Latin words are Greek QWERTY mistypes
  // E.g. "οκ βλεπω να δουλευει τωρα νομιζω οτι ειναι σωστα - -- enhmervste thn mnhmh"
  // E.g. "αυτο ειναι spiti και fotografia"
  // Excludes valid English words (e.g. "mcp", "control", "server") and code identifiers.
  if (hasGreek && hasLatin && !looksLikeCode) {
    const latinTokens = trimmed.split(/[\s,.;:!?()[\]{}"'`<>]+/u).filter((t) => /[a-zA-Z]/.test(t));
    const nonEnglishLatinTokens = latinTokens.filter((t) => !isPreservedEnglishWord(t) && !isCodeOrIdentifier(t));
    if (nonEnglishLatinTokens.length > 0) {
      const converted = convertQwertyToGreek(input);
      if (converted !== input) {
        return {
          hasMismatch: true,
          direction: "toGreek",
          convertedText: converted,
          confidence: 0.98,
          reason: `Detected Greek words typed with QWERTY layout in mixed text: ${nonEnglishLatinTokens.join(", ")}`
        };
      }
    }
  }

  // 5. Common Greek words & phonotactic heuristic: check if Latin words in input yield recognized Greek words
  // E.g. "pvw ua doylecei kai ti prepei na kanoyme", "ti kaneiw", "gia na doyme", "enhmervste thn mnhmh", "arxizoun ta problhmata"
  if (!hasGreek && hasLatin && !looksLikeCode) {
    const latinTokens = trimmed.split(/[\s,.;:!?()[\]{}"'`<>]+/u).filter((t) => /[a-zA-Z]/.test(t));
    if (latinTokens.length > 0) {
      const nonEnglishTokens = latinTokens.filter((t) => !isPreservedEnglishWord(t) && !isCodeOrIdentifier(t));
      // If all tokens are recognized English words or identifiers, this is intentional English
      if (nonEnglishTokens.length === 0) {
        return negative;
      }
      const convertedGreekWords = nonEnglishTokens.map((w) => convertQwertyToGreek(w).toLowerCase());
      const matchedGreek = convertedGreekWords.filter((w) => COMMON_GREEK_WORDS.has(w) && !AMBIGUOUS_WORDS.has(w));
      const hasGreekLayoutWords = nonEnglishTokens.some((t) => isRecognizedGreekLayout(t.toLowerCase()));
      const mismatchScore = scoreGreekMismatch(trimmed);

      if (matchedGreek.length >= 1 || (hasGreekLayoutWords && nonEnglishTokens.length >= 2 && mismatchScore >= 2) || mismatchScore >= 4) {
        const converted = convertQwertyToGreek(input);
        if (converted !== input) {
          return {
            hasMismatch: true,
            direction: "toGreek",
            convertedText: converted,
            confidence: 0.96,
            reason: matchedGreek.length >= 1
              ? `Detected Greek words (${matchedGreek.slice(0, 3).join(", ")}) typed with QWERTY layout.`
              : `Detected Greek phonotactics and layout morphology in Latin text.`
          };
        }
      }
    }
  }

  // 6. Reverse check: Greek text typed when English was intended
  // Check if text has Greek characters and converts to common English keywords
  // E.g. "μψπ ψοντρολ" -> "mcp control", "γιτ στατυς" -> "git status", "δοψκερ ρθν" -> "docker run"
  if (hasGreek && !hasLatin) {
    const greekWords = trimmed.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").match(/\p{L}+/gu) ?? [];
    if (greekWords.some((word) => RECOGNIZED_GREEK_LAYOUT_WORDS.has(word))) return negative;
    const converted = convertGreekToQwerty(input);
    const convertedWords = converted.toLowerCase().split(/\s+/).filter(Boolean);
    const matchedEnglish = convertedWords.filter((w) => PRESERVED_ENGLISH_WORDS.has(w) && !GREEK_QWERTY_HOMOPHONES.has(w));
    if (matchedEnglish.length > 0) {
      return {
        hasMismatch: true,
        direction: "toQwerty",
        convertedText: converted,
        confidence: 0.95,
        reason: `Detected English keywords (${matchedEnglish.slice(0, 3).join(", ")}) typed with Greek layout.`
      };
    }
  }

  return negative;
}

/**
 * Toggles keyboard layout between Greek and Latin QWERTY.
 * - If text contains mistyped Latin words, converts them to Greek monotonic.
 * - Without a confident suggestion, Latin and mixed-language prose stay intact.
 * - If text contains only Greek characters, converts them to QWERTY.
 */
export function toggleKeyboardLayout(input: string): string {
  if (!input) return "";
  if (/for\s*\(|let\s+|const\s+|import\s+|\bfunction\b|=>|[{}]/.test(input)) return input;
  const detection = detectKeyboardLayoutMismatch(input);
  if (detection.hasMismatch) {
    recordGreekLayoutDebug({
      source: "toggleKeyboardLayout",
      input,
      output: detection.convertedText,
      changed: detection.convertedText !== input,
      direction: detection.direction,
      confidence: detection.confidence,
      detectionReason: detection.reason,
      tokens: []
    });
    return detection.convertedText;
  }
  const greeklish = convertRecognizedGreeklish(input);
  if (greeklish !== null && greeklish !== input) {
    recordGreekLayoutDebug({
      source: "toggleKeyboardLayout",
      input,
      output: greeklish,
      changed: true,
      direction: "toGreek",
      confidence: 0.95,
      detectionReason: "Converted recognized Greeklish words on toggle",
      tokens: []
    });
    return greeklish;
  }
  const hasLatin = /[a-zA-Z]/.test(input);
  const hasGreek = /[\u0370-\u03FF]/.test(input);

  // If text contains Greek and NO Latin, convert Greek to QWERTY
  if (hasGreek && !hasLatin) {
    const converted = convertGreekToQwerty(input);
    recordGreekLayoutDebug({
      source: "toggleKeyboardLayout",
      input,
      output: converted,
      changed: converted !== input,
      direction: "toQwerty",
      confidence: 0.90,
      detectionReason: "Converted Greek to QWERTY layout on toggle",
      tokens: []
    });
    return converted;
  }

  // If text has Latin characters:
  // Since the user explicitly pressed Alt+G or clicked Toggle:
  // If the text is purely preserved English (e.g. "give it to me", "show window", "const x = true"), keep it intact.
  // Otherwise, convert non-code/non-preserved Latin words to Greek!
  if (hasLatin) {
    const tokens = input.match(/[\p{L}\p{N}_./\\-]+/gu) ?? [];
    const nonEnglish = tokens.filter((t) => !PRESERVED_ENGLISH_WORDS.has(t.toLowerCase()) && !isCodeOrIdentifier(t));
    if (nonEnglish.length > 0) {
      const converted = convertQwertyToGreek(input);
      if (converted !== input) {
        recordGreekLayoutDebug({
          source: "toggleKeyboardLayout",
          input,
          output: converted,
          changed: true,
          direction: "toGreek",
          confidence: 0.90,
          detectionReason: `Explicit Alt+G toggle converted Latin words to Greek: ${nonEnglish.join(", ")}`,
          tokens: []
        });
        return converted;
      }
    }
  }

  return input;
}

/**
 * Converts either the selected text range, or the entire text if no selection.
 */
export function convertTextRange(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  direction?: "toGreek" | "toQwerty" | "toggle"
): { newText: string; newStart: number; newEnd: number } {
  if (selectionStart === selectionEnd) {
    // No selection: convert entire text
    const newText = direction === "toGreek"
      ? convertQwertyToGreek(text)
      : direction === "toQwerty"
        ? convertGreekToQwerty(text)
        : toggleKeyboardLayout(text);
    return {
      newText,
      newStart: selectionStart === text.length ? newText.length : Math.min(selectionStart, newText.length),
      newEnd: selectionEnd === text.length ? newText.length : Math.min(selectionEnd, newText.length)
    };
  }

  const before = text.slice(0, selectionStart);
  const selected = text.slice(selectionStart, selectionEnd);
  const after = text.slice(selectionEnd);

  const convertedSelection = direction === "toGreek"
    ? convertQwertyToGreek(selected)
    : direction === "toQwerty"
      ? convertGreekToQwerty(selected)
      : toggleKeyboardLayout(selected);

  return {
    newText: `${before}${convertedSelection}${after}`,
    newStart: selectionStart,
    newEnd: selectionStart + convertedSelection.length
  };
}

export interface GreekInputState {
  enabled: boolean;
  deadKey: "tonos" | "dialytika" | null;
}

export function createGreekInputState(enabled = false): GreekInputState {
  return { enabled, deadKey: null };
}

/**
 * Handles live typing in Greek keyboard layout mode for an input/textarea.
 * Intercepts physical QWERTY keystrokes and produces corresponding Greek characters,
 * with full dead-key support for tonos (';') and dialytika (':').
 * Returns true if the key was intercepted and handled (preventing default event).
 */
export function handleGreekKeyInput(
  event: {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    preventDefault?: () => void;
  },
  state: GreekInputState,
  onInsert: (char: string) => void
): boolean {
  if (!state.enabled) return false;
  // Ignore modifier combinations (Ctrl, Alt, Meta) so shortcuts work normally
  if (event.ctrlKey || event.altKey || event.metaKey) return false;

  const key = event.key;
  if (!key) return false;

  // Handle special non-character keys
  if (key.length > 1) {
    if (key === "Backspace" && state.deadKey !== null) {
      state.deadKey = null;
      if (typeof event.preventDefault === "function") event.preventDefault();
      return true;
    }
    state.deadKey = null;
    return false;
  }

  // If the key is already Greek (user typed using native Greek layout), pass through
  if (/[\u0370-\u03FF]/.test(key)) {
    state.deadKey = null;
    return false;
  }

  // Tonos dead key: ';' on QWERTY
  if (key === ";") {
    if (state.deadKey === "tonos") {
      // Pressed ';' twice: output ';'
      state.deadKey = null;
      if (typeof event.preventDefault === "function") event.preventDefault();
      onInsert(";");
      return true;
    }
    state.deadKey = "tonos";
    if (typeof event.preventDefault === "function") event.preventDefault();
    return true;
  }

  // Dialytika dead key: ':' (Shift + ;) on QWERTY
  if (key === ":") {
    if (state.deadKey === "dialytika") {
      // Pressed ':' twice: output ':'
      state.deadKey = null;
      if (typeof event.preventDefault === "function") event.preventDefault();
      onInsert(":");
      return true;
    }
    state.deadKey = "dialytika";
    if (typeof event.preventDefault === "function") event.preventDefault();
    return true;
  }

  // Handle pending dead key with the current letter
  if (state.deadKey === "tonos") {
    state.deadKey = null;
    const accented = GREEK_TONOS_MAP[key];
    if (accented) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      onInsert(accented);
      return true;
    }
    // If space pressed after tonos
    if (key === " ") {
      if (typeof event.preventDefault === "function") event.preventDefault();
      onInsert("´ ");
      return true;
    }
    // Consonant typed after tonos: output tonos mark + converted character
    const mapped = QWERTY_TO_GREEK_CHAR_MAP[key] ?? key;
    if (typeof event.preventDefault === "function") event.preventDefault();
    onInsert("´" + mapped);
    return true;
  }

  if (state.deadKey === "dialytika") {
    state.deadKey = null;
    const dialytikaChar = GREEK_DIALYTIKA_MAP[key];
    if (dialytikaChar) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      onInsert(dialytikaChar);
      return true;
    }
    if (key === " ") {
      if (typeof event.preventDefault === "function") event.preventDefault();
      onInsert("¨ ");
      return true;
    }
    const mapped = QWERTY_TO_GREEK_CHAR_MAP[key] ?? key;
    if (typeof event.preventDefault === "function") event.preventDefault();
    onInsert("¨" + mapped);
    return true;
  }

  // Normal character mapping
  const mapped = QWERTY_TO_GREEK_CHAR_MAP[key];
  if (mapped !== undefined) {
    if (typeof event.preventDefault === "function") event.preventDefault();
    onInsert(mapped);
    return true;
  }

  return false;
}

/**
 * Inserts text at the current cursor position in a textarea,
 * preserving undo/redo history where supported.
 */
export function insertTextAtCursor(textarea: HTMLTextAreaElement, text: string): void {
  let success = false;
  try {
    success = Boolean(typeof document !== "undefined" && typeof document.execCommand === "function" && document.execCommand("insertText", false, text));
  } catch {}
  if (!success) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const oldVal = textarea.value;
    textarea.value = oldVal.slice(0, start) + text + oldVal.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/**
 * Intercepts keydown events when English typing mode is active,
 * converting physical Greek layout keys into Latin/QWERTY characters.
 * This ensures that even if the OS keyboard remains in Greek, typing produces English.
 */
export function handleEnglishKeyInput(
  event: {
    key: string;
    code?: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    preventDefault?: () => void;
  },
  onInsert: (char: string) => void
): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey) return false;

  const key = event.key;
  if (!key) return false;

  // Let special navigation/editing keys pass through
  if (key.length > 1) {
    if (key === "Dead" || key.startsWith("Dead")) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      // On Greek layout, 'q' is the dead key: produce 'q' (or 'Q' if shift)
      onInsert(event.shiftKey ? "Q" : "q");
      return true;
    }
    return false;
  }

  // If the key is already standard ASCII Latin (letters, digits, basic punctuation)
  if (/^[a-zA-Z0-9]$/.test(key)) {
    return false; // Native ASCII passes through cleanly
  }

  // Check event.code first: event.code indicates the physical key on QWERTY layout
  if (event.code && /^Key[A-Z]$/.test(event.code)) {
    const letter = event.code.slice(3);
    const char = event.shiftKey ? letter.toUpperCase() : letter.toLowerCase();
    if (typeof event.preventDefault === "function") event.preventDefault();
    onInsert(char);
    return true;
  }

  // If event.code is not Key*, check if event.key is a Greek character or Greek punctuation
  if (/[\u0370-\u03FF]/.test(key) || key === ";" || key === "·") {
    if (key === ";") {
      if (typeof event.preventDefault === "function") event.preventDefault();
      onInsert(";");
      return true;
    }
    if (key === "·") {
      if (typeof event.preventDefault === "function") event.preventDefault();
      onInsert(":");
      return true;
    }

    // Special physical key mapping when event.code is absent
    if (key === "ς") {
      if (typeof event.preventDefault === "function") event.preventDefault();
      onInsert(event.shiftKey ? "W" : "w");
      return true;
    }

    const mapped = GREEK_TO_QWERTY_CHAR_MAP[key];
    if (mapped !== undefined) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      onInsert(event.shiftKey ? mapped.toUpperCase() : mapped.toLowerCase());
      return true;
    }
  }

  return false;
}

