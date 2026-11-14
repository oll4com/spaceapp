// Shared by every copilot MCP, including the ones without a browser tool catalog. Only metadata crosses this bridge.
const nullable = (maxLength) => ({type: ["string", "null"], maxLength});
const key = {site: {type: "string", minLength: 1, maxLength: 2000}, accountLabel: {type: "string", maxLength: 100, description: "Only for a second account on the same site; omit for the main one. Another label is a separate record that get returns only for that same label."}};
export const siteSigninTools = [
  {name: "space_site_signin_get", description: "Before signing in, read the owner's shared site recipe: method, SSO account, browser profile, site email, Vault handle, mail route and MFA. Site can be a domain or URL. Its googleAccountEmail is the Google account the pane browser opens the site in (never the pane's default account).",
    inputSchema: {type: "object", properties: key, required: ["site"], additionalProperties: false}},
  {name: "space_site_signin_record", description: "Always record SUCCESS after confirming sign-in, FAILURE when it fails, and CHANGED in the same turn after an account/email/password/MFA/mailbox/profile change. Omitted fields keep known facts; null clears one. Never send a password, code, cookie, security answer or key value: only Vault handles. PENDING is an unconfirmed submission.",
    inputSchema: {type: "object", properties: {...key, outcome: {type: "string", enum: ["SUCCESS", "FAILURE", "CHANGED", "PENDING"]},
      method: {type: "string", enum: ["GOOGLE", "APPLE", "LINKEDIN", "GITHUB", "MICROSOFT", "VAULT_LOGIN", "EMAIL_CODE", "OTHER"]},
      googleAccountEmail: nullable(320), browserProfileId: nullable(200), siteAccountEmail: nullable(320), username: nullable(320), vaultHandle: nullable(200),
      mailbox: nullable(500), mfa: nullable(200), notes: nullable(500), reason: nullable(500)}, required: ["site", "outcome"], additionalProperties: false}}
];
export const isSiteSigninTool = (name) => siteSigninTools.some((tool) => tool.name === name);
export async function callSiteSigninTool(name, args, env = process.env) {
  const base = env.SPACE_BROWSER_COMMAND_ENDPOINT || env.SPACE_BROWSER_ACTION_ENDPOINT || Object.entries(env).find(([key, value]) => key.startsWith("SPACE_") && key.endsWith("_ENDPOINT") && value?.includes("/api/cli/"))?.[1];
  const token = env.SPACE_BROWSER_ACTION_TOKEN;
  if (!base || !token) throw new Error("Space site sign-in bridge is unavailable for this pane.");
  const url = new URL("/api/cli/site-signins", base);
  const get = name === "space_site_signin_get";
  if (get) for (const [key, value] of Object.entries(args)) if (value != null) url.searchParams.set(key, String(value));
  const response = await fetch(url, {method: get ? "GET" : "POST", headers: {"content-type": "application/json", "x-space-cli-browser-token": token},
    ...(!get ? {body: JSON.stringify(args)} : {}), signal: AbortSignal.timeout(30000)});
  const payload = await response.json();
  if (!response.ok) throw new Error(refusalText(payload, `Site sign-in request failed (${response.status}).`));
  return payload;
}
/** The API's refusal with the fields its validation named (also the browser bridge's): 13/11 affiliate sign-ups saw a bare
 * "Invalid request data." for loginUrl, a method off the list and tab_close's tabId. */
export function refusalText(payload, fallback) {
  const {formErrors = [], fieldErrors = {}} = payload?.error?.details ?? {};
  const why = [...formErrors, ...Object.entries(fieldErrors).map(([field, errors]) => `${field}: ${[errors].flat().join(", ")}`)].join("; ");
  return `${payload?.error?.message || payload?.message || fallback}${why ? ` ${why}. Nothing was done.` : ""}`;
}
