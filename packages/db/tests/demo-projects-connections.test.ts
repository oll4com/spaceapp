import { describe, expect, it } from "vitest";
import { PostgresDemoProjectsRepository } from "../src/index.js";
import type { PgPoolLike, PgQueryResult } from "../src/index.js";

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

/**
 * Fake pool: the real `demo_connections.scopes` column is jsonb and `pg` keeps jsonb
 * values parsed, so the fake hands back whatever JSON shape the caller queued.
 */
function fakePool(rows: unknown[], captured: CapturedQuery[]): PgPoolLike {
  const client = {
    query: async <T = unknown>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>> => {
      captured.push({ sql, params: params ?? [] });
      return { rows: rows as T[], rowCount: rows.length };
    }
  };
  return { ...client, connect: async () => client };
}

function connectionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "demo-connection:one",
    ownerUserId: "user:one",
    provider: "salesforce",
    status: "UNCONFIGURED",
    label: "",
    detail: null,
    clientId: "consumer-key",
    loginUrl: "https://login.salesforce.com",
    scopes: [],
    credentialRef: null,
    connectedAt: null,
    lastRefreshedAt: null,
    lastCheckedAt: null,
    safeErrorCode: null,
    safeErrorMessage: null,
    createdAt: new Date("2026-09-20T15:35:09.000Z"),
    updatedAt: new Date("2026-09-20T15:35:09.000Z"),
    ...overrides
  };
}

function connectionInput(scopes: string[]) {
  return {
    id: "demo-connection:one",
    ownerUserId: "user:one",
    provider: "salesforce" as const,
    status: "CONFIGURED" as const,
    label: "Salesforce account",
    detail: "https://orgfarm-0457c46d43--dev-ed.develop.my.salesforce.com",
    clientId: "consumer-key",
    loginUrl: "https://login.salesforce.com",
    scopes,
    credentialRef: "demo-salesforce-ref",
    connectedAt: "2026-09-20T15:35:09.000Z",
    lastRefreshedAt: null,
    lastCheckedAt: "2026-09-20T15:35:09.000Z",
    safeErrorCode: null,
    safeErrorMessage: null
  };
}

describe("PostgresDemoProjectsRepository connections jsonb handling", () => {
  const scopeParameterIndex = 8;

  it("writes scopes as a JSON document instead of a Postgres array literal", async () => {
    const captured: CapturedQuery[] = [];
    const repository = new PostgresDemoProjectsRepository(fakePool([connectionRow({ scopes: ["api", "refresh_token"] })], captured));

    const record = await repository.upsertConnection(connectionInput(["api", "refresh_token"]));

    const scopesParameter = captured[0]!.params[scopeParameterIndex];
    // A raw array would be rendered as `{api,refresh_token}` and Postgres would store it
    // as a jsonb object (or reject it), which is what produced `row.scopes is not iterable`.
    expect(typeof scopesParameter).toBe("string");
    expect(scopesParameter).toBe('["api","refresh_token"]');
    expect(JSON.parse(scopesParameter as string)).toEqual(["api", "refresh_token"]);
    expect(record.scopes).toEqual(["api", "refresh_token"]);
  });

  it("writes an empty scopes list as an empty JSON array", async () => {
    const captured: CapturedQuery[] = [];
    const repository = new PostgresDemoProjectsRepository(fakePool([connectionRow()], captured));

    await repository.upsertConnection(connectionInput([]));

    expect(captured[0]!.params[scopeParameterIndex]).toBe("[]");
  });

  it("reads a legacy jsonb object without failing the whole request", async () => {
    const captured: CapturedQuery[] = [];
    const repository = new PostgresDemoProjectsRepository(fakePool([connectionRow({ scopes: {} })], captured));

    const [connection] = await repository.listConnections("user:one");

    expect(connection?.scopes).toEqual([]);
    expect(connection?.clientId).toBe("consumer-key");
  });

  it("recovers scope names from the object shape the array-literal bug produced", async () => {
    const captured: CapturedQuery[] = [];
    const repository = new PostgresDemoProjectsRepository(
      fakePool([connectionRow({ scopes: { api: null, refresh_token: null } })], captured)
    );

    const connection = await repository.getConnection("user:one", "salesforce");

    expect(connection?.scopes).toEqual(["api", "refresh_token"]);
  });

  it("keeps a bad row from breaking a healthy sibling row", async () => {
    const captured: CapturedQuery[] = [];
    const repository = new PostgresDemoProjectsRepository(
      fakePool(
        [
          connectionRow({ provider: "salesforce", scopes: {} }),
          connectionRow({ id: "demo-connection:two", provider: "google-sheets", scopes: ["spreadsheets"] })
        ],
        captured
      )
    );

    const connections = await repository.listConnections("user:one");

    expect(connections.map((connection) => [connection.provider, connection.scopes])).toEqual([
      ["salesforce", []],
      ["google-sheets", ["spreadsheets"]]
    ]);
  });
});
