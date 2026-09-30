import { createWriteStream, readFileSync } from "node:fs";

export class PromptController {
  constructor({
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    logFile = null,
    nonInteractive = false,
    answersFile = null,
    answers = null,
    planMode = false,
    jsonMode = false
  } = {}) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.stderr = stderr;
    this.nonInteractive = nonInteractive;
    this.planMode = planMode;
    this.jsonMode = jsonMode;
    this.logStream = logFile ? createWriteStream(logFile, { flags: "a" }) : null;
    this.answers = answers ? { ...answers } : {};
    this._sawCr = false;

    if (answersFile) {
      try {
        const content = answersFile.trim().startsWith("{") ? answersFile : readFileSync(answersFile, "utf8");
        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Answers must be a JSON object");
        this.answers = { ...this.answers, ...parsed };
      } catch (err) {
        throw new Error(`Failed to parse answers file ${answersFile}: ${err.message}`);
      }
    }

    if (!stdin._spaceappBuffer) {
      stdin._spaceappBuffer = "";
    }
  }

  log(message, { secret = false } = {}) {
    if (this.logStream && !secret) {
      this.logStream.write(`[${new Date().toISOString()}] ${message}\n`);
    }
  }

  write(text, { secret = false } = {}) {
    if (!this.jsonMode) {
      this.stdout.write(text);
    }
    this.log(text.replace(/\r?\n$/, ""), { secret });
  }

  writeError(text) {
    this.stderr.write(text);
    this.log(`ERROR: ${text.replace(/\r?\n$/, "")}`);
  }

  isInteractive() {
    return Boolean(this.stdin?.isTTY && typeof this.stdin?.setRawMode === "function");
  }

  async readLine(promptText, { mask = false, answerKey = null, defaultValue = "" } = {}) {
    if (answerKey && this.answers[answerKey] !== undefined) {
      const val = String(this.answers[answerKey]);
      this.write(`${promptText}${mask ? "******" : val}\n`, { secret: mask });
      return val;
    }

    if (this.nonInteractive) {
      if (defaultValue !== undefined && defaultValue !== "") {
        this.write(`${promptText}${defaultValue} (non-interactive default)\n`);
        return defaultValue;
      }
      throw new Error(`Non-interactive execution refused prompt without answer: ${promptText.trim()}`);
    }

    this.write(promptText, { secret: false });

    // Handle split CRLF from previous read: if previous ended with \r, strip leading \n
    let buf = this.stdin._spaceappBuffer || "";
    if (this._sawCr && buf.length > 0) {
      if (buf.startsWith("\n")) {
        buf = buf.slice(1);
        this.stdin._spaceappBuffer = buf;
      }
      this._sawCr = false;
    }

    // 1. Check if unconsumed characters in buffer already contain a newline
    const nlIdx = buf.search(/\r\n|\n|\r/);
    if (nlIdx !== -1) {
      const line = buf.slice(0, nlIdx);
      if (buf[nlIdx] === "\r") {
        if (buf.length > nlIdx + 1 && buf[nlIdx + 1] === "\n") {
          this.stdin._spaceappBuffer = buf.slice(nlIdx + 2);
        } else {
          this.stdin._spaceappBuffer = buf.slice(nlIdx + 1);
          this._sawCr = true;
        }
      } else {
        this.stdin._spaceappBuffer = buf.slice(nlIdx + 1);
      }
      if (!mask) {
        this.write(`${line}\n`);
      } else {
        this.write("\n", { secret: true });
      }
      return line;
    }

    // 2. Non-TTY / Piped stream (where setRawMode or isTTY is missing)
    if (!this.stdin.isTTY || typeof this.stdin.setRawMode !== "function") {
      return await new Promise((resolve, reject) => {
        let current = this.stdin._spaceappBuffer || "";
        this.stdin._spaceappBuffer = "";

        const finish = (result) => {
          cleanup();
          this.write("\n", { secret: mask });
          resolve(result);
        };

        const processBuffer = () => {
          if (this._sawCr && current.length > 0) {
            if (current.startsWith("\n")) {
              current = current.slice(1);
            }
            this._sawCr = false;
          }
          const m = current.search(/\r\n|\n|\r/);
          if (m !== -1) {
            const res = current.slice(0, m);
            if (current[m] === "\r") {
              if (current.length > m + 1 && current[m + 1] === "\n") {
                this.stdin._spaceappBuffer = current.slice(m + 2);
              } else {
                this.stdin._spaceappBuffer = current.slice(m + 1);
                this._sawCr = true;
              }
            } else {
              this.stdin._spaceappBuffer = current.slice(m + 1);
            }
            finish(res);
            return true;
          }
          return false;
        };

        const onReadable = () => {
          let chunk;
          while ((chunk = this.stdin.read()) !== null) {
            current += String(chunk);
            if (processBuffer()) {
              return;
            }
          }
        };

        const onEnd = () => finish(current);
        const onClose = () => finish(current);
        const onError = (err) => {
          cleanup();
          reject(err);
        };

        const cleanup = () => {
          if (typeof this.stdin.off === "function") {
            this.stdin.off("readable", onReadable);
            this.stdin.off("end", onEnd);
            this.stdin.off("close", onClose);
            this.stdin.off("error", onError);
          }
        };

        if (typeof this.stdin.read === "function" && typeof this.stdin.on === "function") {
          this.stdin.on("readable", onReadable);
          this.stdin.once("end", onEnd);
          this.stdin.once("close", onClose);
          this.stdin.once("error", onError);
          onReadable();
        } else if (typeof this.stdin[Symbol.asyncIterator] === "function") {
          (async () => {
            try {
              const iterator = this.stdin[Symbol.asyncIterator]();
              for (;;) {
                const step = await iterator.next();
                if (step.done) {
                  finish(current);
                  return;
                }
                current += String(step.value);
                if (processBuffer()) {
                  return;
                }
              }
            } catch {
              finish(current);
            }
          })();
        } else {
          finish(current);
        }
      });
    }

    // 3. Interactive TTY stream (Real TTY or test mock implementing isTTY + setRawMode)
    if (typeof this.stdin.setRawMode === "function") {
      this.stdin.setRawMode(true);
    }
    if (typeof this.stdin.resume === "function") {
      this.stdin.resume();
    }
    if (typeof this.stdin.setEncoding === "function") {
      this.stdin.setEncoding("utf8");
    }
    let value = "";
    try {
      const iterator = this.stdin[Symbol.asyncIterator]();
      for (;;) {
        const step = await iterator.next();
        if (step.done) break;
        const chars = Array.from(String(step.value));
        for (let i = 0; i < chars.length; i++) {
          const character = chars[i];
          if (this._sawCr && character === "\n") {
            this._sawCr = false;
            continue;
          }
          this._sawCr = false;
          if (character === "\u0003") {
            throw new Error("Input cancelled.");
          }
          if (character === "\r" || character === "\n") {
            if (character === "\r") {
              this._sawCr = true;
            }
            if (i + 1 < chars.length) {
              let rest = chars.slice(i + 1).join("");
              if (character === "\r" && rest.startsWith("\n")) {
                rest = rest.slice(1);
                this._sawCr = false;
              }
              this.stdin._spaceappBuffer = (this.stdin._spaceappBuffer || "") + rest;
            }
            this.write("\n", { secret: mask });
            return value;
          }
          if (character === "\u007f" || character === "\u0008") {
            if (value.length > 0) {
              value = value.slice(0, -1);
              this.stdout.write("\b \b");
            }
            continue;
          }
          value += character;
          if (mask) {
            this.stdout.write("*");
          } else {
            this.stdout.write(character);
          }
        }
      }
      this.write("\n", { secret: mask });
      return value;
    } finally {
      if (typeof this.stdin.setRawMode === "function") {
        this.stdin.setRawMode(false);
      }
      if (typeof this.stdin.pause === "function") {
        this.stdin.pause();
      }
    }
  }

  async promptYesNo(question, { defaultYes = false, answerKey = null } = {}) {
    for (;;) {
      const raw = await this.readLine(
        `${question} [${defaultYes ? "Y/n" : "y/N"}] `,
        { mask: false, answerKey, defaultValue: defaultYes ? "y" : "n" }
      );
      const answer = raw.trim().toLowerCase();
      if (answer === "") {
        return defaultYes;
      }
      if (answer === "y" || answer === "yes" || answer === "true" || answer === "1") {
        return true;
      }
      if (answer === "n" || answer === "no" || answer === "false" || answer === "0") {
        return false;
      }
      this.write("Please answer y or n.\n");
    }
  }

  async promptChoice(question, options, { defaultIndex = 0, answerKey = null } = {}) {
    this.write(`${question}\n`);
    options.forEach((option, index) => {
      this.write(`  [${index + 1}] ${option.label}\n`);
    });
    for (;;) {
      const raw = await this.readLine(
        `Select 1-${options.length} [${defaultIndex + 1}]: `,
        { mask: false, answerKey, defaultValue: String(defaultIndex + 1) }
      );
      const answer = raw.trim();
      if (answer === "") {
        return options[defaultIndex].value;
      }
      const matched = options.find(
        (o) =>
          String(o.value).toLowerCase() === answer.toLowerCase() ||
          o.label.toLowerCase() === answer.toLowerCase()
      );
      if (matched) {
        return matched.value;
      }
      const index = Number.parseInt(answer, 10);
      if (Number.isInteger(index) && index >= 1 && index <= options.length) {
        return options[index - 1].value;
      }
      this.write(`Invalid choice. Enter a number between 1 and ${options.length}.\n`);
    }
  }

  async finalConfirmation(lines, { answerKey = "approvePlan" } = {}) {
    this.write("SpaceApp setup plan:\n");
    for (const line of lines) {
      this.write(`  - ${line}\n`);
    }
    const approved = await this.promptYesNo("Apply this plan?", { defaultYes: false, answerKey });
    if (!approved) {
      this.write("Cancelled. No changes were made.\n");
    }
    return approved;
  }

  async close() {
    if (this.logStream) {
      await new Promise((resolve) => this.logStream.end(resolve));
      this.logStream = null;
    }
  }
}
