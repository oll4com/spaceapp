import { describe, expect, it } from "vitest";
import { PostgresSpaceStore, type PgPoolLike } from "../src/space-store.js";

class CliProfileFakePool implements PgPoolLike {
  calls: { sql: string; values: unknown[] }[] = [];
  private rows: Record<string, unknown>[] = [];
  private profileInUse = false;

  seed(rows: Record<string, unknown>[]) {
    this.rows = rows;
  }

  seedProfileInUse(profileInUse: boolean) {
    this.profileInUse = profileInUse;
  }

  async query<T = unknown>(sql: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number | null }> {
    this.calls.push({ sql, values });
    if (sql.includes("SELECT EXISTS") && sql.includes("FROM pane_cli_sessions")) {
      return { rows: [{ exists: this.profileInUse } as T], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM cli_account_profiles")) {
      const before = this.rows.length;
      this.rows = this.rows.filter((row) => row.profileId !== values[1]);
      return { rows: [], rowCount: before - this.rows.length };
    }
    if (sql.includes("INSERT INTO cli_account_profiles")) {
      const existing = this.rows.find((row) => row.profileId === values[1]);
      const row = {
        runtimeId: values[0],
        profileId: values[1],
        displayName: values[2],
        createdAt: existing?.createdAt ?? "2026-08-13T00:00:00.000Z",
        updatedAt: values[3],
        updatedBy: values[4]
      };
      this.rows = [...this.rows.filter((candidate) => candidate.profileId !== values[1]), row];
      return { rows: [row as T], rowCount: 1 };
    }
    if (sql.includes("FROM cli_account_profiles")) {
      let rows = this.rows.filter((row) => row.runtimeId === values[0]);
      if (sql.includes("profile_id = $2")) {
        rows = rows.filter((row) => row.profileId === values[1]);
      }
      rows = [...rows].sort((left, right) =>
        String(left.createdAt).localeCompare(String(right.createdAt)) ||
        String(left.profileId).localeCompare(String(right.profileId))
      );
      return { rows: rows as T[], rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  }
}

const seedRow = (profileId: string, createdAt: string) => ({
  runtimeId: "cli:gemini",
  profileId,
  displayName: profileId === "main" ? "Main account" : "Work account",
  createdAt,
  updatedAt: createdAt,
  updatedBy: null
});

describe("cli account profiles store", () => {
  it("lists profiles by creation order without a global active account", async () => {
    const pool = new CliProfileFakePool();
    pool.seed([
      seedRow("work", "2026-08-13T00:00:01.000Z"),
      seedRow("main", "2026-08-13T00:00:00.000Z")
    ]);
    const profiles = await new PostgresSpaceStore(pool).listCliAccountProfiles("cli:gemini");
    expect(profiles.map((profile) => profile.profileId)).toEqual(["main", "work"]);
    expect(profiles[0]).not.toHaveProperty("isActive");
  });

  it("upserts any number of independently named profiles", async () => {
    const pool = new CliProfileFakePool();
    const store = new PostgresSpaceStore(pool);
    for (let index = 1; index <= 12; index += 1) {
      await store.createCliAccountProfile(
        "cli:gemini",
        { runtimeId: "cli:gemini", profileId: `account-${index}`, displayName: `Google account ${index}` },
        "user:admin"
      );
    }
    expect(await store.listCliAccountProfiles("cli:gemini")).toHaveLength(12);
  });

  it("reads one profile and reports missing profiles", async () => {
    const pool = new CliProfileFakePool();
    pool.seed([seedRow("work", "2026-08-13T00:00:00.000Z")]);
    const store = new PostgresSpaceStore(pool);
    expect((await store.getCliAccountProfile("cli:gemini", "work"))?.displayName).toBe("Work account");
    expect(await store.getCliAccountProfile("cli:gemini", "missing")).toBeNull();
  });

  it("counts active IDLE or RUNNING pane sessions as profile use", async () => {
    const pool = new CliProfileFakePool();
    pool.seedProfileInUse(true);
    const store = new PostgresSpaceStore(pool);
    expect(await store.isCliAccountProfileInUse("cli:gemini", "work")).toBe(true);
    const query = pool.calls.at(-1)!;
    expect(query.sql).toContain("is_active = true");
    expect(query.sql).toContain("status NOT IN ('EXITED', 'ERROR')");
    expect(query.values).toEqual(["cli:gemini", "work"]);
  });

  it("removes a profile and reports whether it existed", async () => {
    const pool = new CliProfileFakePool();
    pool.seed([seedRow("work", "2026-08-13T00:00:00.000Z")]);
    const store = new PostgresSpaceStore(pool);
    expect(await store.removeCliAccountProfile("cli:gemini", "work")).toBe(true);
    expect(await store.removeCliAccountProfile("cli:gemini", "missing")).toBe(false);
  });
});
