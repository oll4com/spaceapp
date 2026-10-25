import { describe, expect, it } from "vitest";
import { cleanTaskText, shortTaskTitle, isSubstantiveTaskRequest, looksLikeCredentialToken, taskRequestFingerprint, titleEchoesRequest } from "../src/task-titles.js";

describe("task title boundaries", () => {
  it("removes the screenshot attachment prefix without losing the task", () => {
    expect(shortTaskTitle("[Image #1] [Image #2] Βελτίωση μενού workspace")).toBe("Βελτίωση μενού workspace");
    expect(shortTaskTitle("αρχείο 1 αρχείο 2 Βελτίωση τίτλων")).toBe("Βελτίωση τίτλων");
  });
  it("removes filenames and transport paths from titles, while keeping prose", () => {
    expect(shortTaskTitle("clipboard-image-1.png screenshot.png Fix workspace menu")).toBe("Fix workspace menu");
    expect(shortTaskTitle("/opt/spaceapp/var/artifacts/cli-uploads/room/pane/upload_123-image.png Fix menu")).toBe("Fix menu");
    expect(shortTaskTitle("README.md")).toBe("");
    expect(shortTaskTitle("[Image #1]", "Task")).toBe("Task");
  });
  it("does not treat actual technical references in descriptions as attachments", () => {
    expect(cleanTaskText("Repair app.ts and migration.sql")).toBe("Repair app.ts and migration.sql");
  });
  it("strips prompt scaffolding and terminal control sequences", () => {
    expect(cleanTaskText('<environment_context>cwd secret location</environment_context>\x1b[31mFix menu\x1b[0m')).toBe("Fix menu");
    expect(cleanTaskText('<image name=[Image #1] path="/private/upload.png">pixels</image> Fix menu')).toBe("Fix menu");
  });
  it("bounds titles by words and Unicode graphemes", () => {
    expect(shortTaskTitle("One two three four five six seven eight")).toBe("One two three four five six");
    expect(Array.from(shortTaskTitle("α".repeat(100))).length).toBe(52);
  });
  it("skips acknowledgements and control messages without skipping short new tasks", () => {
    for (const text of ["συνέχισε!!!", "continue", "ναι", "Ευχαριστώ", "/resume", "git status", "[Image #1]", "# AGENTS.md instructions for /etc\n<INSTRUCTIONS>Read local rules</INSTRUCTIONS>", "Another language model started to solve this problem and produced a summary of its thinking process."]) {
      expect(isSubstantiveTaskRequest(text), text).toBe(false);
    }
    for (const text of ["Fix login", "Διόρθωσε μενού", "συνέχισε και πρόσθεσε δοκιμές"]) {
      expect(isSubstantiveTaskRequest(text), text).toBe(true);
    }
  });
  it("never treats a lone pasted login code, key or hash as a task", () => {
    const fakeOauthCode = "Q7wErTy12UiOp34AsDfGh56JkLzX78cVbNm90QwErTyU#Zx12Cv34Bn56Mq78Wd90EfGhIjKl-Mn_OpQrStUvWx";
    for (const text of [fakeOauthCode, "sk-ant-api03-AbCdEf123456GhIjKl789012MnOp", "0365298c0f3979d60e4b4d82b1078d5f8bff8336"]) {
      expect(looksLikeCredentialToken(text), text).toBe(true);
      expect(isSubstantiveTaskRequest(text), text).toBe(false);
    }
    for (const text of ["Fix login for clipboard:3tVTUEaY7m9V", "apps/web/src/features/terminal-pane/CliPlansMenu.tsx", "Διόρθωσε το μενού των πλάνων"]) {
      expect(looksLikeCredentialToken(text), text).toBe(false);
    }
    expect(isSubstantiveTaskRequest("Fix login for clipboard:3tVTUEaY7m9V")).toBe(true);
  });
  it("deduplicates attachment prefixes and punctuation variants", () => {
    expect(taskRequestFingerprint("[Image #1] Fix menu!")).toBe(taskRequestFingerprint("Fix menu"));
  });
});

describe("CLI saved titles and quoted uploads", () => {
  it("treats a saved title that only repeats the prompt as no title", () => {
    expect(titleEchoesRequest("Repair workspace navigation", ["Repair workspace navigation now"])).toBe(true);
    expect(titleEchoesRequest("Repair workspace…", ["Repair workspace navigation"])).toBe(true);
    expect(titleEchoesRequest("Workspace navigation fix", ["Repair workspace navigation"])).toBe(false);
    expect(titleEchoesRequest("", ["Repair workspace navigation"])).toBe(true);
  });
  it("removes quoted upload paths without leaving the quotes behind", () => {
    const path = "/opt/spaceapp/var/artifacts/cli-uploads/room_a/pane_b/s/2026-10-12/upload_x-clipboard-image-1.png";
    expect(cleanTaskText(`'${path}' φτιάξε αυτό`)).toBe("φτιάξε αυτό");
    expect(cleanTaskText(`"${path}"`)).toBe("");
  });
});
