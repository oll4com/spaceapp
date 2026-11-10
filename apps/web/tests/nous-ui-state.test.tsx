// What the operator picks in the Nous dock stays on this device per signed-in user (operator 3/11 12:51 BKK, nous_msg:40a252b1).
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { noteSignedInUser } from "../src/auth-bootstrap-cache.js";
import { useNousUiState } from "../src/features/nous/nous-ui-state.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const isStatus = (value: unknown): value is "ALL" | "DONE" => value === "ALL" || value === "DONE";
const signIn = (id: string | null) => noteSignedInUser({ user: id ? { id } : null });

beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(() => signIn(null));

it("keeps a choice per user, reads the device's earlier value until the user writes one, and drops a value that no longer fits", () => {
  localStorage.setItem("space.nous.ui.requests.status", JSON.stringify("DONE"));
  signIn("user:ann");
  const first = renderHook(() => useNousUiState("requests.status", "ALL", isStatus));
  expect(first.result.current[0]).toBe("DONE");
  act(() => first.result.current[1]("ALL"));
  expect(localStorage.getItem("space.nous.ui.user:ann.requests.status")).toBe(JSON.stringify("ALL"));
  first.unmount();
  expect(renderHook(() => useNousUiState("requests.status", "ALL", isStatus)).result.current[0]).toBe("ALL");

  signIn("user:bob");
  const bob = renderHook(() => useNousUiState("requests.status", "ALL", isStatus));
  expect(bob.result.current[0]).toBe("DONE");
  localStorage.setItem("space.nous.ui.user:bob.requests.status", JSON.stringify("GONE"));
  bob.rerender();
  const again = renderHook(() => useNousUiState("requests.status", "ALL", isStatus));
  expect(again.result.current[0]).toBe("ALL");
});
