/**
 * Language-aware stack-trace detection and runtime-frame collapse. TypeScript port of Headroom
 * `crates/headroom-core/src/transforms/log_compressor.rs` (Apache-2.0, Headroom Contributors).
 *
 * Each flavor has its own opener and termination rule, so Python chained exceptions keep their blank separators,
 * Java `Caused by:` chains and .NET inner exceptions stay one trace, and Go goroutine dumps and Rust backtraces
 * are recognised.
 */
import type { LogLevel } from "./classify.js";
import { isAsciiDigit, leadingDigits, startsIndented, trim, trimStart } from "./rust-text.js";

export type TraceFlavor = "python" | "js" | "java" | "rust_error" | "rust_backtrace" | "go_panic" | "dotnet";

/** One classified log line. Identity is `lineNumber`: two entries with the same number are the same line. */
export interface LogLine {
  lineNumber: number;
  content: string;
  level: LogLevel;
  isStackTrace: boolean;
  isSummary: boolean;
  /** f32 in upstream; kept f32-rounded (`Math.fround`) so ties and ordering match. */
  score: number;
}

/** The flavor `line` opens, or null when it does not start a trace. */
export function traceFlavorFor(line: string): TraceFlavor | null {
  const trimmed = trimStart(line);
  if (trimmed.startsWith("Traceback (most recent call last)") || isPythonFileFrame(trimmed)) return "python";
  // Before JS/Java: a .NET `at Ns.Class.Method(...) in File.cs:line N` frame also has the Java shape.
  if (isDotnetOpener(trimmed)) return "dotnet";
  if (isJsAtFrame(trimmed)) return "js";
  if (isJavaAtFrame(trimmed)) return "java";
  if (trimmed.startsWith("--> ") && hasLineColSuffix(trimmed)) return "rust_error";
  if (isRustPanicOpener(trimmed) || trimmed.startsWith("stack backtrace:") || isRustBacktraceFrame(line)) return "rust_backtrace";
  if (isGoPanicOpener(line)) return "go_panic";
  return null;
}

/** `File "<name>", line <N>` */
const isPythonFileFrame = (text: string): boolean =>
  text.startsWith('File "') && text.includes('", line ') && isAsciiDigit(text[text.length - 1]);

/** `at <name>(<file>:<line>:<col>)` */
const isJsAtFrame = (text: string): boolean =>
  text.startsWith("at ") && text.includes("(") && text.includes(")") && hasLineColSuffix(text);

/** `at <package.Class.method>(`; `/` admits JPMS module prefixes and lambda frames. */
function isJavaAtFrame(text: string): boolean {
  if (!text.startsWith("at ") || !text.includes("(")) return false;
  return /^[A-Za-z0-9._$\/]+$/.test(text.slice(3, text.indexOf("(")));
}

/** `:<digits>:<digit>` anywhere (line:col). */
const hasLineColSuffix = (text: string): boolean => /:[0-9]+:[0-9]/.test(text);

/** `thread '<name>' panicked at <loc>` */
const isRustPanicOpener = (text: string): boolean => text.startsWith("thread '") && text.includes("panicked at");

/** Column-0 `panic: ` / `fatal error: `, or a goroutine header. */
const isGoPanicOpener = (line: string): boolean =>
  line.startsWith("panic: ") || line.startsWith("fatal error: ") || isGoroutineHeader(line);

/** `goroutine <N> [<state>]:` */
function isGoroutineHeader(line: string): boolean {
  if (!line.startsWith("goroutine ")) return false;
  const rest = line.slice("goroutine ".length);
  const digits = leadingDigits(rest);
  return digits > 0 && rest.startsWith(" [", digits);
}

/** Tab-indented `<path>.go:<line> +0x<hex>`. */
const isGoFileFrame = (line: string): boolean => line.startsWith("\t") && line.includes(".go:", 1) && line.includes(" +0x", 1);

