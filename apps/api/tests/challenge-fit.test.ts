import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { challengeFitScript } from "../src/challenge-fit.js";
import { roomyPhone } from "../src/pane-browser-teleport.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("teleport reCAPTCHA challenge fit (nous_msg:f93235c0)", () => {
  it("moves a challenge that opens past a 412 px phone's right edge back inside, again when reCAPTCHA places it again", async () => {
    const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
    const { document } = dom.window;
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 412 });
    // jsdom has no layout: the box's rect follows its left, 402 px wide (the 400 px challenge and its border)
    const challenge = (src: string, left: number) => {
      const box = document.createElement("div");
      box.style.position = "absolute";
      box.style.left = `${left}px`;
      box.getBoundingClientRect = () => ({ left: parseFloat(box.style.left), right: parseFloat(box.style.left) + 402 }) as DOMRect;
      box.innerHTML = `<div style="position: relative"><iframe src="${src}"></iframe></div>`;
      return box;
    };
    dom.window.eval(challengeFitScript());
    const box = challenge("https://www.google.com/recaptcha/api2/bframe?hl=en&k=key", 85);
    const other = challenge("https://example.com/recaptcha/elsewhere", 85);
    document.body.append(box, other);
    await settle();
    expect(box.style.left).toBe("10px");
    expect(other.style.left).toBe("85px");
    box.style.left = "120px";
    await settle();
    expect(box.style.left).toBe("10px");
    box.style.left = "5px";
    await settle();
    expect(box.style.left).toBe("5px");
    dom.window.close();
  });

  it("gives a phone narrower than the challenge a 412 px page of the same shape", () => {
    expect(roomyPhone({ width: 390, height: 844 })).toEqual({ width: 412, height: 892 });
    expect(roomyPhone({ width: 411, height: 891 })).toEqual({ width: 412, height: 893 });
    expect(roomyPhone({ width: 430, height: 932 })).toEqual({ width: 430, height: 932 });
  });
});
