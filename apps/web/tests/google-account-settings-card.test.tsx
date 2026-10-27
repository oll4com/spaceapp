import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GoogleAccountSettingsCard,
  maskEmail
} from "../src/features/auth/GoogleAccountSettingsCard.js";
import type { AuthMe } from "@space/contracts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GoogleAccountSettingsCard and email masking", () => {
  it("correctly masks email addresses of various formats", () => {
    expect(maskEmail("jordanlee7@gmail.com")).toBe("jo***e7@g***l.com");
    expect(maskEmail("alex@example.org")).toBe("a***x@e***e.org");
    expect(maskEmail("me@test.co.uk")).toBe("m***@t***t.co.uk");
    expect(maskEmail("invalid-email")).toBe("***");
    expect(maskEmail("")).toBe("***");
  });

  it("masks Space User email by default with data-sensitive-masked attribute", () => {
    const auth: AuthMe = {
      user: {
        id: "user:operator",
        email: "jordanlee7@gmail.com",
        role: "ADMIN"
      },
      isAuthenticated: true,
      isSetupRequired: false,
      googleAuthEnabled: true
    };

    render(<GoogleAccountSettingsCard auth={auth} onAuthRefresh={vi.fn()} />);

    // Masked email should be rendered initially
    expect(screen.getByText("jo***e7@g***l.com")).toBeTruthy();
    expect(screen.queryByText("jordanlee7@gmail.com")).toBeNull();

    const maskedElement = screen.getByText("jo***e7@g***l.com");
    expect(maskedElement.getAttribute("data-sensitive-masked")).toBe("manual");
  });

  it("toggles email masking when clicking the eye reveal button", () => {
    const auth: AuthMe = {
      user: {
        id: "user:operator",
        email: "jordanlee7@gmail.com",
        role: "ADMIN"
      },
      isAuthenticated: true,
      isSetupRequired: false,
      googleAuthEnabled: true
    };

    render(<GoogleAccountSettingsCard auth={auth} onAuthRefresh={vi.fn()} />);

    const revealBtn = screen.getByRole("button", { name: "Show full email" });
    fireEvent.click(revealBtn);

    // Full email should now be visible
    expect(screen.getByText("jordanlee7@gmail.com")).toBeTruthy();
    expect(screen.queryByText("jo***e7@g***l.com")).toBeNull();

    const hideBtn = screen.getByRole("button", { name: "Hide email" });
    fireEvent.click(hideBtn);

    // Email should be masked again
    expect(screen.getByText("jo***e7@g***l.com")).toBeTruthy();
    expect(screen.queryByText("jordanlee7@gmail.com")).toBeNull();
  });

  it("enables Google Account Link when googleAuthEnabled is true", () => {
    const auth: AuthMe = {
      user: {
        id: "user:operator",
        email: "operator@example.com",
        role: "ADMIN"
      },
      isAuthenticated: true,
      isSetupRequired: false,
      googleAuthEnabled: true
    };

    render(<GoogleAccountSettingsCard auth={auth} onAuthRefresh={vi.fn()} />);

    const linkBtn = screen.getByRole("link", { name: /Connect Google Account/i });
    expect(linkBtn.getAttribute("href")).toBe("/api/auth/google/start?link=true");
    expect(screen.getByText("Then you can sign in with Google in one click.")).toBeTruthy();
  });
});
