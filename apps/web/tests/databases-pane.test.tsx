import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { DatabasesPane } from "../src/features/databases-pane/DatabasesPane.js";
import { formatCellDisplay } from "../src/features/databases-pane/DataTab.js";
import type { DatabaseConnection, DatabaseCatalog, DatabaseTableDataResponse } from "@space/contracts";

installSpaceRuntime(liveRuntime);

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe("DatabasesPane Component", () => {
  const mockConnection: DatabaseConnection = {
    id: "conn-space-internal",
    ownerUserId: "system",
    projectPath: null,
    name: "SpaceApp DB (PostgreSQL)",
    engine: "POSTGRES",
    database: "space",
    ssl: false,
    options: {},
    isReadOnly: true,
    isInternal: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const mockCatalog: DatabaseCatalog = {
    currentDatabase: "space",
    engine: "POSTGRES",
    schemas: [
      {
        name: "public",
        tables: [
          {
            name: "rooms",
            schema: "public",
            rowCount: 12,
            columns: [
              { name: "id", type: "text", dataType: "text", nullable: false, isPrimaryKey: true, isAutoIncrement: false },
              { name: "name", type: "text", dataType: "text", nullable: false, isPrimaryKey: false, isAutoIncrement: false }
            ],
            primaryKeys: ["id"],
            foreignKeys: [],
            indexes: []
          }
        ],
        views: []
      }
    ],
    capabilities: {
      schemas: true,
      alterColumn: true,
      dropColumn: true,
      foreignKeys: true,
      indexes: true,
      views: true,
      triggers: true,
      functions: true,
      cancelQuery: true,
      explain: true
    }
  };

  const mockTableData: DatabaseTableDataResponse = {
    columns: [
      { name: "id", type: "text", dataType: "text", nullable: false, isPrimaryKey: true, isAutoIncrement: false },
      { name: "name", type: "text", dataType: "text", nullable: false, isPrimaryKey: false, isAutoIncrement: false }
    ],
    rows: [
      { id: "room-1", name: "General Room" },
      { id: "room-2", name: "Dev Room" }
    ],
    page: 1,
    pageSize: 50,
    totalRows: 2,
    primaryKeys: ["id"],
    isReadOnly: false
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("renders connection list and loads internal space connection", async () => {
    vi.spyOn(liveRuntime.api, "me").mockResolvedValue({ user: { id: "user:1", role: "ADMIN" } } as any);
    vi.spyOn(liveRuntime.api, "databasesListConnections").mockResolvedValue({
      ok: true,
      connections: [mockConnection]
    });
    vi.spyOn(liveRuntime.api, "databasesGetCatalog").mockResolvedValue({
      ok: true,
      catalog: mockCatalog
    });
    vi.spyOn(liveRuntime.api, "databasesGetTableData").mockResolvedValue({
      ok: true,
      ...mockTableData
    });

    render(
      <DatabasesPane
        pane={{
          id: "pane:db-1",
          roomId: "room:test",
          title: "Databases 1",
          mode: "DATABASES"
        } as any}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByText("SpaceApp DB (PostgreSQL)").length).toBeGreaterThan(0);
    });
  });

  it("selects a connection and loads catalog tables", async () => {
    vi.spyOn(liveRuntime.api, "me").mockResolvedValue({ user: { id: "user:1", role: "ADMIN" } } as any);
    vi.spyOn(liveRuntime.api, "databasesListConnections").mockResolvedValue({
      ok: true,
      connections: [mockConnection]
    });
    vi.spyOn(liveRuntime.api, "databasesGetCatalog").mockResolvedValue({
      ok: true,
      catalog: mockCatalog
    });
    vi.spyOn(liveRuntime.api, "databasesGetTableData").mockResolvedValue({
      ok: true,
      ...mockTableData
    });

    render(
      <DatabasesPane
        pane={{
          id: "pane:db-1",
          roomId: "room:test",
          title: "Databases 1",
          mode: "DATABASES"
        } as any}
      />
    );

    // Wait for connection to load and auto-select
    await waitFor(() => {
      expect(screen.getAllByText("SpaceApp DB (PostgreSQL)").length).toBeGreaterThan(0);
    });

    // Verify rooms table is displayed in sidebar
    await waitFor(() => {
      expect(screen.getAllByText("rooms").length).toBeGreaterThan(0);
    });
  });

  it("switches tabs between Data, Structure, and SQL Editor", async () => {
    vi.spyOn(liveRuntime.api, "me").mockResolvedValue({ user: { id: "user:1", role: "ADMIN" } } as any);
    vi.spyOn(liveRuntime.api, "databasesListConnections").mockResolvedValue({
      ok: true,
      connections: [mockConnection]
    });
    vi.spyOn(liveRuntime.api, "databasesGetCatalog").mockResolvedValue({
      ok: true,
      catalog: mockCatalog
    });
    vi.spyOn(liveRuntime.api, "databasesGetTableData").mockResolvedValue({
      ok: true,
      ...mockTableData
    });

    render(
      <DatabasesPane
        pane={{
          id: "pane:db-1",
          roomId: "room:test",
          title: "Databases 1",
          mode: "DATABASES"
        } as any}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByText("rooms").length).toBeGreaterThan(0);
    });

    // Click on Structure tab
    const structureTab = screen.getByRole("tab", { name: "Structure" });
    fireEvent.click(structureTab);
    expect(structureTab.getAttribute("aria-selected")).toBe("true");

    // Click on SQL Editor tab
    const sqlTab = screen.getByRole("tab", { name: "SQL Editor" });
    fireEvent.click(sqlTab);
    expect(sqlTab.getAttribute("aria-selected")).toBe("true");
  });

  it("toggles sidebar on mobile or narrow view", async () => {
    vi.spyOn(liveRuntime.api, "me").mockResolvedValue({ user: { id: "user:1", role: "ADMIN" } } as any);
    vi.spyOn(liveRuntime.api, "databasesListConnections").mockResolvedValue({
      ok: true,
      connections: [mockConnection]
    });

    render(
      <DatabasesPane
        mobile={true}
        pane={{
          id: "pane:db-mobile",
          roomId: "room:test",
          title: "Databases 1",
          mode: "DATABASES"
        } as any}
      />
    );

    // Sidebar toggle button should be present and closed by default on mobile
    const toggleBtn = await screen.findByTitle(/show sidebar/i);
    expect(toggleBtn).toBeTruthy();
    expect(toggleBtn.classList.contains("closed")).toBe(true);

    // Click toggle to show sidebar
    fireEvent.click(toggleBtn);
    const hideBtn = await screen.findByTitle(/hide sidebar/i);
    expect(hideBtn).toBeTruthy();
    expect(hideBtn.classList.contains("active")).toBe(true);

    // Click toggle again to hide sidebar
    fireEvent.click(hideBtn);
    expect(await screen.findByTitle(/show sidebar/i)).toBeTruthy();
    expect(toggleBtn.classList.contains("closed")).toBe(true);
  });

  it("defaults sidebar to closed on narrow screen and respects localStorage", async () => {
    vi.spyOn(liveRuntime.api, "me").mockResolvedValue({ user: { id: "user:1", role: "ADMIN" } } as any);
    vi.spyOn(liveRuntime.api, "databasesListConnections").mockResolvedValue({
      ok: true,
      connections: [mockConnection]
    });

    // Simulate narrow window width < 768
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 600 });

    try {
      render(
        <DatabasesPane
          mobile={false}
          pane={{
            id: "pane:db-narrow",
            roomId: "room:test",
            title: "Databases 1",
            mode: "DATABASES"
          } as any}
        />
      );

      // On narrow width, should default to closed
      const showBtn = await screen.findByTitle(/show sidebar/i);
      expect(showBtn.classList.contains("closed")).toBe(true);

      // Toggle to open
      fireEvent.click(showBtn);
      expect(localStorage.getItem("space_db_sidebar")).toBe("true");

      const hideBtn = await screen.findByTitle(/hide sidebar/i);
      expect(hideBtn.classList.contains("active")).toBe(true);
    } finally {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: originalInnerWidth });
    }
  });

  it("filters tables with data and excludes internal pg_toast/pg_temp schemas", async () => {
    vi.spyOn(liveRuntime.api, "me").mockResolvedValue({ user: { id: "user:1", role: "ADMIN" } } as any);
    vi.spyOn(liveRuntime.api, "databasesListConnections").mockResolvedValue({
      ok: true,
      connections: [mockConnection]
    });

    const catalogWithMix: DatabaseCatalog = {
      ...mockCatalog,
      schemas: [
        {
          name: "public",
          tables: [
            {
              name: "rooms",
              schema: "public",
              rowCount: 12,
              columns: [{ name: "id", type: "text", dataType: "text", nullable: false, isPrimaryKey: true, isAutoIncrement: false }],
              primaryKeys: ["id"],
              foreignKeys: [],
              indexes: []
            },
            {
              name: "empty_logs",
              schema: "public",
              rowCount: 0,
              columns: [{ name: "id", type: "text", dataType: "text", nullable: false, isPrimaryKey: true, isAutoIncrement: false }],
              primaryKeys: ["id"],
              foreignKeys: [],
              indexes: []
            }
          ],
          views: []
        },
        {
          name: "pg_toast_temp_2",
          tables: [
            {
              name: "toast_internal",
              schema: "pg_toast_temp_2",
              rowCount: 0,
              columns: [],
              primaryKeys: [],
              foreignKeys: [],
              indexes: []
            }
          ],
          views: []
        }
      ]
    };

    vi.spyOn(liveRuntime.api, "databasesGetCatalog").mockResolvedValue({
      ok: true,
      catalog: catalogWithMix
    });

    render(
      <DatabasesPane
        pane={{
          id: "pane:db-filter",
          roomId: "room:test",
          title: "Databases 1",
          mode: "DATABASES"
        } as any}
      />
    );

    // Verify pg_toast_temp_2 is filtered out and never rendered
    await waitFor(() => {
      expect(screen.getAllByText("rooms").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("pg_toast_temp_2")).toBeNull();
    expect(screen.queryByText("toast_internal")).toBeNull();

    // Both tables initially visible
    expect(screen.getByText("empty_logs")).toBeTruthy();

    // Click "With Data" filter pill
    const withDataBtn = screen.getByRole("button", { name: /with data/i });
    fireEvent.click(withDataBtn);

    // empty_logs should now be hidden, rooms remains visible
    expect(screen.getAllByText("rooms").length).toBeGreaterThan(0);
    expect(screen.queryByText("empty_logs")).toBeNull();

    // Click "All" filter pill
    const allBtn = screen.getByRole("button", { name: /^all/i });
    fireEvent.click(allBtn);
    expect(screen.getByText("empty_logs")).toBeTruthy();
  });

  it("syncs totalRows into catalog table rowCount when table data loads", async () => {
    vi.spyOn(liveRuntime.api, "me").mockResolvedValue({ user: { id: "user:1", role: "ADMIN" } } as any);
    vi.spyOn(liveRuntime.api, "databasesListConnections").mockResolvedValue({
      ok: true,
      connections: [mockConnection]
    });

    const catalogWithZero: DatabaseCatalog = {
      engine: "POSTGRES",
      databases: ["space"],
      currentDatabase: "space",
      capabilities: {
        schemas: true,
        alterColumn: true,
        dropColumn: true,
        foreignKeys: true,
        indexes: true,
        views: true,
        triggers: true,
        functions: true,
        cancelQuery: true,
        explain: true
      },
      schemas: [
        {
          name: "public",
          tables: [
            {
              name: "handshake_checks",
              schema: "public",
              rowCount: 0,
              columns: [{ name: "id", type: "text", dataType: "text", nullable: false, isPrimaryKey: true, isAutoIncrement: false }],
              primaryKeys: ["id"],
              foreignKeys: [],
              indexes: []
            }
          ],
          views: []
        }
      ]
    };

    vi.spyOn(liveRuntime.api, "databasesGetCatalog").mockResolvedValue({
      ok: true,
      catalog: catalogWithZero
    });

    vi.spyOn(liveRuntime.api, "databasesGetTableData").mockResolvedValue({
      ok: true,
      totalRows: 17,
      page: 1,
      pageSize: 50,
      rows: Array.from({ length: 17 }, (_, i) => ({ id: `row-${i}` })),
      columns: [{ name: "id", type: "text", dataType: "text", nullable: false, isPrimaryKey: true, isAutoIncrement: false }],
      primaryKeys: ["id"],
      isReadOnly: false
    });

    render(
      <DatabasesPane
        pane={{
          id: "pane:db-sync",
          roomId: "room:test",
          title: "Databases 1",
          mode: "DATABASES"
        } as any}
      />
    );

    // Initially table has rowCount 0, but when selected and data loads, it syncs to 17
    await waitFor(() => {
      expect(screen.getByText("17")).toBeTruthy();
    });
  });

  it("does not re-fetch catalog when selecting a different table", async () => {
    vi.spyOn(liveRuntime.api, "me").mockResolvedValue({ user: { id: "user:1", role: "ADMIN" } } as any);
    vi.spyOn(liveRuntime.api, "databasesListConnections").mockResolvedValue({
      ok: true,
      connections: [mockConnection]
    });

    const catalogWithTwoTables: DatabaseCatalog = {
      engine: "POSTGRES",
      databases: ["space"],
      currentDatabase: "space",
      capabilities: {
        schemas: true,
        alterColumn: true,
        dropColumn: true,
        foreignKeys: true,
        indexes: true,
        views: true,
        triggers: true,
        functions: true,
        cancelQuery: true,
        explain: true
      },
      schemas: [
        {
          name: "public",
          tables: [
            {
              name: "rooms",
              schema: "public",
              rowCount: 10,
              columns: [{ name: "id", type: "text", dataType: "text", nullable: false, isPrimaryKey: true, isAutoIncrement: false }],
              primaryKeys: ["id"],
              foreignKeys: [],
              indexes: []
            },
            {
              name: "users",
              schema: "public",
              rowCount: 5,
              columns: [{ name: "id", type: "text", dataType: "text", nullable: false, isPrimaryKey: true, isAutoIncrement: false }],
              primaryKeys: ["id"],
              foreignKeys: [],
              indexes: []
            }
          ],
          views: []
        }
      ]
    };

    const getCatalogSpy = vi.spyOn(liveRuntime.api, "databasesGetCatalog").mockResolvedValue({
      ok: true,
      catalog: catalogWithTwoTables
    });

    vi.spyOn(liveRuntime.api, "databasesGetTableData").mockResolvedValue({
      ok: true,
      totalRows: 5,
      page: 1,
      pageSize: 50,
      rows: [{ id: "user-1" }],
      columns: [{ name: "id", type: "text", dataType: "text", nullable: false, isPrimaryKey: true, isAutoIncrement: false }],
      primaryKeys: ["id"],
      isReadOnly: false
    });

    render(
      <DatabasesPane
        pane={{
          id: "pane:db-no-reload",
          roomId: "room:test",
          title: "Databases 1",
          mode: "DATABASES"
        } as any}
      />
    );

    // Initial load: catalog loaded once
    await waitFor(() => {
      expect(screen.getAllByText("users").length).toBeGreaterThan(0);
    });
    expect(getCatalogSpy).toHaveBeenCalledTimes(1);

    // Click on "users" table in sidebar
    const usersTableNode = screen.getByText("users");
    fireEvent.click(usersTableNode);

    await waitFor(() => {
      // Catalog should STILL have only been loaded 1 time! Not reloaded!
      expect(getCatalogSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("renders DatabaseOverviewTab with tables grid when connection breadcrumb is clicked to deselect table", async () => {
    vi.spyOn(liveRuntime.api, "me").mockResolvedValue({ user: { id: "user:1", role: "ADMIN" } } as any);
    vi.spyOn(liveRuntime.api, "databasesListConnections").mockResolvedValue({
      ok: true,
      connections: [mockConnection]
    });
    vi.spyOn(liveRuntime.api, "databasesGetCatalog").mockResolvedValue({
      ok: true,
      catalog: mockCatalog
    });
    vi.spyOn(liveRuntime.api, "databasesGetTableData").mockResolvedValue({
      ok: true,
      ...mockTableData
    });

    render(
      <DatabasesPane
        pane={{
          id: "pane:db-overview",
          roomId: "room:test",
          title: "Databases 1",
          mode: "DATABASES"
        } as any}
      />
    );

    // Initially loads connection and auto-selects first table "rooms"
    await waitFor(() => {
      // "rooms" should be both in sidebar and in the breadcrumb
      expect(screen.getAllByText("rooms").length).toBeGreaterThan(1);
    });

    // Click on connection crumb to deselect table
    const connCrumb = screen.getAllByText("SpaceApp DB (PostgreSQL)")[0]!;
    fireEvent.click(connCrumb);

    // Verify DatabaseOverviewTab is now rendered with table overview
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Search tables...")).toBeTruthy();
    });

    // Overview displays the table card "rooms"
    const overviewCard = screen.getByTitle("Open table rooms");
    expect(overviewCard).toBeTruthy();

    // Clicking the overview card selects the table again
    fireEvent.click(overviewCard);

    // Breadcrumb should show "rooms" again
    await waitFor(() => {
      expect(screen.getAllByText("rooms").length).toBeGreaterThan(1);
    });
  });

  it("renders DatabaseConnectionsOverview when root Databases breadcrumb is clicked", async () => {
    vi.spyOn(liveRuntime.api, "me").mockResolvedValue({ user: { id: "user:1", role: "ADMIN" } } as any);
    vi.spyOn(liveRuntime.api, "databasesListConnections").mockResolvedValue({
      ok: true,
      connections: [mockConnection]
    });
    vi.spyOn(liveRuntime.api, "databasesGetCatalog").mockResolvedValue({
      ok: true,
      catalog: mockCatalog
    });
    vi.spyOn(liveRuntime.api, "databasesGetTableData").mockResolvedValue({
      ok: true,
      ...mockTableData
    });

    render(
      <DatabasesPane
        pane={{
          id: "pane:db-root-crumb",
          roomId: "room:test",
          title: "Databases 1",
          mode: "DATABASES"
        } as any}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByText("rooms").length).toBeGreaterThan(0);
    });

    // Click root breadcrumb "Databases"
    const rootCrumb = screen.getByRole("button", { name: /databases/i });
    fireEvent.click(rootCrumb);

    // Verify DatabaseConnectionsOverview is rendered
    await waitFor(() => {
      expect(screen.getByText("Databases & Connections")).toBeTruthy();
    });
    expect(screen.getByText(/connection available/i)).toBeTruthy();

    // Verify connection card is visible and clickable
    const connCard = screen.getByTitle("Connect to SpaceApp DB (PostgreSQL)");
    expect(connCard).toBeTruthy();

    // Clicking connection card reconnects and opens table overview
    fireEvent.click(connCard);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Search tables...")).toBeTruthy();
    });
  });

  it("shows empty table prompt with Browse other tables button that returns to overview", async () => {
    vi.spyOn(liveRuntime.api, "me").mockResolvedValue({ user: { id: "user:1", role: "ADMIN" } } as any);
    vi.spyOn(liveRuntime.api, "databasesListConnections").mockResolvedValue({
      ok: true,
      connections: [mockConnection]
    });
    vi.spyOn(liveRuntime.api, "databasesGetCatalog").mockResolvedValue({
      ok: true,
      catalog: {
        ...mockCatalog,
        schemas: [
          {
            name: "public",
            tables: [
              {
                name: "activity_log_events",
                schema: "public",
                rowCount: 0,
                columns: [{ name: "id", type: "text", dataType: "text", nullable: false, isPrimaryKey: true, isAutoIncrement: false }],
                primaryKeys: ["id"],
                foreignKeys: [],
                indexes: []
              },
              {
                name: "rooms",
                schema: "public",
                rowCount: 12,
                columns: [{ name: "id", type: "text", dataType: "text", nullable: false, isPrimaryKey: true, isAutoIncrement: false }],
                primaryKeys: ["id"],
                foreignKeys: [],
                indexes: []
              }
            ],
            views: []
          }
        ]
      }
    });
    vi.spyOn(liveRuntime.api, "databasesGetTableData").mockResolvedValue({
      ok: true,
      columns: [{ name: "id", type: "text", dataType: "text", nullable: false, isPrimaryKey: true, isAutoIncrement: false }],
      rows: [],
      page: 1,
      pageSize: 50,
      totalRows: 0,
      primaryKeys: ["id"],
      isReadOnly: false
    });

    render(
      <DatabasesPane
        pane={{
          id: "pane:db-empty-table",
          roomId: "room:test",
          title: "Databases 1",
          mode: "DATABASES"
        } as any}
      />
    );

    // Initial load auto-selects table with data ("rooms")
    await waitFor(() => {
      expect(screen.getAllByText("rooms").length).toBeGreaterThan(0);
    });

    // Select the empty table "activity_log_events" from sidebar
    const emptyTableNode = screen.getByText("activity_log_events");
    fireEvent.click(emptyTableNode);

    // Empty state should be rendered
    await waitFor(() => {
      expect(screen.getByText('Table "activity_log_events" has 0 records')).toBeTruthy();
    });
    expect(screen.getByText("This table is currently empty in the database.")).toBeTruthy();

    // Click "Browse other tables"
    const browseBtn = screen.getByRole("button", { name: /browse other tables/i });
    fireEvent.click(browseBtn);

    // Should return to DatabaseOverviewTab
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Search tables...")).toBeTruthy();
    });
  });

  it("formatCellDisplay strips ANSI escape sequences and non-printable control characters", () => {
    expect(formatCellDisplay(null)).toBe("");
    expect(formatCellDisplay(undefined)).toBe("");
    expect(formatCellDisplay(12345)).toBe("12345");
    expect(formatCellDisplay("\x1b[200~Some Greek text: καλημέρα\x1b[201~")).toBe("Some Greek text: καλημέρα");
    expect(formatCellDisplay("\x1b[?2026h\x1b[32mClean Result\x1b[0m\r\n")).toBe("Clean Result\n");
    expect(formatCellDisplay("\x1b]0;terminal-title\x07Actual payload")).toBe("Actual payload");
  });
});



