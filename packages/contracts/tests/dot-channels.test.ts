import { expect, it } from "vitest";
import { slackAppUrl } from "../src/index.js";

it("links to the direct conversation with a Slack app only for a real app id", () => {
  expect(slackAppUrl("A0123ABCDE")).toBe("https://slack.com/app_redirect?app=A0123ABCDE");
  expect(slackAppUrl(" A0123ABCDE ", "T0123ABCD")).toBe("https://slack.com/app_redirect?app=A0123ABCDE&team=T0123ABCD");
  expect(slackAppUrl("A0123ABCDE", "not a team")).toBe("https://slack.com/app_redirect?app=A0123ABCDE");
  for (const value of [undefined, null, "", "a0123abcde", "A01", "A0123ABCDE&team=T1", "https://evil.example"]) expect(slackAppUrl(value)).toBeNull();
});
