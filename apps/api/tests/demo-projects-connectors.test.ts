import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryDemoProjectsRepository, type DemoProjectsRepository } from "@space/db";
import { DemoCredentialStore } from "../src/demo-projects/credentials.js";
import { DemoProjectsService } from "../src/demo-projects/service.js";

/**
 * Connector behaviour is exercised against a scripted provider: the same code
 * paths (OAuth + PKCE, refresh, ordered Salesforce → Sheets steps, retries,
 * read-back verification) run without touching a real org or spreadsheet.
 */
interface FakeProviderState {
  accounts: Array<{ Id: string; Name: string; CreatedDate: string }>;
  contacts: Array<{ Id: string; LastName: string; FirstName?: string; AccountId: string; Name: string }>;
  sheetRows: string[][];
  createdAccounts: number;
  createdContacts: number;
  appendedRows: number;
  failNextAppend: boolean;
  refreshGrant: "ok" | "invalid_grant";
  tokenRequests: number;
}

function createFakeProviders(): { fetchImpl: typeof fetch; state: FakeProviderState } {
  const state: FakeProviderState = {
    accounts: [{ Id: "001EXISTING0000001", Name: "Existing Account", CreatedDate: "2026-09-01T10:00:00.000Z" }],
    contacts: [],
    sheetRows: [],
    createdAccounts: 0,
    createdContacts: 0,
    appendedRows: 0,
    failNextAppend: false,
    refreshGrant: "ok",
    tokenRequests: 0
  };

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : "";

    if (url.startsWith("https://login.salesforce.com/services/oauth2/token")) {
      state.tokenRequests += 1;
      const grant = new URLSearchParams(body).get("grant_type");
      if (grant === "refresh_token") {
        if (state.refreshGrant === "invalid_grant") {
          return json({ error: "invalid_grant", error_description: "expired refresh token" }, 400);
        }
        return json({ access_token: "REFRESHED-ACCESS-TOKEN", instance_url: "https://demo.my.salesforce.com", issued_at: String(Date.now()) });
      }
      return json({
        access_token: "ACCESS-TOKEN-0001",
        refresh_token: "REFRESH-TOKEN-0001",
        instance_url: "https://demo.my.salesforce.com",
        id: "https://login.salesforce.com/id/00D000000000001/005000000000001",
        scope: "api refresh_token openid",
        token_type: "Bearer"
      });
    }
    if (url.startsWith("https://login.salesforce.com/services/oauth2/revoke")) return new Response("", { status: 200 });
    if (url === "https://demo.my.salesforce.com/services/oauth2/userinfo") {
      return json({ name: "Demo Developer Org", preferred_username: "demo@example.com", organization_id: "00D000000000001" });
    }
    if (url.startsWith("https://demo.my.salesforce.com/services/data/")) {
      const apiPath = url.slice("https://demo.my.salesforce.com/services/data/v60.0".length);
      if (apiPath.startsWith("/query")) {
        const query = new URL(url).searchParams.get("q") ?? "";
        if (query.includes("COUNT()")) return json({ totalSize: state.accounts.length });
        return json({
          totalSize: state.accounts.length,
          records: state.accounts.map((account) => ({
            Id: account.Id,
            Name: account.Name,
            CreatedDate: account.CreatedDate,
            Contacts: { records: state.contacts.filter((contact) => contact.AccountId === account.Id) }
          }))
        });
      }
      if (apiPath === "/sobjects/Account" && method === "POST") {
        state.createdAccounts += 1;
        const payload = JSON.parse(body) as { Name: string };
        const id = `001CREATED${String(state.createdAccounts).padStart(9, "0")}`;
        state.accounts.unshift({ Id: id, Name: payload.Name, CreatedDate: new Date().toISOString() });
        return json({ id, success: true });
      }
      if (apiPath === "/sobjects/Contact" && method === "POST") {
        state.createdContacts += 1;
        const payload = JSON.parse(body) as { LastName: string; FirstName?: string; AccountId: string };
        const id = `003CREATED${String(state.createdContacts).padStart(9, "0")}`;
        state.contacts.unshift({
          Id: id,
          LastName: payload.LastName,
          FirstName: payload.FirstName,
          AccountId: payload.AccountId,
          Name: [payload.FirstName, payload.LastName].filter(Boolean).join(" ")
        });
        return json({ id, success: true });
      }
      const accountRead = /^\/sobjects\/Account\/([A-Za-z0-9]+)$/.exec(apiPath);
      if (accountRead) {
        const account = state.accounts.find((candidate) => candidate.Id === accountRead[1]);
        return account ? json({ Id: account.Id, Name: account.Name }) : json([{ message: "not found", errorCode: "NOT_FOUND" }], 404);
      }
      const contactRead = /^\/sobjects\/Contact\/([A-Za-z0-9]+)$/.exec(apiPath);
      if (contactRead) {
        const contact = state.contacts.find((candidate) => candidate.Id === contactRead[1]);
        return contact ? json({ Id: contact.Id, Name: contact.Name, FirstName: contact.FirstName, LastName: contact.LastName }) : json([{ message: "not found", errorCode: "NOT_FOUND" }], 404);
      }
      return json([{ message: `unhandled ${apiPath}`, errorCode: "UNHANDLED" }], 404);
    }

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const grant = new URLSearchParams(body).get("grant_type");
      return json({
        access_token: grant === "refresh_token" ? "GOOGLE-REFRESHED" : "GOOGLE-ACCESS",
        refresh_token: "GOOGLE-REFRESH-TOKEN",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/spreadsheets openid email",
        id_token: `x.${Buffer.from(JSON.stringify({ email: "demo@example.com" })).toString("base64url")}.y`
      });
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("", { status: 200 });
    if (url.startsWith("https://sheets.googleapis.com/v4/spreadsheets")) {
      const apiPath = url.slice("https://sheets.googleapis.com/v4".length);
      if (apiPath === "/spreadsheets" && method === "POST") {
        return json({
          spreadsheetId: "SHEET-CREATED-0001",
          properties: { title: "Space Demo Projects" },
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/SHEET-CREATED-0001/edit",
          sheets: [{ properties: { title: "Demo Sync" } }]
        });
      }
      if (/^\/spreadsheets\/[^/]+\?/.test(apiPath) && method === "GET") {
        return json({
          spreadsheetId: "SHEET-0001ABCDEFGHIJKLMNOPQRSTUVWXYZ",
          properties: { title: "Salesforce sync (demo)" },
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/SHEET-0001/edit",
          sheets: [{ properties: { title: "Sheet1" } }]
        });
      }
      if (apiPath.includes(":append")) {
        if (state.failNextAppend) {
          state.failNextAppend = false;
          return json({ error: { status: "INTERNAL", message: "temporary failure" } }, 503);
        }
        const payload = JSON.parse(body) as { values: string[][] };
        const row = payload.values[0] ?? [];
        state.sheetRows.push(row);
        state.appendedRows += 1;
        const rowNumber = state.sheetRows.length + 1;
        return json({ updates: { updatedRange: `Sheet1!A${rowNumber}:I${rowNumber}`, updatedRows: 1, updatedCells: row.length } });
      }
      if (apiPath.includes("/values/") && method === "GET") {
        const range = decodeURIComponent(new URL(url).pathname.split("/values/")[1] ?? "");
        if (range === "Sheet1!A1:I1") {
          return json({ values: [["Operation ID", "Created At", "Account ID", "Account Name", "Contact ID", "Contact Name", "Email", "Project", "Variant"]] });
        }
        if (range === "Sheet1!A1:A") {
          return json({ values: state.sheetRows.length > 0 ? state.sheetRows.map((row) => [row[0] ?? ""]) : [] });
        }
        const rowMatch = /^Sheet1!A(\d+):I\1$/.exec(range);
        if (rowMatch) {
          const index = Number(rowMatch[1]) - 2;
          const row = state.sheetRows[index];
          return json({ values: row ? [row] : [] });
        }
        return json({ values: [] });
      }
      if (apiPath.includes("/values/") && method === "PUT") return json({});
      return json({ error: { status: "NOT_FOUND", message: `unhandled ${apiPath}` } }, 404);
    }
    throw new Error(`Unhandled provider URL in the test double: ${method} ${url}`);
  }) as typeof fetch;

  return { fetchImpl, state };
}

