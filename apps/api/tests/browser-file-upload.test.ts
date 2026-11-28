import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { uploadablePaths, uploadBrowserFiles } from "../src/browser-file-upload.js";

vi.mock("../src/cli-browser-cdp.js", () => ({
  activeTabProfilePath: vi.fn(async () => "/owned/profile"),
  readChromeAutomationEndpoint: vi.fn(async () => "ws://127.0.0.1:9876/devtools/browser/proof")
}));

// 31/10 (Job Copilot, Index.dev): the CV goes into a page a Vault fill fenced. Only the pane's own files, never a secret.
describe("browser file upload", () => {
  let base = "";
  let allowed: { roots: string[]; files: string[] };
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "space-upload-"));
    for (const dir of ["workspace/secrets", "job", "outside", "artifacts"]) await mkdir(join(base, dir), { recursive: true });
    for (const file of ["workspace/cv.pdf", "workspace/.env", "workspace/secrets/cv.pdf", "job/photo.jpg", "outside/other.pdf", "artifacts/cv-artifact.pdf"]) await writeFile(join(base, file), "synthetic");
    await symlink(join(base, "outside/other.pdf"), join(base, "workspace/escape.pdf"));
    allowed = { roots: [join(base, "workspace"), join(base, "job")], files: [join(base, "artifacts/cv-artifact.pdf")] };
  });
  afterAll(() => rm(base, { recursive: true, force: true }));

  it("takes files under the agent workspace, the Job Copilot folder and its CV, and refuses the rest", async () => {
    expect(await uploadablePaths([join(base, "workspace/cv.pdf"), join(base, "job/photo.jpg"), join(base, "artifacts/cv-artifact.pdf")], allowed))
      .toEqual([join(base, "workspace/cv.pdf"), join(base, "job/photo.jpg"), join(base, "artifacts/cv-artifact.pdf")]);
    for (const path of ["outside/other.pdf", "workspace/escape.pdf", "workspace/.env", "workspace/secrets/cv.pdf"]) {
      await expect(uploadablePaths([join(base, path)], allowed), path).rejects.toThrow(/not one of this pane's files/);
    }
    await expect(uploadablePaths(["workspace/cv.pdf"], allowed)).rejects.toThrow(/absolute path/);
    await expect(uploadablePaths([join(base, "workspace/missing.pdf")], allowed)).rejects.toThrow(/was not found/);
    await expect(uploadablePaths([join(base, "workspace/secrets/..")], allowed)).rejects.toThrow(/not one of this pane's files/);
  });

  type Node = { nodeId: number; nodeName: string; attributes?: string[]; frameId?: string; children?: Node[]; shadowRoots?: Node[]; contentDocument?: Node };
  const doc = (nodeId: number, ...children: Node[]): Node => ({ nodeId, nodeName: "#document", children: [{ nodeId: nodeId + 1, nodeName: "HTML", children }] });
  const fileInput = (nodeId: number): Node => ({ nodeId, nodeName: "INPUT", attributes: ["name", "type", "type", "file"] });
  const calls: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
  const upload = async (documents: Record<string, Node>, index?: number) => {
    calls.length = 0;
    const client = {
      send: async <T,>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> => {
        calls.push({ method, params, sessionId });
        if (method === "Target.attachToTarget" && params?.targetId === "frame:gone") throw new Error("No target with given id found");
        if (method === "Target.attachToTarget") return { sessionId: params?.targetId === "page:owned" ? "page-session" : `session:${String(params?.targetId)}` } as T;
        if (method === "DOM.getDocument") return { root: documents[sessionId ?? ""] } as T;
        return {} as T;
      },
      close: vi.fn()
    };
    const options = { config: { browserSessionsProfileRoot: "/profiles" }, pane: { id: "pane:owned", roomId: "room:owned" },
      session: { activePageId: "page:owned", pages: [{ pageId: "page:owned" }] }, paths: ["/w/cv.pdf"], index } as unknown as Parameters<typeof uploadBrowserFiles>[0];
    const result = await uploadBrowserFiles(options, async () => client).catch((error: Error) => error);
    expect(calls.at(-1)).toMatchObject({ method: "Target.detachFromTarget", params: { sessionId: "page-session" } });
    expect(client.close).toHaveBeenCalledOnce();
    return { result, set: calls.filter((call) => call.method === "DOM.setFileInputFiles") };
  };

  it("sets the one matching file input of the active tab, asks for an index when several match, and always lets the tab go", async () => {
    const run = async (inputs: number[], index?: number) => {
      const { result, set } = await upload({ "page-session": doc(1, { nodeId: 5, nodeName: "INPUT", attributes: ["type", "text"] }, ...inputs.map(fileInput)) }, index);
      return { result, set: set.map(({ method, params }) => ({ method, params })) };
    };
    const one = await run([11]);
    expect(one.result).toMatchObject({ uploaded: ["cv.pdf"], fileInputs: 1, index: 0 });
    expect(one.set).toEqual([{ method: "DOM.setFileInputFiles", params: { files: ["/w/cv.pdf"], nodeId: 11 } }]);
    const ambiguous = await run([11, 12]);
    expect(String(ambiguous.result)).toMatch(/2 file inputs on this page/);
    expect(ambiguous.set).toEqual([]);
    expect((await run([11, 12], 1)).set[0]?.params?.nodeId).toBe(12);
    expect(String((await run([])).result)).toMatch(/No file input/);
    expect(String((await run([11], 3)).result)).toMatch(/index 3 is past them/);
  });

  // 27/11 (Azure portal support request): the upload dialog's input is in a cross-site iframe, which runs as its own target.
  it("finds file inputs inside same-process iframes, shadow roots and out-of-process iframes, and lets every frame go", async () => {
    const documents = {
      "page-session": doc(1,
        { nodeId: 10, nodeName: "IFRAME", frameId: "frame:same", contentDocument: doc(20, { nodeId: 22, nodeName: "DIV", shadowRoots: [{ nodeId: 23, nodeName: "#document-fragment", children: [fileInput(24)] }] }) },
        { nodeId: 11, nodeName: "IFRAME", frameId: "frame:support" }),
      "session:frame:support": doc(1, { nodeId: 3, nodeName: "IFRAME", frameId: "frame:gone" }, fileInput(7))
    };
    const ambiguous = await upload(documents);
    expect(String(ambiguous.result)).toMatch(/2 file inputs on this page/);
    const { result, set } = await upload(documents, 1);
    expect(result).toMatchObject({ fileInputs: 2, index: 1 });
    expect(set).toEqual([{ method: "DOM.setFileInputFiles", params: { files: ["/w/cv.pdf"], nodeId: 7 }, sessionId: "session:frame:support" }]);
    expect(calls.filter((call) => call.method === "Target.detachFromTarget").map((call) => call.params?.sessionId))
      .toEqual(["session:frame:support", "page-session"]);
    expect((await upload(documents, 0)).set[0]).toMatchObject({ params: { nodeId: 24 }, sessionId: "page-session" });
  });
});
