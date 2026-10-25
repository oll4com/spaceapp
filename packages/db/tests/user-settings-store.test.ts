import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { defaultUserSettings, type UserSettings } from "@space/contracts";
import { PostgresSpaceStore, type PgClientLike } from "../src/index.js";

class FakeUserSettingsPgClient implements PgClientLike {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  private settingsMap = new Map<string, unknown>();

  async query<R = unknown>(sql: string, values: unknown[] = []): Promise<{ rows: R[]; rowCount: number }> {
    this.calls.push({ sql, values });

    if (sql.includes("FROM user_settings WHERE user_id = $1")) {
      const userId = values[0] as string;
      const settings = this.settingsMap.get(userId);
      return {
        rows: settings ? [{ settings } as R] : [],
        rowCount: settings ? 1 : 0
      };
    }

    if (sql.includes("INSERT INTO user_settings") || sql.includes("UPDATE user_settings SET settings")) {
      const userId = values[0] as string;
      if (sql.includes("DO NOTHING") && this.settingsMap.has(userId)) return { rows: [], rowCount: 0 };
      const settingsJson = values[1] as string;
      this.settingsMap.set(userId, JSON.parse(settingsJson));
      return {
        rows: [],
        rowCount: 1
      };
    }

    return { rows: [], rowCount: 0 };
  }

  // Writes run in a transaction on a pooled client.
  async connect(): Promise<PgClientLike> {
    return this;
  }

  release(): void {}
}

describe("User settings store", () => {
  it("returns default settings in InMemorySpaceStore when none are stored", () => {
    const store = new InMemorySpaceStore();
    const settings = store.getUserSettings("user:alice");
    expect(settings.uiTheme).toBe(defaultUserSettings.uiTheme);
    expect(settings.dateTime.timeZone).toBe("Asia/Bangkok");
    expect(settings.suppressNotifications).toBe(false);
  });

  it("updates and retrieves settings per user in InMemorySpaceStore without bleeding to other users", () => {
    const store = new InMemorySpaceStore();
    store.updateUserSettings("user:alice", {
      uiTheme: "classic",
      suppressNotifications: true,
      dateTime: { timeFormat: "12h" }
    });

    const aliceSettings = store.getUserSettings("user:alice");
    expect(aliceSettings.uiTheme).toBe("classic");
    expect(aliceSettings.suppressNotifications).toBe(true);
    expect(aliceSettings.dateTime.timeFormat).toBe("12h");
    expect(aliceSettings.dateTime.timeZone).toBe("Asia/Bangkok");

    // Bob has defaults
    const bobSettings = store.getUserSettings("user:bob");
    expect(bobSettings.uiTheme).toBe("modern");
    expect(bobSettings.suppressNotifications).toBe(false);
    expect(bobSettings.dateTime.timeFormat).toBe("24h");
  });

  it("persists and reads user settings via PostgresSpaceStore", async () => {
    const fakeClient = new FakeUserSettingsPgClient();
    const store = new PostgresSpaceStore(fakeClient);

    const initial = await store.getUserSettings("user:operator");
    expect(initial.uiTheme).toBe(defaultUserSettings.uiTheme);

    const updated = await store.updateUserSettings("user:operator", {
      uiTheme: "codex",
      voice: {
        language: "el",
        voice: "Fenrir"
      },
      keyboardAutocorrect: {
        soundEnabled: false
      }
    });

    expect(updated.uiTheme).toBe("codex");
    expect(updated.voice.language).toBe("el");
    expect(updated.voice.voice).toBe("Fenrir");
    expect(updated.keyboardAutocorrect.soundEnabled).toBe(false);
    expect(updated.keyboardAutocorrect.enabled).toBe(true);

    const retrieved = await store.getUserSettings("user:operator");
    expect(retrieved.uiTheme).toBe("codex");
    expect(retrieved.voice.language).toBe("el");
    expect(retrieved.keyboardAutocorrect.soundEnabled).toBe(false);
  });

  it("stores, retrieves and merges all per-user cloud sync fields", async () => {
    const store = new InMemorySpaceStore();
    const userId = "user:charlie";

    // 1. Initial partial update
    const firstUpdate = store.updateUserSettings(userId, {
      docksHidden: ["streaming", "tasks"],
      panesHidden: ["vnc"],
      uiZoom: 110,
      worktreeDefaultEnabled: false,
      roomExtraEmptySlots: { "room-a": 2 },
      desktopWidgets: { clock: { enabled: true, x: 20, y: 30 } },
      vibeMusicVolume: 0.8,
      vibeMusicPlaylistLinkId: "playlist-1"
    });

    expect(firstUpdate.docksHidden).toEqual(["streaming", "tasks"]);
    expect(firstUpdate.panesHidden).toEqual(["vnc"]);
    expect(firstUpdate.uiZoom).toBe(110);
    expect(firstUpdate.worktreeDefaultEnabled).toBe(false);
    expect(firstUpdate.roomExtraEmptySlots).toEqual({ "room-a": 2 });
    expect(firstUpdate.desktopWidgets?.clock).toEqual({ enabled: true, x: 20, y: 30 });
    expect(firstUpdate.vibeMusicVolume).toBe(0.8);
    expect(firstUpdate.vibeMusicPlaylistLinkId).toBe("playlist-1");

    // 2. Second update should merge desktopWidgets and roomExtraEmptySlots without overwriting previous keys
    const secondUpdate = store.updateUserSettings(userId, {
      roomExtraEmptySlots: { "room-b": 4 },
      desktopWidgets: { timer: { enabled: true, x: 100, y: 100 } },
      osk: { scale: 1.5 },
      accountFilters: { provider: "codex" }
    });

    expect(secondUpdate.roomExtraEmptySlots).toEqual({ "room-a": 2, "room-b": 4 });
    expect(secondUpdate.desktopWidgets?.clock).toEqual({ enabled: true, x: 20, y: 30 });
    expect(secondUpdate.desktopWidgets?.timer).toEqual({ enabled: true, x: 100, y: 100 });
    expect(secondUpdate.osk).toEqual({ scale: 1.5 });
    expect(secondUpdate.accountFilters).toEqual({ provider: "codex" });
    // Preserves previously set fields
    expect(secondUpdate.docksHidden).toEqual(["streaming", "tasks"]);
    expect(secondUpdate.panesHidden).toEqual(["vnc"]);
    expect(secondUpdate.uiZoom).toBe(110);
    expect(secondUpdate.worktreeDefaultEnabled).toBe(false);
  });
});