interface ConnectorContext {
  root: string;
  repository: DemoProjectsRepository;
  credentialStore: DemoCredentialStore;
  service: DemoProjectsService;
  provider: ReturnType<typeof createFakeProviders>;
}

async function createContext(): Promise<ConnectorContext> {
  const root = await mkdtemp(join(tmpdir(), "space-demo-connectors-"));
  const repository = new InMemoryDemoProjectsRepository();
  const credentialStore = new DemoCredentialStore(join(root, "secrets"));
  const provider = createFakeProviders();
  const service = new DemoProjectsService({
    repository,
    credentialStore,
    demoRoot: join(root, "demos"),
    varRoot: join(root, "var"),
    apiPort: 1,
    publicOrigin: "https://space.example",
    portRangeStart: 51_700,
    portRangeEnd: 51_760,
    healthTimeoutMs: 1_000,
    fetchImpl: provider.fetchImpl
  });
  await service.initialize();
  return { root, repository, credentialStore, service, provider };
}

const owner = "user:connector";

async function connectSalesforce(context: ConnectorContext): Promise<void> {
  await context.service.connections.saveSettings(owner, "salesforce", {
    clientId: "3MVG9DEMOCLIENTID",
    clientSecret: "demo-client-secret",
    loginUrl: "https://login.salesforce.com"
  });
  const started = await context.service.connections.startOAuth({
    ownerUserId: owner,
    provider: "salesforce",
    sessionToken: "session-token",
    publicOrigin: "https://space.example"
  });
  const authorizationUrl = new URL(started.authorizationUrl);
  expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorizationUrl.searchParams.get("scope")).toContain("refresh_token");
  await context.service.connections.completeOAuth({
    provider: "salesforce",
    code: "authorization-code",
    state: authorizationUrl.searchParams.get("state")!,
    sessionToken: "session-token",
    publicOrigin: "https://space.example"
  });
}

