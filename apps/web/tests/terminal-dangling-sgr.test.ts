import { describe, expect, it } from "vitest";
import {
  createDanglingSgrRepairParser,
  repairDanglingSgrSequences
} from "../src/features/terminal-pane/terminal-output-coordinator.js";

describe("dangling SGR repair", () => {
  it("repairs a missing introducer at a layered background transition", () => {
    expect(
      repairDanglingSgrSequences("\x1b[48;2;10;10;10m48;2;20;20;20m\x1b[0m")
    ).toBe("\x1b[48;2;10;10;10m\x1b[48;2;20;20;20m\x1b[0m");
  });

  it("repairs foreground layering too", () => {
    expect(
      repairDanglingSgrSequences("\x1b[38;2;127;216;143m38;2;238;238;238m")
    ).toBe("\x1b[38;2;127;216;143m\x1b[38;2;238;238;238m");
  });

  it("leaves valid combined SGR runs untouched", () => {
    const valid = "\x1b[38;2;1;2;3;48;2;4;5;6mtext\x1b[0m";
    expect(repairDanglingSgrSequences(valid)).toBe(valid);
  });

  it("leaves ordinary SGR colors untouched", () => {
    const colors = "\x1b[48;2;20;20;20mbackground\x1b[0m";
    expect(repairDanglingSgrSequences(colors)).toBe(colors);
  });

  it("leaves prose mentioning SGR params untouched", () => {
    const prose = " ANSI 48;2;20;20;20m ";
    expect(repairDanglingSgrSequences(prose)).toBe(prose);
    expect(repairDanglingSgrSequences("form48;2;20;20;20m")).toBe("form48;2;20;20;20m");
  });

  it("leaves out-of-range params untouched", () => {
    const bogus = "\x1b[48;2;10;10;10m48;2;999;20;20m";
    expect(repairDanglingSgrSequences(bogus)).toBe(bogus);
  });

  it("repairs a missing introducer before a cursor move after colors", () => {
    expect(
      repairDanglingSgrSequences("\x1b[48;2;10;10;10m10;1H\x1b[0m")
    ).toBe("\x1b[48;2;10;10;10m\x1b[10;1H\x1b[0m");
  });

  it("leaves prose with CUP-like text after a reset untouched", () => {
    // No complete SGR directly before the params: not a dangling run.
    expect(repairDanglingSgrSequences("see 10;1H for details")).toBe("see 10;1H for details");
    expect(repairDanglingSgrSequences("\x1b[0m\n10;1H")).toBe("\x1b[0m\n10;1H");
  });

  it("reassembles a split cursor move across pushes", () => {
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("\x1b[48;2;10;10;10m10;1")).toBe("");
    expect(parser.push("H\x1b[0m")).toBe("\x1b[48;2;10;10;10m\x1b[10;1H\x1b[0m");
    expect(parser.flush()).toBe("");
  });

  it("does not hold back a complete SGR at the tail", () => {
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("text\x1b[0m")).toBe("text\x1b[0m");
    expect(parser.flush()).toBe("");
  });
  it("reassembles a corruption split across pushes", () => {
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("\x1b[48;2;10;10;10m48;2;20")).toBe("");
    expect(parser.push(";20;20m\x1b[0m")).toBe("\x1b[48;2;10;10;10m\x1b[48;2;20;20;20m\x1b[0m");
    expect(parser.flush()).toBe("");
  });

  it("holds a partial SGR open across pushes without losing bytes", () => {
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("text\x1b[48;2;10")).toBe("text");
    expect(parser.push(";10;10m48;2;20;20;20mdone")).toBe(
      "\x1b[48;2;10;10;10m\x1b[48;2;20;20;20mdone"
    );
    expect(parser.flush()).toBe("");
  });

  it("does not hold back an ordinary trailing m", () => {
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("form")).toBe("form");
    expect(parser.flush()).toBe("");
  });

  it("repairs foreground white split exactly at the SGR boundary", () => {
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("\x1b[38;2;100;100;100m")).toBe("\x1b[38;2;100;100;100m");
    expect(parser.push("38;2;255;255;255m\x1b[0m")).toBe("\x1b[38;2;255;255;255m\x1b[0m");
    expect(parser.flush()).toBe("");
  });

  it("repairs a cursor move split exactly at the SGR boundary", () => {
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("\x1b[48;2;10;10;10m")).toBe("\x1b[48;2;10;10;10m");
    expect(parser.push("10;1H\x1b[0m")).toBe("\x1b[10;1H\x1b[0m");
    expect(parser.flush()).toBe("");
  });

  it("repairs a dangling run split inside its params across three pushes", () => {
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("\x1b[48;2;10;10;10m")).toBe("\x1b[48;2;10;10;10m");
    expect(parser.push("48;2;20")).toBe("");
    expect(parser.push(";20;20m\x1b[0m")).toBe("\x1b[48;2;20;20;20m\x1b[0m");
    expect(parser.flush()).toBe("");
  });

  it("repairs chained dangling runs in one chunk", () => {
    expect(
      repairDanglingSgrSequences("\x1b[48;2;10;10;10m48;2;20;20;20m48;2;30;30;30m\x1b[0m")
    ).toBe("\x1b[48;2;10;10;10m\x1b[48;2;20;20;20m\x1b[48;2;30;30;30m\x1b[0m");
  });

  it("leaves prose digits after a reset untouched across pushes", () => {
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("\x1b[0m")).toBe("\x1b[0m");
    expect(parser.push("2026-09-09 log line")).toBe("2026-09-09 log line");
    expect(parser.flush()).toBe("");
  });

  it("flushes a held digit prefix as prose when it never completes", () => {
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("\x1b[0m")).toBe("\x1b[0m");
    expect(parser.push("2026")).toBe("");
    expect(parser.flush()).toBe("2026");
  });

  it("leaves out-of-range leading params untouched across pushes", () => {
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("\x1b[48;2;10;10;10m")).toBe("\x1b[48;2;10;10;10m");
    expect(parser.push("48;2;999;20;20m")).toBe("48;2;999;20;20m");
    expect(parser.flush()).toBe("");
  });

  it("repairs foreground white after a cursor move in one chunk", () => {
    expect(
      repairDanglingSgrSequences("\x1b[10;1H38;2;255;255;255m\x1b[0m")
    ).toBe("\x1b[10;1H\x1b[38;2;255;255;255m\x1b[0m");
  });

  it("repairs foreground white split exactly at a CUP boundary", () => {
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("\x1b[10;1H")).toBe("\x1b[10;1H");
    expect(parser.push("38;2;255;255;255m\x1b[0m")).toBe("\x1b[38;2;255;255;255m\x1b[0m");
    expect(parser.flush()).toBe("");
  });

  it("repairs chained SGR then CUP then color in one chunk", () => {
    expect(
      repairDanglingSgrSequences("\x1b[48;2;10;10;10m10;1H38;2;255;255;255m\x1b[0m")
    ).toBe("\x1b[48;2;10;10;10m\x1b[10;1H\x1b[38;2;255;255;255m\x1b[0m");
  });

  it("leaves prose after an erase-line untouched", () => {
    expect(repairDanglingSgrSequences("\x1b[2K10;1H")).toBe("\x1b[2K10;1H");
    expect(repairDanglingSgrSequences("\x1b[2K38;2;255;255;255m")).toBe("\x1b[2K38;2;255;255;255m");
  });

  it("repairs a truecolor run wrapped across a newline in one chunk", () => {
    expect(
      repairDanglingSgrSequences("\x1b[0m38;2;25\n5;255;255mX")
    ).toBe("\x1b[0m\x1b[38;2;255;255;255mX");
  });

  it("leaves a complete run after a newline untouched", () => {
    expect(repairDanglingSgrSequences("\x1b[0m\n10;1H")).toBe("\x1b[0m\n10;1H");
    expect(repairDanglingSgrSequences("\x1b[0m\n38;2;255;255;255m")).toBe(
      "\x1b[0m\n38;2;255;255;255m"
    );
  });

  it("repairs a truecolor run split across pushes around a newline", () => {
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("\x1b[0m")).toBe("\x1b[0m");
    expect(parser.push("38;2;25\n")).toBe("");
    expect(parser.push("5;255;255mX")).toBe("\x1b[38;2;255;255;255mX");
    expect(parser.flush()).toBe("");
  });

  it("repairs a terminator wrapped after a newline in one chunk", () => {
    expect(
      repairDanglingSgrSequences("\x1b[0m38;2;255;255;255\nmX")
    ).toBe("\x1b[0m\x1b[38;2;255;255;255mX");
  });

  it("leaves a newline before a complete run untouched across pushes", () => {
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("\x1b[0m")).toBe("\x1b[0m");
    expect(parser.push("\n10;1H")).toBe("\n10;1H");
    expect(parser.flush()).toBe("");
  });

  it("repairs a terminator arriving after a wrapped newline", () => {
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("\x1b[0m")).toBe("\x1b[0m");
    expect(parser.push("38;2;255;255;255\n")).toBe("");
    expect(parser.push("mX")).toBe("\x1b[38;2;255;255;255mX");
    expect(parser.flush()).toBe("");
  });

  it("leaves prose with semicolons across a newline untouched", () => {
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("\x1b[0m")).toBe("\x1b[0m");
    expect(parser.push("see 1;2\n3 cupcakes")).toBe("see 1;2\n3 cupcakes");
    expect(parser.flush()).toBe("");
  });

  it("repairs 256-color runs after an SGR", () => {
    expect(repairDanglingSgrSequences("\x1b[0m38;5;196mX")).toBe("\x1b[0m\x1b[38;5;196mX");
    expect(repairDanglingSgrSequences("\x1b[0m38;5;999m")).toBe("\x1b[0m38;5;999m");
    const parser = createDanglingSgrRepairParser();
    expect(parser.push("\x1b[0m")).toBe("\x1b[0m");
    expect(parser.push("38;5;196mX")).toBe("\x1b[38;5;196mX");
    expect(parser.flush()).toBe("");
  });
});
