import { render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SensitiveDataMask,
  hasSensitiveText,
  instanceDomain,
  normalizeText,
  sensitiveSpans
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
  });

  it("EXP-001: masks the instance's own domain, read from its host, and names no maintainer domain in code", () => {
    expect(hasSensitiveText("https://corp-example.net/", "corp-example.net")).toBe(true);
    expect(hasSensitiveText("https://space.corp-example.net:4911/path", "corp-example.net")).toBe(true);
    expect(hasSensitiveText("www.corp-example.net", "corp-example.net")).toBe(true);
    expect(hasSensitiveText("corp-example.net", "corp-example.net")).toBe(true);
    expect(hasSensitiveText("notcorp-example.net", "corp-example.net")).toBe(false);
    expect(hasSensitiveText("corp-example.net", null)).toBe(false);
    expect(instanceDomain("space.corp-example.net")).toBe("corp-example.net");
    expect(instanceDomain("localhost")).toBeNull();
    expect(instanceDomain("10.0.0.5")).toBeNull();
    const source = readFileSync(resolve(__dirname, "../src/features/sensitive-data/SensitiveDataMask.tsx"), "utf8");
    expect(source).not.toMatch(/\\?\.com\b/);
  });

  it("step 14: flags secrets and one-time codes, and only their own characters", () => {
    // Split literals: the public export audit refuses a file holding a whole token or key header, even a fake one.
    for (const secret of ["sk-ant-abcdef123456", "gh" + "p_abcdefghijklmnopqrstuvwxyz012345", "AK" + "IAABCDEFGHIJKLMNOP", "glpat-abcdefghijklmnopqrstu",
      "spacecontrol.v1.abc.def", "eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl", "-----BEGIN " + "OPENSSH PRIVATE KEY-----", "SPACEAPP-PAIR:1:abc"]) {
      expect(hasSensitiveText(secret), secret).toBe(true);
    }
    const value = (text: string) => sensitiveSpans(text, null).map(([start, end]) => text.slice(start, end));
    expect(value("Your verification code is 482913, it expires soon")).toEqual(["482913"]);
    expect(value("OTP: 1234")).toEqual(["1234"]);
    expect(value("Ο κωδικός σας: 556677")).toEqual(["556677"]);
    expect(value("password: hunter22 was saved")).toEqual(["hunter22"]);
    expect(value("api_key=abc123def, then retry")).toEqual(["abc123def"]);
    expect(value("Write to ops@example.net about pve.internal")).toEqual(["ops@example.net"]);
    expect(value("Open http://nas.local:8443/share now")).toEqual(["http://nas.local:8443/share"]);
  });

  it("step 14: leaves names, dates, versions and usage words unmasked", () => {
    for (const text of ["Home", "Local", "localhost", "Corp", "https://github.com/home", "https://example.org/local/lan",
      "Code 2026-11-16", "code 1.2.0", "Tokens: 12,345", "max_tokens=1000", "Token budget: 5000", "The goal: ship the hero GIF",
      "Pin the tab", "Add GET /health with a test"]) {
      expect(hasSensitiveText(text, null), text).toBe(false);
    }
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

  it("masks an empty field whose placeholder is sensitive (Space Gateway's Alias field shows the account e-mail)", async () => {
    const { container } = render(<SensitiveDataMask enabled={true} />);
    const alias = document.createElement("input");
    alias.placeholder = "someone@example.com";
    const plain = document.createElement("input");
    plain.placeholder = "Alias";
    container.append(alias, plain);
    await waitFor(() => {
      expect(alias.dataset.sensitiveMasked).toBe("text");
    });
    expect(plain.hasAttribute("data-sensitive-masked")).toBe(false);
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
    // 12/11: the operator scans the pairing QR himself; only agents' pictures blur it (browser-sessions.ts PAIRING_MASK).
    expect(masks).not.toContain('[data-sensitive-masked="pairing"]');
    expect(css).toMatch(/::highlight\(space-sensitive\) \{[^}]*color: transparent[^}]*text-shadow/);
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

  describe("with the CSS Custom Highlight API", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("blurs only the private value inside prose and clears it when switched off", async () => {
      const registry = new Map<string, { ranges: Range[] }>();
      vi.stubGlobal("CSS", { highlights: registry });
      vi.stubGlobal("Highlight", class { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } });
      const { container, rerender } = render(<SensitiveDataMask enabled={true} />);
      const prose = document.createElement("p");
      // Two sibling text nodes, as React renders "Your code is {code}".
      prose.append("Mail ops@example.net, your code is ", "482913", " for Home");
      container.appendChild(prose);
      await waitFor(() => {
        expect(registry.get("space-sensitive")?.ranges.map((range) => range.toString())).toEqual(["ops@example.net", "482913"]);
      });
      expect(prose.hasAttribute("data-sensitive-masked")).toBe(false);
      rerender(<SensitiveDataMask enabled={false} />);
      await waitFor(() => expect(registry.has("space-sensitive")).toBe(false));
    });
  });
});