async function connectGoogle(context: ConnectorContext): Promise<void> {
  await context.service.connections.saveSettings(owner, "google-sheets", {
    clientId: "google-client-id.apps.googleusercontent.com",
    clientSecret: "google-client-secret"
  });
  const started = await context.service.connections.startOAuth({
    ownerUserId: owner,
    provider: "google-sheets",
    sessionToken: "session-token",
    publicOrigin: "https://space.example"
  });
  const authorizationUrl = new URL(started.authorizationUrl);
  expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
  expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
  await context.service.connections.completeOAuth({
    provider: "google-sheets",
    code: "authorization-code",
    state: authorizationUrl.searchParams.get("state")!,
    sessionToken: "session-token",
    publicOrigin: "https://space.example"
  });
}

let context: ConnectorContext | null = null;

beforeEach(async () => {
  context = await createContext();
});

afterEach(async () => {
  if (!context) return;
  await context.service.dispose();
  await rm(context.root, { recursive: true, force: true });
  context = null;
});

describe("demo connector OAuth", () => {
  it("completes Salesforce and Google consent, storing tokens encrypted", async () => {
    await connectSalesforce(context!);
    await connectGoogle(context!);
    const connections = await context!.service.connections.listConnections(owner, "https://space.example");
    const salesforce = connections.find((connection) => connection.provider === "salesforce");
    const google = connections.find((connection) => connection.provider === "google-sheets");
    expect(salesforce).toMatchObject({ status: "CONNECTED", label: "Demo Developer Org", detail: "https://demo.my.salesforce.com" });
    expect(google).toMatchObject({ status: "CONNECTED", label: "demo@example.com" });

    const record = await context!.repository.getConnection(owner, "salesforce");
    const payload = await context!.credentialStore.read(record!.credentialRef!);
    expect(payload).toMatchObject({ refreshToken: "REFRESH-TOKEN-0001", clientSecret: "demo-client-secret" });
    expect(JSON.stringify(connections)).not.toContain("REFRESH-TOKEN-0001");
    expect(JSON.stringify(connections)).not.toContain("demo-client-secret");
  });

  it("refreshes an expired access token and flags a revoked refresh token", async () => {
    await connectSalesforce(context!);
    const record = await context!.repository.getConnection(owner, "salesforce");
    const reference = record!.credentialRef!;
    const payload = await context!.credentialStore.read(reference);
    await context!.credentialStore.write(reference, { ...payload, expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const credentials = await context!.service.connections.salesforceCredentials(owner);
    expect(credentials.accessToken).toBe("REFRESHED-ACCESS-TOKEN");

    await context!.credentialStore.write(reference, { ...payload, expiresAt: new Date(Date.now() - 60_000).toISOString() });
    context!.provider.state.refreshGrant = "invalid_grant";
    await expect(context!.service.connections.salesforceCredentials(owner)).rejects.toMatchObject({ code: "DEMO_SALESFORCE_RECONNECT" });
    const refreshed = await context!.repository.getConnection(owner, "salesforce");
    expect(refreshed?.status).toBe("NEEDS_RECONNECT");
    expect(refreshed?.safeErrorCode).toBe("SALESFORCE_REFRESH_REVOKED");
  });

  it("rejects a callback that does not match the browser session", async () => {
    await connectSalesforce(context!);
    const started = await context!.service.connections.startOAuth({
      ownerUserId: owner,
      provider: "salesforce",
      sessionToken: "session-token",
      publicOrigin: "https://space.example"
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await expect(
      context!.service.connections.completeOAuth({
        provider: "salesforce",
        code: "authorization-code",
        state,
        sessionToken: "another-session",
        publicOrigin: "https://space.example"
      })
    ).rejects.toMatchObject({ code: "DEMO_OAUTH_STATE_INVALID" });
  });
});

describe("demo connector operations", () => {
  it("creates Account → Contact → Sheets row once and verifies the row by read-back", async () => {
    await connectSalesforce(context!);
    await connectGoogle(context!);
    const sheets = await context!.service.operations.selectSheetsTarget(owner, { spreadsheet: "SHEET-0001ABCDEFGHIJKLMNOPQRSTUVWXYZ", tab: "Sheet1" });
    expect(sheets.headerPresent).toBe(true);

    const created = await context!.service.operations.createOperation({
      ownerUserId: owner,
      projectId: "project-1-salesforce-crm",
      variantId: "javascript-react-node",
      mode: "LIVE",
      operation: { operationKey: "ui-test-operation-1", accountName: "Space Demo Account", contactLastName: "Tester", firstName: "Ada", email: "ada@example.com" }
    });
    expect(created.created).toBe(true);
    await context!.service.operations.processPending(5);
    const processed = await context!.repository.getOperation(created.operation.id);
    expect(processed?.status).toBe("SYNCED");
    expect(processed?.salesforceAccountId).toMatch(/^001CREATED/);
    expect(processed?.salesforceContactId).toMatch(/^003CREATED/);
    expect(processed?.sheetsRow).toBe(2);
    expect(processed?.sheetsVerifiedAt).toBeTruthy();
    expect(processed?.steps.map((step) => step.status)).toEqual(["DONE", "DONE", "DONE"]);
    expect(context!.provider.state.sheetRows[0]?.[0]).toBe("ui-test-operation-1");
    expect(context!.provider.state.sheetRows[0]?.[2]).toBe(processed?.salesforceAccountId);
    expect(context!.provider.state.createdAccounts).toBe(1);
  });

  it("treats a repeated submit as the same operation", async () => {
    await connectSalesforce(context!);
    await connectGoogle(context!);
    await context!.service.operations.selectSheetsTarget(owner, { spreadsheet: "SHEET-0001ABCDEFGHIJKLMNOPQRSTUVWXYZ", tab: "Sheet1" });
    const input = {
      ownerUserId: owner,
      projectId: "project-1-salesforce-crm",
      variantId: "javascript-react-node" as const,
      mode: "LIVE" as const,
      operation: { operationKey: "ui-duplicate-operation", accountName: "Duplicate Account", contactLastName: "Tester" }
    };
    const first = await context!.service.operations.createOperation(input);
    await context!.service.operations.processPending(5);
    const second = await context!.service.operations.createOperation(input);
    await context!.service.operations.processPending(5);
    expect(second.created).toBe(false);
    expect(second.operation.id).toBe(first.operation.id);
    expect(context!.provider.state.createdAccounts).toBe(1);
    expect(context!.provider.state.appendedRows).toBe(1);
  });

  it("keeps the created ids and retries only the failed Sheets step", async () => {
    await connectSalesforce(context!);
    await connectGoogle(context!);
    await context!.service.operations.selectSheetsTarget(owner, { spreadsheet: "SHEET-0001ABCDEFGHIJKLMNOPQRSTUVWXYZ", tab: "Sheet1" });
    context!.provider.state.failNextAppend = true;
    const created = await context!.service.operations.createOperation({
      ownerUserId: owner,
      projectId: "project-1-salesforce-crm",
      variantId: "javascript-react-node",
      mode: "LIVE",
      operation: { operationKey: "ui-retry-operation", accountName: "Retry Account", contactLastName: "Tester" }
    });
    await context!.service.operations.processPending(5);
    const partial = await context!.repository.getOperation(created.operation.id);
    expect(partial?.status).toBe("PARTIAL");
    expect(partial?.salesforceAccountId).toBeTruthy();
    expect(partial?.salesforceContactId).toBeTruthy();
    expect(partial?.sheetsRow).toBeNull();
    expect(partial?.nextAttemptAt).toBeTruthy();

    await context!.service.operations.retryOperation(owner, created.operation.id, { attemptNow: true });
    await context!.service.operations.processPending(5);
    const synced = await context!.repository.getOperation(created.operation.id);
    expect(synced?.status).toBe("SYNCED");
    expect(synced?.sheetsRow).toBe(2);
    expect(context!.provider.state.createdAccounts).toBe(1);
    expect(context!.provider.state.createdContacts).toBe(1);
    expect(context!.provider.state.appendedRows).toBe(1);
  });

  it("lists real accounts and merges the local operation ids", async () => {
    await connectSalesforce(context!);
    await connectGoogle(context!);
    await context!.service.operations.selectSheetsTarget(owner, { spreadsheet: "SHEET-0001ABCDEFGHIJKLMNOPQRSTUVWXYZ", tab: "Sheet1" });
    const created = await context!.service.operations.createOperation({
      ownerUserId: owner,
      projectId: "project-1-salesforce-crm",
      variantId: "javascript-react-node",
      mode: "LIVE",
      operation: { operationKey: "ui-list-operation", accountName: "Listed Account", contactLastName: "Tester" }
    });
    await context!.service.operations.processPending(5);
    const accounts = await context!.service.operations.listAccounts({
      ownerUserId: owner,
      variantId: "javascript-react-node",
      mode: "LIVE",
      search: "",
      page: 1,
      pageSize: 10
    });
    expect(accounts.source).toBe("salesforce");
    const createdAccount = accounts.data.find((account) => account.name === "Listed Account");
    expect(createdAccount?.id).toBe((await context!.repository.getOperation(created.operation.id))?.salesforceAccountId);
    expect(createdAccount?.contactId).toMatch(/^003CREATED/);
  });

  it("refuses live accounts for a sample run", async () => {
    await expect(
      context!.service.operations.listAccounts({ ownerUserId: owner, variantId: "javascript-react-node", mode: "SAMPLE", page: 1, pageSize: 10 })
    ).rejects.toMatchObject({ code: "DEMO_SAMPLE_LOCAL" });
  });
});
