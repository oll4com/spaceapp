import { describe, expect, it } from "vitest";
import { asksForOperatorPrivateData, containsSensitiveDisclosure } from "../src/privacy.js";

describe("public streaming privacy gate", () => {
  it("recognizes personal questions in English and Greek without blocking public product questions", () => {
    expect(asksForOperatorPrivateData("What is the streamer's home address?")).toBe(true);
    expect(asksForOperatorPrivateData("Ποια είναι η διεύθυνσή σου;")).toBe(true);
    expect(asksForOperatorPrivateData("How does SpaceApp store public knowledge?")).toBe(false);
  });

  it("blocks contact details and personal claims before public output", () => {
    expect(containsSensitiveDisclosure("Contact person@example.com")).toBe(true);
    expect(containsSensitiveDisclosure("The streamer lives in Example City.")).toBe(true);
    expect(containsSensitiveDisclosure("Ο παρουσιαστής μένει στην πόλη.")).toBe(true);
    expect(containsSensitiveDisclosure("SpaceApp keeps rooms and panes organized.")).toBe(false);
  });
});
