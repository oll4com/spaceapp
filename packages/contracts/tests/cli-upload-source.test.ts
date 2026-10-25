import { describe, expect, it } from "vitest";
import { paneCliUploadSourceSchema } from "../src/schemas.js";

describe("pane CLI upload source", () => {
  it("accepts SCREEN_CAPTURE without changing the existing sources", () => {
    expect(paneCliUploadSourceSchema.options).toEqual([
      "USER_UPLOAD",
      "CLIPBOARD",
      "DROP",
      "SCREEN_CAPTURE"
    ]);
    expect(paneCliUploadSourceSchema.parse("SCREEN_CAPTURE")).toBe("SCREEN_CAPTURE");
  });
});
