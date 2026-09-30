export const OSK_AUTOCOMPLETE_STORAGE_KEY = "space.osk.autocomplete";

export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const COMMON_ENGLISH_WORDS: readonly string[] = [
  "action", "active", "after", "agent", "alias", "allow", "always", "api", "apply", "approve",
  "archive", "array", "async", "attach", "audio", "auto", "autocorrect", "backup", "bash", "before",
  "begin", "benchmark", "branch", "break", "browser", "buffer", "build", "button", "cache", "cancel",
  "change", "chat", "check", "checkout", "chip", "clean", "clear", "cli", "client", "clipboard",
  "clone", "close", "code", "codex", "color", "command", "commit", "complete", "config", "connect",
  "console", "const", "context", "continue", "control", "copy", "create", "cursor", "custom", "daemon",
  "data", "database", "debug", "default", "delete", "demo", "deploy", "describe", "detach", "dev",
  "device", "diff", "directory", "disable", "dispatch", "display", "docker", "document", "down", "draft",
  "drag", "echo", "edit", "editor", "element", "email", "enable", "enter", "entry", "env",
  "environment", "error", "escape", "event", "exec", "exit", "export", "false", "feature", "fetch",
  "file", "filter", "find", "fixed", "focus", "folder", "follow", "format", "function", "gateway",
  "gemini", "generate", "gesture", "git", "global", "handle", "header", "health", "help", "history",
  "home", "host", "icon", "idle", "image", "import", "index", "init", "input", "insert",
  "inspect", "install", "interface", "issue", "json", "keep", "key", "keyboard", "kill", "label",
  "lang", "language", "layout", "left", "list", "live", "load", "local", "lock", "log",
  "login", "main", "manage", "media", "memory", "menu", "message", "method", "mobile", "mode",
  "model", "modify", "module", "move", "name", "native", "network", "next", "node", "note",
  "npm", "null", "number", "object", "open", "operator", "option", "order", "origin", "output",
  "package", "pane", "panel", "parent", "parse", "pass", "patch", "path", "pause", "pending",
  "permission", "plan", "play", "plugin", "point", "popover", "port", "portal", "position", "prefix", "preview",
  "process", "production", "progress", "project", "prompt", "provider", "proxy", "pull", "push", "query",
  "queue", "quick", "radio", "range", "read", "ready", "reboot", "rebuild", "recent", "record",
  "refactor", "refresh", "release", "reload", "remote", "remove", "rename", "repair", "replace", "report",
  "repository", "request", "reset", "resize", "resolve", "restart", "restore", "resume", "retry", "return",
  "right", "role", "root", "route", "router", "rule", "run", "running", "runtime", "save",
  "scale", "scan", "schedule", "schema", "screen", "screenshot", "script", "scroll", "search", "second",
  "select", "send", "server", "service", "session", "set", "settings", "setup", "shell", "shift",
  "shortcut", "show", "sidebar", "size", "skill", "snapshot", "socket", "sound", "source", "space",
  "spaceapp", "span", "start", "state", "status", "stop", "storage", "store", "stream", "strict",
  "string", "style", "subagent", "submit", "sync", "system", "tab", "target", "task", "term",
  "terminal", "test", "text", "theme", "time", "timeout", "timer", "title", "toggle", "token",
  "toolbar", "tools", "top", "touch", "trace", "true", "type", "ui", "undo", "unit",
  "unknown", "update", "upgrade", "upload", "usage", "user", "value", "variable", "vendor", "version",
  "video", "view", "viewport", "virtual", "visible", "voice", "wait", "warning", "watch", "web",
  "wheel", "window", "word", "workspace", "worktree", "write", "zap"
];

const COMMON_GREEK_WORDS: readonly string[] = [
  "ακύρωση", "αλλαγή", "ανοικτό", "άνοιγμα", "ανανέωση", "ανάκτηση", "αντιγραφή", "αποθήκευση", "αποστολή", "αποτέλεσμα",
  "αρχείο", "αυτό", "αυτόματο", "βάση", "βοήθεια", "βρες", "για", "γράψε", "γραφή", "δεδομένα",
  "δημιουργία", "διαγραφή", "διακοπή", "διαμόρφωση", "διεργασία", "δοκιμή", "εγκατάσταση", "εισαγωγή", "είναι", "εκτέλεση",
  "έλεγχος", "ελληνικά", "εμφάνιση", "ενεργοποίηση", "ενέργεια", "εντολή", "εντάξει", "εξαγωγή", "έξοδος", "επαναφορά",
  "επιλογή", "επιτυχία", "επιστροφή", "επόμενο", "εργασία", "εργαλεία", "εφαρμογή", "έχω", "ζωντανό", "θέλω",
  "θέμα", "θετικό", "ιδιότητες", "ιστορικό", "κάθε", "κάνε", "καθαρισμός", "κατάσταση", "κείμενο", "κλείσιμο", "κλειδί",
  "κωδικός", "λειτουργία", "λέξη", "λίστα", "μήνυμα", "μοντέλο", "μνήμη", "νέο", "όλα", "ολοκλήρωση",
  "οθόνη", "ομάδα", "όνομα", "ορισμός", "παράθυρο", "παράμετροι", "παρακαλώ", "περιβάλλον", "πληροφορίες", "πληκτρολόγιο",
  "προβολή", "προεπισκόπηση", "προεπιλογή", "πρόγραμμα", "πρόοδος", "προσθήκη", "πρότυπο", "πρόχειρο", "πρώτο", "ρυθμίσεις",
  "σφάλμα", "σταμάτημα", "στοιχείο", "σύστημα", "σύνδεση", "συνέχεια", "συνεργασία", "συνομιλία", "συντομεύσεις", "σύνθεση",
  "σχέδιο", "τελικό", "τερματικό", "τέλος", "τοπικό", "τώρα", "υπηρεσία", "υποστήριξη", "φόρτωση", "φωνή",
  "φάκελος", "χαρακτήρας", "χρήστης", "χρήση", "χρόνος", "ώρα"
];

const DEFAULT_EN_SUGGESTIONS = ["status", "continue", "help"];
const DEFAULT_EL_SUGGESTIONS = ["συνέχεια", "κατάσταση", "βοήθεια"];

export function getAutocompleteSuggestions(
  prefix: string,
  lang: "en" | "el",
  max = 3
): string[] {
  const trimmed = prefix.trim();
  if (!trimmed) {
    return lang === "el" ? DEFAULT_EL_SUGGESTIONS.slice(0, max) : DEFAULT_EN_SUGGESTIONS.slice(0, max);
  }

  const normalizedPrefix = normalizeWord(trimmed);
  const wordBank = lang === "el" ? COMMON_GREEK_WORDS : COMMON_ENGLISH_WORDS;

  // Filter words that start with the normalized prefix
  const matched: string[] = [];
  for (const word of wordBank) {
    const normalizedWord = normalizeWord(word);
    if (normalizedWord.startsWith(normalizedPrefix)) {
      matched.push(word);
    }
  }

  // Sort: closest length first, then alphabetical
  matched.sort((a, b) => a.length - b.length || a.localeCompare(b));

  return matched.slice(0, max);
}
