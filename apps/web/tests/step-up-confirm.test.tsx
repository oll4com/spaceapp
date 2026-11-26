import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({ stepUpWithPassword: vi.fn(), requestStepUpMail: vi.fn(), stepUpWithMail: vi.fn(),
  passwordStatus: vi.fn(() => Promise.resolve<{ hasPassword: boolean; stepUpUntil: string | null; canMail?: boolean }>({ hasPassword: true, stepUpUntil: null })) }));
vi.mock("../src/api.js", () => ({ api: apiMock }));
const { StepUpConfirm, STEP_UP_MAIL_KEY } = await import("../src/features/auth/StepUpConfirm.js");

// Confirm it is you (operator 17/11, nous_msg:a0e6a7a4da2944d0af75ce09 and nous_msg:db5f61cafe3847b1ad5f59f6): Google or a link by mail by
// default, no password field unless asked for, and someone who does not know the password always gets through.
beforeEach(() => { apiMock.passwordStatus.mockImplementation(() => Promise.resolve({ hasPassword: true, stepUpUntil: null })); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("StepUpConfirm", () => {
  it("offers Google and a link by mail with no password field, and Confirm with Google marks the held answer before leaving", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const beforeGoogle = vi.fn();
    render(<StepUpConfirm dock reason="Confirm it is you; then your answer is sent." google beforeGoogle={beforeGoogle} onConfirmed={vi.fn()} onCancel={vi.fn()} />);
    expect(document.querySelector("input[type=password]")).toBeNull();
    expect(await screen.findByRole("button", { name: "Email me a link" })).toBeTruthy();
    expect(screen.queryByText(/SpaceApp password/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm with Google" }));
    expect(beforeGoogle).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith("/api/auth/google/start?stepUp=mobile");
  });

  it("mails a link that changes no password, names where it went, and the pasted link confirms and runs the action", async () => {
    apiMock.requestStepUpMail.mockResolvedValue({ ok: true, sentTo: "owner@example.test" });
    apiMock.stepUpWithMail.mockResolvedValue({ steppedUp: true, until: new Date(Date.now() + 5 * 60_000).toISOString() });
    const onConfirmed = vi.fn();
    render(<StepUpConfirm dock reason="Confirm it is you." google={false} beforeGoogle={vi.fn()} onConfirmed={onConfirmed} onCancel={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Confirm with Google" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Email me a link" }));
    expect(await screen.findByText(/A link is on its way to owner@example\.test\./)).toBeTruthy();
    expect(document.querySelector("input[type=password]")).toBeNull();
    fireEvent.change(screen.getByLabelText("Link from the mail"), { target: { value: "not a link" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Paste the whole link from the mail.");
    const token = "Ab1_".repeat(11);
    fireEvent.change(screen.getByLabelText("Link from the mail"), { target: { value: ` https://space.example.test/#space-step-up=${token} ` } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledOnce());
    expect(apiMock.stepUpWithMail).toHaveBeenCalledWith(token);
    expect(apiMock.stepUpWithPassword).not.toHaveBeenCalled();
  });

  it("continues by itself when the link was opened in another tab of this browser", async () => {
    apiMock.requestStepUpMail.mockResolvedValue({ ok: true, sentTo: "owner@example.test" });
    const onConfirmed = vi.fn();
    render(<StepUpConfirm reason="Confirm it is you." google beforeGoogle={vi.fn()} onConfirmed={onConfirmed} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Email me a link" }));
    await screen.findByLabelText("Link from the mail");
    apiMock.passwordStatus.mockResolvedValue({ hasPassword: true, stepUpUntil: new Date(Date.now() + 5 * 60_000).toISOString() });
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: STEP_UP_MAIL_KEY, newValue: String(Date.now()) })); });
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledOnce());
    act(() => { window.dispatchEvent(new Event("focus")); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onConfirmed).toHaveBeenCalledOnce();
  });

  it("keeps the password behind a link, and names a refused password without its code", async () => {
    apiMock.stepUpWithPassword.mockRejectedValueOnce(new Error("STEP_UP_FAILED: That is not your SpaceApp password."));
    apiMock.stepUpWithPassword.mockResolvedValueOnce({ steppedUp: true, until: new Date().toISOString() });
    const onConfirmed = vi.fn();
    render(<StepUpConfirm reason="Confirm it is you." google beforeGoogle={vi.fn()} onConfirmed={onConfirmed} passwordLabel="I know my current password" />);
    fireEvent.click(await screen.findByRole("button", { name: "I know my current password" }));
    fireEvent.change(screen.getByLabelText("Your SpaceApp password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That is not your SpaceApp password.");
    fireEvent.change(screen.getByLabelText("Your SpaceApp password"), { target: { value: "right words" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledOnce());
    expect(apiMock.stepUpWithPassword).toHaveBeenLastCalledWith("right words");
  });

  it("offers no password link to an account that has no SpaceApp password", async () => {
    apiMock.passwordStatus.mockImplementation(() => Promise.resolve({ hasPassword: false, stepUpUntil: null }));
    render(<StepUpConfirm reason="Confirm it is you." google beforeGoogle={vi.fn()} onConfirmed={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use my password instead" })).toBeNull());
    expect(await screen.findByRole("button", { name: "Email me a link" })).toBeTruthy();
  });

  it("on a server that cannot mail, never shows a mail button: Google stays on the web", async () => {
    apiMock.passwordStatus.mockImplementation(() => Promise.resolve({ hasPassword: true, stepUpUntil: null, canMail: false }));
    render(<StepUpConfirm reason="Confirm it is you." google beforeGoogle={vi.fn()} onConfirmed={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Email me a link" })).toBeNull();
    await waitFor(() => expect(apiMock.passwordStatus).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("button", { name: "Email me a link" })).toBeNull();
    expect(screen.getByRole("button", { name: "Confirm with Google" })).toBeTruthy();
  });

  it("in the desktop app on a server that cannot mail, says so plainly and opens SpaceApp in the browser, with no password field", async () => {
    apiMock.passwordStatus.mockImplementation(() => Promise.resolve({ hasPassword: true, stepUpUntil: null, canMail: false }));
    const openExternal = vi.fn(() => Promise.resolve(true));
    vi.stubGlobal("spaceDesktop", { openExternal });
    render(<StepUpConfirm reason="Confirm it is you." google={false} beforeGoogle={vi.fn()} onConfirmed={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open SpaceApp in your browser" }));
    expect(screen.getByText(/This server cannot send mail, and the desktop app cannot confirm with Google/)).toBeTruthy();
    expect(document.querySelector("input[type=password]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Email me a link" })).toBeNull();
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(`${window.location.origin}/`));
    expect(screen.queryByText(/in your browser\.$/)).toBeNull();
    // An older app without the bridge's answer: the address to open by hand.
    openExternal.mockResolvedValueOnce(undefined as never);
    fireEvent.click(screen.getByRole("button", { name: "Open SpaceApp in your browser" }));
    expect(await screen.findByText(`Open ${window.location.origin}/ in your browser.`)).toBeTruthy();
    // Whoever knows the password still has it behind the link.
    expect(screen.getByRole("button", { name: "Use my password instead" })).toBeTruthy();
  });
});
