import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret } from "../src/databases/crypto.js";
import { SqliteAdapter } from "../src/databases/sqlite-adapter.js";

describe("Database Subsystem - Crypto", () => {
  const previousSecret = process.env.SPACE_SESSION_SECRET;
  beforeEach(() => { process.env.SPACE_SESSION_SECRET = "databases-crypto-test-secret"; });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.SPACE_SESSION_SECRET;
    else process.env.SPACE_SESSION_SECRET = previousSecret;
  });

  it("encrypts and decrypts secrets with AES-256-GCM properly", () => {
    const original = "super-secret-password-12345!@#$";
    const encrypted = encryptSecret(original);
    expect(encrypted).not.toBe(original);
    expect(encrypted).toContain(":");

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(original);
  });

  it("handles empty or falsy inputs gracefully", () => {
    expect(encryptSecret("")).toBe("");
    expect(decryptSecret("")).toBe("");
  });

  // Review F6/F7 (2026-10-14): purpose-bound key, legacy payloads still readable, no silent blank password.
  it("reads payloads written with the legacy key", () => {
    const iv = randomBytes(12);
    const key = createHash("sha256").update("databases-crypto-test-secret").digest();
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update("legacy-password", "utf8"), cipher.final()]);
    const legacy = JSON.stringify({ iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") });
    expect(decryptSecret(legacy)).toBe("legacy-password");
    expect(JSON.parse(encryptSecret("legacy-password")).v).toBe(2);
  });

  it("fails loudly when the secret changed or is missing", () => {
    const encrypted = encryptSecret("stored-password");
    process.env.SPACE_SESSION_SECRET = "another-installation-secret";
    expect(() => decryptSecret(encrypted)).toThrow(/CREDENTIAL_UNREADABLE/);
    delete process.env.SPACE_SESSION_SECRET;
    expect(() => encryptSecret("stored-password")).toThrow(/SPACE_SESSION_SECRET/);
    expect(() => decryptSecret(encrypted)).toThrow(/SPACE_SESSION_SECRET/);
  });
});

describe("Database Subsystem - SQLite Adapter & Worker", () => {
  let tempDir: string;
  let dbPath: string;
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    tempDir = await mkdtemp(join("/tmp", "space-sqlite-test-"));
    dbPath = join(tempDir, "test.sqlite");
    adapter = new SqliteAdapter({ filename: dbPath, isReadOnly: false });
  });

  afterEach(async () => {
    await adapter.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("connects and executes DDL and queries", async () => {
    const testConn = await adapter.testConnection();
    expect(testConn.ok).toBe(true);

    // Create table via executeSql
    await adapter.executeSql({ sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT);" });

    // Insert rows via mutateRow
    await adapter.mutateRow("users", { action: "insert", row: { id: 1, name: "Alice", email: "alice@example.com" } });
    await adapter.mutateRow("users", { action: "insert", row: { id: 2, name: "Bob", email: "bob@example.com" } });

    // Read catalog
    const catalog = await adapter.getCatalog();
    expect(catalog.schemas.length).toBeGreaterThanOrEqual(1);
    const mainSchema = catalog.schemas.find((s) => s.name === "main");
    expect(mainSchema).toBeDefined();
    const usersTable = mainSchema?.tables.find((t) => t.name === "users");
    expect(usersTable).toBeDefined();
    expect(usersTable?.columns.length).toBe(3);

    // Read table data with pagination
    const data = await adapter.getTableData("users", { page: 1, pageSize: 10 });
    expect(data.rows.length).toBe(2);
    expect(data.rows[0].name).toBe("Alice");
    expect(data.totalRows).toBe(2);

    // Update row
    await adapter.mutateRow("users", { action: "update", primaryKey: { id: 1 }, row: { name: "Alice Updated" } });
    const updated = await adapter.getTableData("users", { page: 1, pageSize: 10 });
    expect(updated.rows.find((r) => r.id === 1)?.name).toBe("Alice Updated");

    // Delete row
    await adapter.mutateRow("users", { action: "delete", primaryKey: { id: 2 } });
    const afterDelete = await adapter.getTableData("users", { page: 1, pageSize: 10 });
    expect(afterDelete.rows.length).toBe(1);

    // Execute custom SQL
    const res = await adapter.executeSql({ sql: "SELECT count(*) as cnt FROM users;" });
    expect(res.rows[0].cnt).toBe(1);
  });

  it("enforces read-only mode and blocks mutations", async () => {
    // First create a table with a writable adapter
    await adapter.executeSql({ sql: "CREATE TABLE logs (id INTEGER PRIMARY KEY, message TEXT);" });
    await adapter.mutateRow("logs", { action: "insert", row: { id: 1, message: "init" } });
    await adapter.close();

    // Now open with readOnly = true
    const readOnlyAdapter = new SqliteAdapter({ filename: dbPath, isReadOnly: true });
    try {
      const data = await readOnlyAdapter.getTableData("logs", { page: 1, pageSize: 10 });
      expect(data.rows.length).toBe(1);

      // Attempting to insert must fail
      await expect(
        readOnlyAdapter.mutateRow("logs", { action: "insert", row: { id: 2, message: "fail" } })
      ).rejects.toThrow();

      // Attempting to drop table must fail
      await expect(
        readOnlyAdapter.executeSql({ sql: "DROP TABLE logs;" })
      ).rejects.toThrow();
    } finally {
      await readOnlyAdapter.close();
    }
  });

  it("exports and imports CSV", async () => {
    await adapter.executeSql({ sql: "CREATE TABLE products (sku TEXT PRIMARY KEY, price REAL);" });
    await adapter.mutateRow("products", { action: "insert", row: { sku: "A101", price: 19.99 } });
    await adapter.mutateRow("products", { action: "insert", row: { sku: "B202", price: 49.50 } });

    const csvContent = await adapter.exportData({ tableName: "products", format: "csv" });
    expect(csvContent).toContain('"sku","price"');
    expect(csvContent).toContain('"A101","19.99"');

    // Drop and re-create products
    await adapter.executeSql({ sql: "DROP TABLE products;" });
    await adapter.executeSql({ sql: "CREATE TABLE products (sku TEXT PRIMARY KEY, price REAL);" });

    const importRes = await adapter.importData({ tableName: "products", format: "csv", data: csvContent });
    expect(importRes.importedRows).toBe(2);

    const reimported = await adapter.getTableData("products", { page: 1, pageSize: 10 });
    expect(reimported.rows.length).toBe(2);
  });
});
