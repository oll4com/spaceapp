import { render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SensitiveDataMask,
  hasSensitiveText,
  normalizeText
} from "../src/features/sensitive-data/SensitiveDataMask.js";

describe("sensitive data mask helpers", () => {
  it("flags private/internal IPs, emails, and internal domains", () => {
    expect(hasSensitiveText("192.168.1.10")).toBe(true);
    expect(hasSensitiveText("10.0.0.1")).toBe(true);
    expect(hasSensitiveText("172.16.0.5")).toBe(true);
    expect(hasSensitiveText("172.31.255.254")).toBe(true);
    expect(hasSensitiveText("127.0.0.1")).toBe(true);
    expect(hasSensitiveText("169.254.10.20")).toBe(true);
    expect(hasSensitiveText("100.64.0.1")).toBe(true);
    expect(hasSensitiveText("198.18.0.1")).toBe(true);
    expect(hasSensitiveText("fd00::1")).toBe(true);
    expect(hasSensitiveText("fe80::1")).toBe(true);
    expect(hasSensitiveText("::1")).toBe(true);
    expect(hasSensitiveText("user@example.com")).toBe(true);
    expect(hasSensitiveText("nas.local")).toBe(true);
    expect(hasSensitiveText("router.lan")).toBe(true);
    expect(hasSensitiveText("pve.internal")).toBe(true);
    expect(hasSensitiveText("https://nas.local:8443/path")).toBe(true);
    expect(hasSensitiveText("www.server.home.arpa")).toBe(true);
    // Bare-domain forms: the public export rewrites every oll4.com subdomain, which would change these inputs.
    expect(hasSensitiveText("https://oll4.com/")).toBe(true);
    expect(hasSensitiveText("https://oll4.com/path")).toBe(true);
    expect(hasSensitiveText("oll4.com")).toBe(true);
  });

  it("leaves public IPs, external domains, and plain numbers unmasked", () => {
    expect(hasSensitiveText("8.8.8.8")).toBe(false);
    expect(hasSensitiveText("1.1.1.1")).toBe(false);
    expect(hasSensitiveText("203.0.113.5")).toBe(false);
    expect(hasSensitiveText("2001:db8::1")).toBe(false);
    expect(hasSensitiveText("spaceapp.dev")).toBe(false);
    expect(hasSensitiveText("https://www.google.com/x")).toBe(false);
    expect(hasSensitiveText("www.google.com")).toBe(false);
    expect(hasSensitiveText("123456")).toBe(false);
    expect(hasSensitiveText("60")).toBe(false);
    expect(hasSensitiveText("2026")).toBe(false);
  });

  it("leaves control-plane numbers and plain prose unmasked", () => {
    expect(hasSensitiveText("5 panes")).toBe(false);
    expect(hasSensitiveText("200 ms")).toBe(false);
    expect(hasSensitiveText("v1.2.3")).toBe(false);
    expect(hasSensitiveText("no sensitive data here")).toBe(false);
    expect(hasSensitiveText("14:26:41")).toBe(false);
  });

  it("leaves workspace text-size and toolbar values unmasked", () => {
    expect(hasSensitiveText("71")).toBe(false);
    expect(hasSensitiveText("10")).toBe(false);
    expect(hasSensitiveText("12")).toBe(false);
    expect(hasSensitiveText("20")).toBe(false);
    expect(hasSensitiveText("gpt-5.6-sol")).toBe(false);
    expect(hasSensitiveText("3")).toBe(false);
  });

  it("does not auto-flag personal display names so manual markers are required", () => {
    expect(hasSensitiveText("@spaceappdev_bot")).toBe(false);
    expect(hasSensitiveText("Pir Niramon")).toBe(false);
  });

  it("keeps manual-marked personal display names masked", async () => {
    const { container } = render(<SensitiveDataMask enabled={true} />);
    const target = document.createElement("small");
    target.dataset.sensitiveMasked = "manual";
    target.textContent = "Pir Niramon";
    container.appendChild(target);
    await waitFor(() => {
      expect(target.dataset.sensitiveMasked).toBe("manual");
    });
    expect(target.textContent).toBe("Pir Niramon");
  });

  it("normalizes whitespace before matching", () => {
    expect(normalizeText("  192.168.1.10  ")).toBe("192.168.1.10");
    expect(normalizeText("user@example.com\nnext")).toBe("user@example.com next");
  });

  it("ignores text inside explicitly ignored containers", async () => {
    const { container } = render(<SensitiveDataMask enabled={true} />);
    const ignored = document.createElement("div");
    ignored.dataset.sensitiveIgnore = "true";
    ignored.textContent = "192.168.1.10";
    container.appendChild(ignored);
    await waitFor(() => {
      expect(container.querySelector("div")).toBeTruthy();
    });
    expect(ignored.hasAttribute("data-sensitive-masked")).toBe(false);
  });

  it("masks flagged text nodes when enabled and removes markers when disabled", async () => {
    const { container, rerender } = render(<SensitiveDataMask enabled={true} />);
    const target = document.createElement("div");
    target.textContent = "server at 192.168.1.10";
    container.appendChild(target);
    await waitFor(() => {
      expect(target.dataset.sensitiveMasked).toBe("text");
    });
    rerender(<SensitiveDataMask enabled={false} />);
    await waitFor(() => {
      expect(target.hasAttribute("data-sensitive-masked")).toBe(false);
    });
  });

  it("sets and clears the root sensitive-mode attribute", async () => {
    const { rerender } = render(<SensitiveDataMask enabled={true} />);
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-sensitive-mode")).toBe("hidden");
    });
    rerender(<SensitiveDataMask enabled={false} />);
    await waitFor(() => {
      expect(document.documentElement.hasAttribute("data-sensitive-mode")).toBe(false);
    });
  });

  it("ships mask CSS rules without !important", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    // Assert the masking contract on its rules. Unrelated overlays share this
    // stylesheet and must not satisfy (or fail) the privacy-style assertions.
    const maskRules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
      .filter(([, selector]) => selector!.includes("[data-sensitive-masked="));
    expect(maskRules.length).toBeGreaterThan(0);
    const masks = maskRules.map(([rule]) => rule).join("\n");
    expect(masks).toContain(':root[data-sensitive-mode="hidden"] [data-sensitive-masked="text"]');
    expect(masks).toContain(':root[data-sensitive-mode="hidden"] [data-sensitive-masked="manual"]');
    expect(masks).toContain("color: transparent");
    expect(masks).toContain("-webkit-text-fill-color: transparent");
    expect(masks).toContain('[data-sensitive-masked="block"]');
    expect(masks).toMatch(/filter:\s*blur\(/);
    expect(masks).toContain("user-select: none");
    expect(masks).not.toContain("!important");
  });

  it("keeps a component's manual marker when masking is switched off and on again", async () => {
    const { container, rerender } = render(<SensitiveDataMask enabled={true} />);
    const target = document.createElement("span");
    target.dataset.sensitiveMasked = "manual";
    target.textContent = "Call the dentist on Friday";
    container.appendChild(target);
    rerender(<SensitiveDataMask enabled={false} />);
    await waitFor(() => expect(document.documentElement.hasAttribute("data-sensitive-mode")).toBe(false));
    expect(target.dataset.sensitiveMasked).toBe("manual");
  });

  it("upgrades manual markers to text masking instead of skipping them", async () => {
    const { container } = render(<SensitiveDataMask enabled={true} />);
    const target = document.createElement("strong");
    target.dataset.sensitiveMasked = "manual";
    target.textContent = "192.168.1.50";
    container.appendChild(target);
    await waitFor(() => {
      expect(target.dataset.sensitiveMasked).toBe("text");
    });
  });
});
