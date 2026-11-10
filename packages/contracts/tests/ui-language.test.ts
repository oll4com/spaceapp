import { describe, expect, it } from "vitest";
import { acceptLanguages, agentLanguageOf, uiLanguageOf, updateUserSettingsInputSchema, userSettingsSchema } from "../src/index.js";

describe("UI language (operator 1/11 11:59 BKK)", () => {
  it("is the operator's choice, else Voice input's Greek, else English", () => {
    expect(uiLanguageOf({ uiLanguage: "el" })).toBe("el");
    expect(uiLanguageOf({ uiLanguage: "en", voice: { language: "el" } })).toBe("en");
    expect(uiLanguageOf({ voice: { language: "el" } })).toBe("el");
    expect([uiLanguageOf({ voice: { language: "auto" } }), uiLanguageOf({ uiLanguage: "fr" }), uiLanguageOf(null)]).toEqual(["en", "en", "en"]);
  });

  it("follows a browser that lists Greek first while Voice input is Auto or unset (nous_msg:40900116)", () => {
    expect(uiLanguageOf({ voice: { language: "auto" } }, ["el-GR", "en-US"])).toBe("el");
    expect(uiLanguageOf({}, acceptLanguages("el,en;q=0.9"))).toBe("el");
    expect(uiLanguageOf({ voice: { language: "auto" } }, ["en-US", "el-GR"])).toBe("en");
    expect(uiLanguageOf({ voice: { language: "en" } }, ["el-GR"])).toBe("en");
    expect(uiLanguageOf({ uiLanguage: "en", voice: { language: "auto" } }, ["el-GR"])).toBe("en");
    expect(uiLanguageOf({ voice: { language: "auto" } }, ["ell"])).toBe("en");
    expect(acceptLanguages("el-GR,el;q=0.9, en;q=0.8")).toEqual(["el-GR", "el", "en"]);
    expect(acceptLanguages(undefined)).toEqual([]);
  });

  it("is a user setting: saved as en or el, an unknown stored value reads as unset", () => {
    expect(updateUserSettingsInputSchema.parse({ uiLanguage: "el" })).toEqual({ uiLanguage: "el" });
    expect(updateUserSettingsInputSchema.safeParse({ uiLanguage: "fr" }).success).toBe(false);
    expect(userSettingsSchema.parse({ uiLanguage: "fr" }).uiLanguage).toBeUndefined();
  });

  it("splits the agents' language from the interface's (operator 2/11 09:51 BKK); unset, it is the interface language", () => {
    expect([uiLanguageOf({ uiLanguage: "en", agentLanguage: "el" }), agentLanguageOf({ uiLanguage: "en", agentLanguage: "el" })]).toEqual(["en", "el"]);
    expect(agentLanguageOf({ uiLanguage: "el" })).toBe("el");
    expect(agentLanguageOf({ voice: { language: "auto" } }, ["el-GR"])).toBe("el");
    expect([agentLanguageOf({ agentLanguage: "fr" }), agentLanguageOf(null)]).toEqual(["en", "en"]);
    expect(updateUserSettingsInputSchema.parse({ uiLanguage: "en", agentLanguage: "el" })).toEqual({ uiLanguage: "en", agentLanguage: "el" });
    expect(userSettingsSchema.parse({ agentLanguage: "fr" }).agentLanguage).toBeUndefined();
  });
});
