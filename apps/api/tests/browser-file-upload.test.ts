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

  it("sets the one matching file input of the active tab, asks for an index when several match, and always lets the tab go", async () => {
    const run = async (inputs: number[], index?: number) => {
      const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
      const client = {
        send: async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
          calls.push({ method, params });
          if (method === "Target.attachToTarget") return { sessionId: "page-session" } as T;
          if (method === "DOM.getDocument") return { root: { nodeId: 1 } } as T;
          if (method === "DOM.querySelectorAll") return { nodeIds: inputs } as T;
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
});
