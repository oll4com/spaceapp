import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SavedSignature, SignatureRequest } from "@space/contracts";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

// pdfjs draws the pages; the picker (nous_msg:781819c5ba0440fbbee8682c) lives beside them and needs none.
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => undefined), destroy: async () => undefined }) }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));
const { SignDialog } = await import("../src/features/agent-files/SignDialog.js");

const saved = (id: string, label: string, isDefault: boolean): SavedSignature =>
  ({ id, label, width: 300, height: 90, isDefault, artifactId: null, createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z" });
const request = {
  id: "sigreq:claim", ownerUserId: "user:operator", artifactId: "artifact:pdf", title: "Claim", note: null,
  placements: [{ page: 1, x: 10, y: 10, width: 120 }, { page: 2, x: 10, y: 10, width: 60 }], fields: [], roomId: "room:a", paneId: "pane:max",
  status: "PENDING", test: false, signedArtifactId: null, signedAt: null, createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z",
  document: { filename: "claim.pdf", folder: null }
} satisfies SignatureRequest & { document: { filename: string; folder: string | null } };

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  installSpaceRuntime(liveRuntime);
  vi.spyOn(liveRuntime.api, "signatures").mockResolvedValue({ signatures: [saved("sig:full", "Full", false), saved("sig:initials", "Initials", true)] });
  vi.spyOn(liveRuntime.api, "signatureDetails").mockResolvedValue({ details: { phone: null } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("preselects the default saved signature on every spot, lets one spot take another, and signs with that choice per spot", async () => {
  const sign = vi.spyOn(liveRuntime.api, "signSignatureRequest").mockResolvedValue({ request: { ...request, status: "SIGNED" }, artifact: { id: "artifact:signed", roomId: null, metadata: {} } as never });
  render(<SignDialog artifactId="artifact:pdf" filename="claim.pdf" request={request} onClose={() => undefined} />);
  const picker = await screen.findByRole("radiogroup", { name: "Which signature" });
  await waitFor(() => expect((within(picker).getByRole("radio", { name: /Initials · default/ }) as HTMLInputElement).checked).toBe(true));
  const spots = screen.getByLabelText("Signature on each spot");
  const [first, second] = within(spots).getAllByRole("combobox") as HTMLSelectElement[];
  expect([first!.value, second!.value]).toEqual(["sig:initials", "sig:initials"]);
  fireEvent.change(first!, { target: { value: "sig:full" } });
  expect(screen.queryByLabelText(/Signature pad/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign all 2 spots" }));
  await waitFor(() => expect(sign).toHaveBeenCalledWith("sigreq:claim", { spotSignatures: ["sig:full", "sig:initials"], fieldValues: [] }));
});

it("shows the pad when a new one is drawn, and keeps it only when asked", async () => {
  render(<SignDialog artifactId="artifact:pdf" filename="claim.pdf" request={request} onClose={() => undefined} />);
  const picker = await screen.findByRole("radiogroup", { name: "Which signature" });
  fireEvent.click(within(picker).getByRole("radio", { name: /Draw a new one/ }));
  expect(screen.getByLabelText(/Signature pad/)).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: /Save it to my signatures/ }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("button", { name: "Sign all 2 spots" }) as HTMLButtonElement).disabled).toBe(true);
});