/** Column-0 `pkg.func(...)` call line or `created by pkg.func`. */
function isGoCallFrame(line: string): boolean {
  if (line.startsWith("created by ")) return true;
  if (startsIndented(line) || !line.endsWith(")")) return false;
  const open = line.indexOf("(");
  if (open < 0) return false;
  const symbol = line.slice(0, open);
  return symbol.includes(".") && /^[A-Za-z0-9._\/*]+$/.test(symbol);
}

const isDotnetOpener = (text: string): boolean => text.startsWith("Unhandled exception.") || isDotnetFrame(text);

/** `at <symbol>(<args>) in <file>:line <N>`; the ` in ... :line` suffix tells .NET apart from Java. */
const isDotnetFrame = (text: string): boolean => text.startsWith("at ") && text.includes(") in ") && text.includes(":line ");

/** `<digits>:<spaces>0x<hex>` */
const isRustBacktraceFrame = (line: string): boolean => /^[0-9]+: *0x[0-9a-fA-F]/.test(trimStart(line));

/** `System.InvalidOperationException: message` */
function isDotnetExceptionHead(trimmed: string): boolean {
  const colon = trimmed.indexOf(":");
  if (colon < 0) return false;
  const head = trimmed.slice(0, colon);
  return head.endsWith("Exception") && head.includes(".") && /^[A-Za-z0-9._`+]*$/.test(head);
}

/** `... 17 more` */
function isJavaMoreSummary(trimmed: string): boolean {
  if (!trimmed.startsWith("... ")) return false;
  const rest = trimmed.slice(4);
  const digits = leadingDigits(rest);
  return digits > 0 && trim(rest.slice(digits)) === "more";
}

const startsUppercase = (text: string): boolean => /^\p{Uppercase}/u.test(text);

/**
 * True when `line` ends the active trace. `linesSoFar` is how many lines the trace already holds (1 = only the
 * opener); Rust backtraces use it to keep the free-text panic message after `panicked at <loc>:`.
 */
export function traceTerminates(flavor: TraceFlavor, line: string, linesSoFar: number): boolean {
  const trimmed = trimStart(line);
  switch (flavor) {
    case "python": {
      // Blank lines and chain markers stay inside; an unindented `ExceptionType: message` line is kept too.
      const continues = startsIndented(line) || line === "" || trimmed.startsWith("Traceback") || trimmed.startsWith("File ")
        || trimmed.startsWith("During handling") || trimmed.startsWith("The above exception");
      return !continues && !startsUppercase(trimmed);
    }
    case "js":
      return !trimmed.startsWith("at ") && line !== "";
    case "java": {
      const chain = trimmed.startsWith("Caused by:") || trimmed.startsWith("Suppressed:") || isJavaMoreSummary(trimmed);
      return !trimmed.startsWith("at ") && !chain && line !== "";
    }
    case "dotnet":
      if (line === "") return false;
      return !(trimmed.startsWith("at ") || trimmed.startsWith("--->") || trimmed.startsWith("--- End of") || isDotnetExceptionHead(trimmed));
    case "rust_error":
      return !trimmed.startsWith("--> ") && line !== "";
    case "rust_backtrace": {
      if (line === "" || linesSoFar === 1) return false;
      const frame = isAsciiDigit(trimmed[0]);
      const continuation = startsIndented(line) || trimmed.startsWith("stack backtrace:") || trimmed.startsWith("note: run with");
      return !frame && !continuation;
    }
    case "go_panic": {
      if (line === "") return false;
      const continues = line.startsWith("\t") || isGoroutineHeader(line) || isGoCallFrame(line) || line.startsWith("panic: ")
        || line.startsWith("fatal error: ") || line.startsWith("[signal ");
      return !continues;
    }
  }
}

// ─── Frame collapse ────────────────────────────────────────────────────

/** A stack frame, as opposed to an exception message or chain head. */
function isFrameLine(line: string): boolean {
  const trimmed = trimStart(line);
  return trimmed.startsWith("at ") || (trimmed.startsWith('File "') && trimmed.includes('", line '))
    || isRustBacktraceFrame(line) || isGoFileFrame(line) || isGoCallFrame(line);
}

/** Chain heads and inter-trace markers that always survive a collapse. */
function isChainHeadLine(line: string): boolean {
  const trimmed = trimStart(line);
  return ["Caused by:", "Suppressed:", "... ", "--->", "--- End of", "During handling", "The above exception"]
    .some((prefix) => trimmed.startsWith(prefix));
}

const runtimeFramePrefixes = ["at java.", "at jdk.", "at sun.", "at javax.", "at scala.", "at System.", "at Microsoft.", "runtime.", "created by runtime."];
const runtimeFrameMarkers = [
  "site-packages/", "/usr/lib/python", "lib/python3.", "node:internal/", "node_modules/", "(internal/", "core::", "std::",
  "alloc::", "rust_begin_unwind", "__rust_", "/rustc/", "/usr/local/go/src/", "/libexec/src/runtime/"
];

function isRuntimeFrame(line: string): boolean {
  const trimmed = trimStart(line);
  return runtimeFramePrefixes.some((prefix) => trimmed.startsWith(prefix)) || runtimeFrameMarkers.some((marker) => line.includes(marker));
}

export interface CollapsedTrace {
  kept: LogLine[];
  /** Line numbers of dropped frames, kept out of the context pass so they do not ride back in. */
  droppedIndices: number[];
}

/** Collapse markers outrank plain lines in the score-ranked global cap (f32 0.8). */
const markerScore = Math.fround(0.8);

/**
 * Keep every message/chain-head line, the first `headFrames` frames and up to `appFrames` app-code frames; each
 * contiguous dropped run becomes one `[... N frames collapsed]` marker in the run's first line slot. Indented
 * continuations of a dropped frame (Python source echo) drop with it.
 */
export function collapseTraceFrames(stack: readonly LogLine[], headFrames: number, appFrames: number): CollapsedTrace {
  const kept: LogLine[] = [];
  const droppedIndices: number[] = [];
  let framesSeen = 0;
  let appKept = 0;
  let runStart: number | null = null;
  let runLength = 0;
  let previousDropped = false;

  const flushRun = () => {
    if (runStart === null) return;
    kept.push({ lineNumber: runStart, content: `      [... ${runLength} frames collapsed]`, level: "unknown", isStackTrace: true, isSummary: false, score: markerScore });
    runStart = null;
    runLength = 0;
  };

  for (const line of stack) {
    if (isFrameLine(line.content) && !isChainHeadLine(line.content)) {
      framesSeen += 1;
      const runtime = isRuntimeFrame(line.content);
      if (framesSeen <= headFrames || (!runtime && appKept < appFrames)) {
        if (!runtime) appKept += 1;
        flushRun();
        kept.push(line);
        previousDropped = false;
      } else {
        runStart ??= line.lineNumber;
        runLength += 1;
        droppedIndices.push(line.lineNumber);
        previousDropped = true;
      }
    } else if (previousDropped && startsIndented(line.content) && !isChainHeadLine(line.content)) {
      runLength += 1;
      droppedIndices.push(line.lineNumber);
    } else {
      flushRun();
      kept.push(line);
      previousDropped = false;
    }
  }
  flushRun();
  return { kept, droppedIndices };
}
