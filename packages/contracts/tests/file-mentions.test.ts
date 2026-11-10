import { describe, expect, it } from "vitest";
import { agentFilesNamedIn, fileMentionFolder, findFileMentions, needsYouFiles } from "../src/file-mentions.js";

const texts = (value: string) => findFileMentions(value).map((mention) => `${mention.kind}:${mention.text}`);

describe("file mentions (nous_msg:8e7e6c25)", () => {
  it("finds Agent File ids and workspace paths, without the punctuation around them", () => {
    expect(texts("Προετοιμασία: nous/job/interview-prep/20261104-axis-global-logic-test.md, see artifact:eunVA-x5EHIv.")).toEqual([
      "path:nous/job/interview-prep/20261104-axis-global-logic-test.md", "artifact:artifact:eunVA-x5EHIv"
    ]);
    expect(texts("(~/agent-workspace/reports/x/report.md) and /var/lib/spaceapp-user/agent-workspace/a/b.json» and /opt/spaceapp/var/nous-workspace/briefs/c.txt")).toEqual([
      "path:~/agent-workspace/reports/x/report.md", "path:/var/lib/spaceapp-user/agent-workspace/a/b.json", "path:/opt/spaceapp/var/nous-workspace/briefs/c.txt"
    ]);
  });

  it("leaves folders, storage URIs and paths elsewhere alone", () => {
    expect(texts("nous/job/ and space-artifact://agent-files/x.md and /etc/passwd.txt and /opt/spaceapp/apps/web/x.ts and ab/nous/x.md")).toEqual([]);
    expect(texts("artifact:short artifact:toolong" + "x".repeat(80))).toEqual([]);
  });

  it("files interview preparation under Documents/Interviews, the rest under Documents/Reports", () => {
    expect(fileMentionFolder("nous/job/interview-prep/a.md")).toBe("Documents/Interviews");
    expect(fileMentionFolder("nous/briefs/a.md", "INTERVIEW")).toBe("Documents/Interviews");
    expect(fileMentionFolder("nous/briefs/a.md")).toBe("Documents/Reports");
  });
});

describe("agentFilesNamedIn (nous_msg:0cb8d563: a card's files as chips)", () => {
  const file = (artifactId: string, name: string, folder: string | null = "Documents/Funding") => ({ artifactId, name, folder, mime: "text/markdown" });
  const files = [
    file("artifact:I2LCjrN6I0I8", "YC W27 founder video script.md"),
    file("artifact:fundDeck0001", "oll4 pitch deck.pdf"),
    file("artifact:B4-bC79BqJTh", "FutureGrid application answers.md", "Documents/Programs"),
    file("artifact:otherFile001", "notes.md", "Documents/Reports")
  ];
  const ids = (text: string) => agentFilesNamedIn(text, files).map((ref) => ref.artifactId);

  it("finds a file by id, by name and by its name without the extension", () => {
    expect(ids("The answers (artifact:B4-bC79BqJTh) are ready.")).toEqual(["artifact:B4-bC79BqJTh"]);
    expect(ids("Read yc w27 founder video script.md first")).toEqual(["artifact:I2LCjrN6I0I8"]);
    expect(ids("The YC W27 founder video script is ready to record.")).toEqual(["artifact:I2LCjrN6I0I8"]);
    expect(ids("no file here, notes.mdx or a mistyped artifact:nothing0000")).toEqual([]);
  });

  it("resolves a folder an item names to the file whose name shares the most words with the text", () => {
    expect(ids("Record the YC video. The script is in Agent Files › Documents/Funding.")).toEqual(["artifact:I2LCjrN6I0I8"]);
    expect(ids("See Agent Files › Documents / Programs for the form.")).toEqual(["artifact:B4-bC79BqJTh"]);
    // Only the folder's own words, nothing to tell its two files apart: no guess.
    expect(ids("It is in Agent Files › Documents/Funding.")).toEqual([]);
    // A file of the folder named elsewhere stands for it.
    expect(ids("oll4 pitch deck.pdf and the video are in Agent Files › Documents/Funding")).toEqual(["artifact:fundDeck0001"]);
    expect(ids("Agent Files › Documents/Fundingx")).toEqual([]);
  });

  it("reads payload.files only as the server wrote them", () => {
    expect(needsYouFiles({ payload: { files: [files[0], "artifact:x", null, { artifactId: 3 }] } })).toEqual([files[0]]);
    expect(needsYouFiles({ payload: {} })).toEqual([]);
  });
});
