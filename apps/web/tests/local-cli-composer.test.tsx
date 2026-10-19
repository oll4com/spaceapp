import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalCliDraftEditor } from "../src/features/terminal-pane/LocalCliComposer.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { emptyLocalCliDraft, localCliDraftKey, readLocalCliDraft, reloadAfterLocalCliDraftsSaved, writeLocalCliDraft, type LocalCliFileStore } from "../src/features/terminal-pane/local-cli-draft.js";

const api = vi.hoisted(() => ({ submitLocalCliDraft: vi.fn(), localCliSubmission: vi.fn(), uploadCliFiles: vi.fn(), artifactFileUrl: vi.fn() }));
vi.mock("../src/api.js", () => ({ api }));
const key = localCliDraftKey("user:owner", "pane:local");
const props = { userId: "user:owner", paneId: "pane:local", paneTitle: "Test CLI", sessionId: "session:one", nativeImages: false,
  canSend: true, prepareSend: async () => true, onClose: vi.fn() };
let blobs: Map<string, Blob>;
let fileStore: LocalCliFileStore;
const field = () => screen.getByRole("textbox", { name: "Local draft for Test CLI" }) as HTMLTextAreaElement;
const sendButton = () => screen.getByRole("button", { name: "Send" });
const edit = (text: string) => fireEvent.change(field(), { target: { value: text } });
function attach(container: HTMLElement, file = new File(["synthetic image"], "photo.png", { type: "image/png" })) {
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
}

beforeEach(() => {
  installSpaceRuntime(liveRuntime);
  localStorage.clear();
  vi.clearAllMocks();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: vi.fn(async (_scope, _options, work) => work({ name: _scope, mode: "exclusive" })) } });
  blobs = new Map();
  fileStore = {
    put: vi.fn(async (scope: string, files: Array<{ id: string; blob: Blob }>) => { files.forEach(file => blobs.set(`${scope}:${file.id}`, file.blob)); }),
    get: vi.fn(async (scope: string, id: string) => blobs.get(`${scope}:${id}`) ?? null),
    remove: vi.fn(async (scope: string, ids: string[]) => { ids.forEach(id => blobs.delete(`${scope}:${id}`)); })
  };
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  api.submitLocalCliDraft.mockImplementation(async (_pane, input) => ({ submissionId: input.submissionId, sessionId: input.expectedSessionId, status: "SENT" }));
  api.localCliSubmission.mockResolvedValue({ status: "SENT" });
  api.uploadCliFiles.mockResolvedValue({ sessionId: "session:one", files: [{ artifactId: "artifact:one", sessionId: "session:one", isImage: true,
    originalFilename: "photo.png", mimeType: "image/png", terminalPath: "/synthetic/photo.png", shellQuotedPath: "'/synthetic/photo.png'" }] });
});
afterEach(() => vi.restoreAllMocks());

