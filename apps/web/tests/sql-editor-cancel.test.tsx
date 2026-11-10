// R11 (SpaceApp Android 0.2.13): the SQL tab's Cancel sends the id of the query running now, not the previous one's.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseExecuteSqlResponse } from "@space/contracts";
import { SqlEditorTab } from "../src/features/databases-pane/SqlEditorTab.js";

describe("SqlEditorTab Cancel", () => {
  it("starts each query with its own id and cancels that id while it runs", async () => {
    const finish: Array<(value: DatabaseExecuteSqlResponse) => void> = [];
    const onExecuteSql = vi.fn<(sql: string, limit?: number, sessionId?: string) => Promise<DatabaseExecuteSqlResponse>>(() => new Promise((resolve) => finish.push(resolve)));
    const onCancelSql = vi.fn<(sessionId: string) => Promise<void>>(async () => {});
    render(<SqlEditorTab connectionId="conn:1" catalog={null} onExecuteSql={onExecuteSql} onCancelSql={onCancelSql} />);
    const done = (index: number) => finish[index]!({ sessionId: onExecuteSql.mock.calls[index]![2]!, columns: [], rows: [], rowCount: 0, executionTimeMs: 1 });
    fireEvent.click(screen.getByText("Run"));
    await waitFor(() => expect(onExecuteSql).toHaveBeenCalledTimes(1));
    const first = onExecuteSql.mock.calls[0]![2];
    expect(first).toMatch(/^.{8,80}$/);
    done(0);
    await waitFor(() => expect(screen.queryByText("Cancel")).toBeNull());
    fireEvent.click(screen.getByText("Run"));
    await waitFor(() => expect(onExecuteSql).toHaveBeenCalledTimes(2));
    const second = onExecuteSql.mock.calls[1]![2];
    expect(second).not.toBe(first);
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(onCancelSql).toHaveBeenCalledWith(second));
    done(1);
  });
});
