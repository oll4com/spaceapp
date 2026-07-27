import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerSetupScreen } from "../src/features/auth/OwnerSetupScreen.js";
import { LiveSpaceApp } from "../src/live/LiveSpaceApp.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("first-owner setup", () => {
  it("loads setup status and shows owner setup instead of operator login", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        requests.push(url);
        if (url === "/api/setup/status") {
          return jsonResponse({
            setupRequired: true,
            expiresAt: "2099-07-23T12:15:00.000Z"
          });
        }
        if (url === "/api/auth/me") {
          return jsonResponse({
            user: null,
            isAuthenticated: false,
            isSetupRequired: true
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    render(<LiveSpaceApp />);

    expect(screen.getByRole("status").textContent).toMatch(/checking.*setup/i);
    expect(await screen.findByRole("heading", { name: "Create your Space owner" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Enter" })).toBeNull();
    expect(requests).toContain("/api/setup/status");
  });

  it("shows an accessible bootstrap error with a retry action", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network unavailable");
    }));

    render(<LiveSpaceApp />);

    expect((await screen.findByRole("alert")).textContent).toMatch(/could not check.*setup/i);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("does not request setup status after an authenticated owner session is confirmed", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        requests.push(url);
        if (url === "/api/auth/me") {
          return jsonResponse({
            user: { id: "user:owner", email: "owner@example.com", role: "ADMIN" },
            isAuthenticated: true,
            isSetupRequired: false
          });
        }
        if (url === "/api/rooms") {
          return new Promise<Response>(() => undefined);
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    render(<LiveSpaceApp />);

    await waitFor(() => {
      expect(requests).toContain("/api/rooms");
    });
    expect(requests).not.toContain("/api/setup/status");
  });

  it("renders a production-safe operator login form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/auth/me") {
          return jsonResponse({
            user: null,
            isAuthenticated: false,
            isSetupRequired: false
          });
        }
        if (url === "/api/setup/status") {
          return jsonResponse({
            setupRequired: false,
            expiresAt: null
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    render(<LiveSpaceApp />);

    const email = await screen.findByLabelText("Email") as HTMLInputElement;
    const password = screen.getByLabelText("Password") as HTMLInputElement;

    expect(email.value).toBe("");
    expect(email.id).toBe("operator-email");
    expect(email.name).toBe("email");
    expect(email.type).toBe("email");
    expect(password.id).toBe("operator-password");
    expect(password.name).toBe("password");
  });

  it("shows the owner a first-run checklist before the setup claim", () => {
    render(<OwnerSetupScreen expiresAt={null} onClaim={vi.fn(async () => undefined)} />);

    expect(screen.getByText(/shown at the end of/i).textContent).toMatch(/spaceapp install/i);
    expect(screen.getByText(/spaceapp owner rotate-setup-token/i)).toBeTruthy();
    expect(screen.queryByText(/spaceapp init/i)).toBeNull();
    expect(screen.getByRole("heading", { name: "After you sign in" })).toBeTruthy();
    expect(screen.getByText(/register only the workspaces/i)).toBeTruthy();
    expect(screen.getByText(/connect one provider at a time/i)).toBeTruthy();
    expect(screen.getByText(/make a backup before any update/i)).toBeTruthy();
  });

  it("describes credential transport without claiming loopback HTTP is encrypted", () => {
    render(<OwnerSetupScreen expiresAt={null} onClaim={vi.fn(async () => undefined)} />);

    expect(screen.getByText(/sent only in the request body/i)).toBeTruthy();
    expect(screen.queryByText(/encrypted request/i)).toBeNull();
  });

  it("gives every owner setup control a stable browser form name", () => {
    render(<OwnerSetupScreen expiresAt={null} onClaim={vi.fn(async () => undefined)} />);

    expect((screen.getByLabelText("One-time setup token") as HTMLInputElement).name).toBe("token");
    expect((screen.getByLabelText("Owner email") as HTMLInputElement).name).toBe("email");
    expect((screen.getByLabelText("New password") as HTMLInputElement).name).toBe("password");
    expect((screen.getByLabelText("Confirm password") as HTMLInputElement).name).toBe("passwordConfirmation");
  });

  it("places the owner username before password-like setup controls", () => {
    const { container } = render(
      <OwnerSetupScreen expiresAt={null} onClaim={vi.fn(async () => undefined)} />
    );

    expect(
      Array.from(container.querySelectorAll("form input")).map((input) => input.getAttribute("name"))
    ).toEqual(["email", "token", "password", "passwordConfirmation"]);
  });

  it("keeps the owner setup shell vertically scrollable at normal browser zoom", async () => {
    const styles = await readFile(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(styles).toMatch(
      /\.login-shell\s*\{[\s\S]*?height:\s*100dvh;[\s\S]*?overflow-y:\s*auto;[\s\S]*?\}/
    );
    expect(styles).toMatch(
      /\.setup-shell\s*\{[\s\S]*?place-items:\s*start center;[\s\S]*?\}/
    );
  });

  it("validates token, email, password length, and confirmation before claiming", async () => {
    const onClaim = vi.fn(async () => undefined);
    render(<OwnerSetupScreen expiresAt="2099-07-23T12:15:00.000Z" onClaim={onClaim} />);

    fireEvent.change(screen.getByLabelText("One-time setup token"), {
      target: { value: "too-short" }
    });
    fireEvent.change(screen.getByLabelText("Owner email"), {
      target: { value: "not-an-email" }
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "12345" }
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "different" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create owner account" }));

    expect(await screen.findByText(/token must contain at least 32 characters/i)).toBeTruthy();
    expect(screen.getByText(/enter a valid email address/i)).toBeTruthy();
    expect(screen.getByText(/password must contain at least 6 characters/i)).toBeTruthy();
    expect(screen.getByText(/passwords do not match/i)).toBeTruthy();
    expect(onClaim).not.toHaveBeenCalled();
  });

  it("accepts an owner password with exactly six characters", async () => {
    const onClaim = vi.fn(async () => undefined);
    render(<OwnerSetupScreen expiresAt={null} onClaim={onClaim} />);

    fireEvent.change(screen.getByLabelText("One-time setup token"), {
      target: { value: "setup-token-value-with-at-least-thirty-two-characters" }
    });
    fireEvent.change(screen.getByLabelText("Owner email"), {
      target: { value: "owner@example.com" }
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "abc123" }
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "abc123" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create owner account" }));

    await waitFor(() => {
      expect(onClaim).toHaveBeenCalledWith({
        token: "setup-token-value-with-at-least-thirty-two-characters",
        email: "owner@example.com",
        password: "abc123"
      });
    });
  });

  it("claims setup without putting credentials in URLs or browser storage", async () => {
    const setupToken = "setup-token-value-with-at-least-thirty-two-characters";
    const password = "correct horse battery staple";
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let claimed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        requests.push({ url, init });
        if (url === "/api/setup/status") {
          return jsonResponse({
            setupRequired: !claimed,
            expiresAt: claimed ? null : "2099-07-23T12:15:00.000Z"
          });
        }
        if (url === "/api/auth/me") {
          return jsonResponse(claimed
            ? {
                user: { id: "user:owner", email: "owner@example.com", role: "ADMIN" },
                isAuthenticated: true,
                isSetupRequired: false
              }
            : {
                user: null,
                isAuthenticated: false,
                isSetupRequired: true
              });
        }
        if (url === "/api/setup/claim") {
          claimed = true;
          return jsonResponse({
            user: { id: "user:owner", email: "owner@example.com", role: "ADMIN" },
            isAuthenticated: true,
            isSetupRequired: false
          });
        }
        if (url === "/api/rooms") {
          return new Promise<Response>(() => undefined);
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );

    render(<LiveSpaceApp />);
    await screen.findByRole("heading", { name: "Create your Space owner" });

    fireEvent.change(screen.getByLabelText("One-time setup token"), {
      target: { value: setupToken }
    });
    fireEvent.change(screen.getByLabelText("Owner email"), {
      target: { value: "owner@example.com" }
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: password }
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: password }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create owner account" }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Create your Space owner" })).toBeNull();
    });
    const claim = requests.find((request) => request.url === "/api/setup/claim");
    expect(claim?.init?.method).toBe("POST");
    expect(JSON.parse(String(claim?.init?.body))).toEqual({
      token: setupToken,
      email: "owner@example.com",
      password
    });
    expect(requests.every(({ url }) => !url.includes(setupToken) && !url.includes(password))).toBe(true);
    expect(
      Object.values(window.localStorage).every((value) =>
        !String(value).includes(setupToken) && !String(value).includes(password)
      )
    ).toBe(true);
  });
});