describe("local CLI compose and recovery", () => {
  it("never revokes an image URL while the editor still renders it during attachment changes", async () => {
    let nextUrl = 0;
    const revokedWhileVisible: string[] = [];
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:preview-${++nextUrl}`);
    vi.mocked(URL.revokeObjectURL).mockImplementation(url => {
      if ([...document.querySelectorAll<HTMLImageElement>(".local-cli-files img")].some(image => image.src === url)) {
        revokedWhileVisible.push(url);
      }
    });
    const view = render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    attach(view.container);
    await waitFor(() => expect(view.container.querySelector(".local-cli-files img")).toBeTruthy());
    await waitFor(() => expect(screen.queryByText("Saving attachments…")).toBeNull());
    let finishRead!: () => void;
    const pending = new Promise<void>(resolve => { finishRead = resolve; });
    vi.mocked(fileStore.get).mockImplementation(async (scope, id) => { await pending; return blobs.get(`${scope}:${id}`) ?? null; });
    attach(view.container, new File(["second image"], "second.png", { type: "image/png" }));
    await act(async () => { finishRead(); await pending; });
    await waitFor(() => expect(view.container.querySelectorAll(".local-cli-files img")).toHaveLength(2));
    view.unmount();
    expect(revokedWhileVisible).toEqual([]);
    const generated = vi.mocked(URL.createObjectURL).mock.results.map(result => result.value);
    expect(vi.mocked(URL.revokeObjectURL).mock.calls.map(([url]) => url).sort()).toEqual(generated.sort());
  });

  it("recovers the final keystroke and a file after an immediate remount", async () => {
    const view = render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    edit("Τελευταίο γράμμα Ω");
    attach(view.container);
    await waitFor(() => expect(screen.queryByText("Saving attachments…")).toBeNull());
    const saved = readLocalCliDraft(localStorage, key);
    expect(saved.text).toBe("Τελευταίο γράμμα Ω");
    expect(await fileStore.get(key, saved.files[0]!.id)).toBeInstanceOf(Blob);
    view.unmount();
    render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    expect(field().value).toBe("Τελευταίο γράμμα Ω");
    expect(screen.getByText("photo.png")).toBeTruthy();
  });

  it("does not send during IME composition and keeps Shift+Enter for multiline editing", async () => {
    render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    edit("γειά");
    fireEvent.compositionStart(field());
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.compositionEnd(field());
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    expect(api.submitLocalCliDraft).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(api.submitLocalCliDraft).toHaveBeenCalledTimes(1));
  });

  it("journals the exact text and uploaded file before sending, retains a confirmed recovery copy", async () => {
    const view = render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    edit("Inspect this");
    attach(view.container);
    await waitFor(() => expect(screen.queryByText("Saving attachments…")).toBeNull());
    api.submitLocalCliDraft.mockImplementation(async (_pane, input) => {
      const saved = readLocalCliDraft(localStorage, key);
      expect(saved.submission?.id).toBe(input.submissionId);
      expect(saved.submission?.files[0]?.uploaded?.artifactId).toBe("artifact:one");
      expect(saved.submission?.payload).toContain("[Image #1]");
      return { status: "SENT" };
    });
    fireEvent.click(sendButton());
    await waitFor(() => expect(field().value).toBe(""));
    const saved = readLocalCliDraft(localStorage, key);
    expect(saved.submission?.text).toBe("Inspect this");
    expect(saved.submission?.files).toHaveLength(1);
    expect(blobs.size).toBe(1);
    expect(saved.submission?.status).toBe("SENT");
  });

  it("rechecks terminal input after a delayed file upload and preserves the draft if it changed", async () => {
    let terminalHasDraft = false;
    const prepareSend = vi.fn(async () => !terminalHasDraft);
    let finish!: (value: unknown) => void;
    api.uploadCliFiles.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const view = render(<LocalCliDraftEditor {...props} prepareSend={prepareSend} fileStore={fileStore} />);
    edit("Keep this local message");
    attach(view.container);
    await waitFor(() => expect(screen.queryByText("Saving attachments…")).toBeNull());
    fireEvent.click(sendButton());
    await waitFor(() => expect(api.uploadCliFiles).toHaveBeenCalledTimes(1));
    terminalHasDraft = true;
    await act(async () => finish({ sessionId: "session:one", files: [{ artifactId: "artifact:one", sessionId: "session:one", isImage: true,
      originalFilename: "photo.png", mimeType: "image/png", terminalPath: "/synthetic/photo.png", shellQuotedPath: "'/synthetic/photo.png'" }] }));
    expect(prepareSend).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/CLI input changed before sending/)).toBeTruthy();
    expect(api.submitLocalCliDraft).not.toHaveBeenCalled();
    const saved = readLocalCliDraft(localStorage, key);
    expect(saved.text).toBe("Keep this local message");
    expect(saved.files[0]?.uploaded?.artifactId).toBe("artifact:one");
    expect(saved.submission).toBeNull();
  });

  it("reconciles a send interrupted by refresh without dispatching again", async () => {
    let acknowledge!: (value: { status: string }) => void;
    api.submitLocalCliDraft.mockReturnValue(new Promise(resolve => { acknowledge = resolve; }));
    const first = render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    edit("Refresh while sending");
    fireEvent.click(sendButton());
    await waitFor(() => expect(api.submitLocalCliDraft).toHaveBeenCalledTimes(1));
    expect(readLocalCliDraft(localStorage, key).submission?.status).toBe("SENDING");
    first.unmount();
    render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    await waitFor(() => expect(field().value).toBe(""));
    expect(api.localCliSubmission).toHaveBeenCalledTimes(1);
    expect(api.submitLocalCliDraft).toHaveBeenCalledTimes(1);
    await act(async () => acknowledge({ status: "SENT" }));
  });

  it("retains uncertain delivery and newer edits instead of retrying or clearing them", async () => {
    const submission = { id: crypto.randomUUID(), sessionId: "session:one", text: "old", files: [], payload: "old", imagePaths: [], status: "SENDING" as const };
    writeLocalCliDraft(localStorage, key, "", { ...emptyLocalCliDraft(), text: "old", submission });
    let answer!: (value: { status: string }) => void;
    api.localCliSubmission.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    edit("newer work");
    await act(async () => answer({ status: "SENT" }));
    expect(field().value).toBe("newer work");
    expect(api.submitLocalCliDraft).not.toHaveBeenCalled();
  });

  it("keeps a missing receipt ambiguous and requires explicit recovery", async () => {
    const submission = { id: crypto.randomUUID(), sessionId: "session:one", text: "saved", files: [], payload: "saved", imagePaths: [], status: "SENDING" as const };
    writeLocalCliDraft(localStorage, key, "", { ...emptyLocalCliDraft(), text: "saved", submission });
    api.localCliSubmission.mockResolvedValue({ status: "NOT_FOUND" });
    render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    await waitFor(() => expect(readLocalCliDraft(localStorage, key).submission?.status).toBe("UNCERTAIN"));
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    expect(field().value).toBe("saved");
    expect(api.submitLocalCliDraft).not.toHaveBeenCalled();
  });

  it("blocks sending and closing on storage failure without hiding unsaved text", async () => {
    render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Device storage full"); });
    edit("keep this text");
    expect(field().value).toBe("keep this text");
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Close local draft" }) as HTMLButtonElement).disabled).toBe(true);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    expect(api.submitLocalCliDraft).not.toHaveBeenCalled();
    write.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
    expect(readLocalCliDraft(localStorage, key).text).toBe("keep this text");
  });

  it("keeps delayed photo writes and reload protection across editor unmount and reopen", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(fileStore.put).mockImplementationOnce(async (scope, files) => {
      await pending;
      files.forEach(file => blobs.set(`${scope}:${file.id}`, file.blob));
    });
    const first = render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    edit("photo still saving");
    attach(first.container);
    const id = readLocalCliDraft(localStorage, key).files[0]!.id;
    first.unmount();
    const reload = vi.fn();
    const reloading = reloadAfterLocalCliDraftsSaved(reload);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    expect(field().value).toBe("photo still saving");
    expect(screen.getByText("photo.png")).toBeTruthy();
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish(); await reloading; });
    expect(await fileStore.get(key, id)).toBeInstanceOf(Blob);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Saving attachments…")).toBeNull();
    expect(api.submitLocalCliDraft).not.toHaveBeenCalled();
  });

  it("retains failed photo bytes when unmounted and retries them only after reopening", async () => {
    vi.mocked(fileStore.put).mockRejectedValueOnce(new Error("Disk full"));
    const first = render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    const photo = new File(["original image bytes"], "photo.png", { type: "image/png" });
    attach(first.container, photo);
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry saving" })).toBeTruthy());
    const id = readLocalCliDraft(localStorage, key).files[0]!.id;
    first.unmount();
    const reload = vi.fn();
    await expect(reloadAfterLocalCliDraftsSaved(reload)).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    expect(screen.getByText("photo.png")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry saving" })).toBeTruthy();
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
    await waitFor(() => expect(screen.queryByText("Saving attachments…")).toBeNull());
    expect(await fileStore.get(key, id)).toBe(photo);
    await expect(reloadAfterLocalCliDraftsSaved(reload)).resolves.toBe(true);
    expect(api.submitLocalCliDraft).not.toHaveBeenCalled();
  });

  it("recovers quota-failed text after unmount, retaining the unsaved marker until a locked retry succeeds", async () => {
    const first = render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    edit("last durable revision");
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Device storage full"); });
    edit("the latest unsaved characters Ω");
    first.unmount();
    const reload = vi.fn();
    await expect(reloadAfterLocalCliDraftsSaved(reload)).resolves.toBe(false);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    write.mockRestore();
    render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    expect(field().value).toBe("the latest unsaved characters Ω");
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    expect(readLocalCliDraft(localStorage, key).text).toBe("last durable revision");
    fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
    expect(readLocalCliDraft(localStorage, key).text).toBe("the latest unsaved characters Ω");
    await expect(reloadAfterLocalCliDraftsSaved(reload)).resolves.toBe(true);
    expect(api.submitLocalCliDraft).not.toHaveBeenCalled();
  });

  it("allows only one editor across browser tabs and rereads the draft after taking the lock", async () => {
    let held = false;
    vi.mocked(navigator.locks.request).mockImplementation(async (_scope, _options, callback: any) => {
      if (held) return callback(null);
      held = true;
      try { return await callback({ name: key, mode: "exclusive" }); }
      finally { held = false; }
    });
    const first = render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    edit("first tab's latest edit");
    const second = render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    expect(within(second.container).getByRole("textbox").hasAttribute("disabled")).toBe(true);
    expect(within(second.container).getByText(/open in another tab/)).toBeTruthy();
    first.unmount();
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(within(second.container).getByRole("button", { name: "Retry opening" }));
    await waitFor(() => expect(within(second.container).getByRole("textbox").hasAttribute("disabled")).toBe(false));
    expect((within(second.container).getByRole("textbox") as HTMLTextAreaElement).value).toBe("first tab's latest edit");
    expect(api.submitLocalCliDraft).not.toHaveBeenCalled();
  });

  it("keeps file retry visible after typing and never overwrites a newer photo during recovery", async () => {
    const view = render(<LocalCliDraftEditor {...props} fileStore={fileStore} />);
    vi.mocked(fileStore.put).mockRejectedValueOnce(new Error("Disk full"));
    attach(view.container);
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry saving" })).toBeTruthy());
    edit("new text");
    expect(screen.getByRole("button", { name: "Retry saving" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
    await waitFor(() => expect(screen.queryByText("Saving attachments…")).toBeNull());
    fireEvent.click(sendButton());
    await waitFor(() => expect(field().value).toBe(""));
    attach(view.container, new File(["new"], "new.png", { type: "image/png" }));
    await waitFor(() => expect(screen.queryByText("Saving attachments…")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Recovery copy" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore as draft" }));
    expect(readLocalCliDraft(localStorage, key).files[0]?.name).toBe("new.png");
  });
});
