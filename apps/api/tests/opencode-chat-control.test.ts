import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenCodeChatControl } from "../src/opencode-chat-control.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const unavailable = (message: string) => ({ errorCode: "OPENCODE_SESSION_CONTROL_UNAVAILABLE", message });

describe("OpenCode Chat control", () => {
  it("never reaches stable's OpenCode from dev", async () => {
    const chat = createOpenCodeChatControl({}, { instance: "dev" } as any, {} as any);
    const refusal = unavailable("OpenCode Chat is unavailable on dev: it runs only on the stable instance.");
    await expect(chat.resolveChatOpenCodeCatalogControl()).rejects.toMatchObject(refusal);
    await expect(chat.resolveChatPaneOpenCodeControl("agent_session:abc")).rejects.toMatchObject(refusal);
  });

  it("refuses a malformed agent session and a missing shared server", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "opencode-chat-"));
    roots.push(stateRoot);
    const chat = createOpenCodeChatControl({ opencodeStateRoot: stateRoot }, { instance: "stable" } as any, {} as any);
    await expect(chat.resolveChatPaneOpenCodeControl("../etc/passwd"))
      .rejects.toMatchObject(unavailable("OpenCode Chat requires a valid isolated Space agent session."));
    await expect(chat.resolveChatOpenCodeCatalogControl())
      .rejects.toMatchObject(unavailable("Live OpenCode model control is unavailable; the Chat provider catalog could not be loaded."));
  });
});
