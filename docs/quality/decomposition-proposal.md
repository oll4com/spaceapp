# Decomposition proposal (web steps 1–4 and the API route-domain moves applied with operator approval)

Package 3 of the plan targets a 60% reduction of the two composition roots,
measured against the baseline in `baseline.json`:
- `apps/api/src/app.ts`: 19,487 lines.
- `apps/web/src/App.tsx`: 18,192 lines.

## Current size

Both roots as of 2026-10-12, measured on dev `860ae01ced` with `scripts/quality-snapshot.mjs`: the API after its route-domain moves, the web root after step 4 and the merge of main.

| File | Lines | Change from baseline | Remaining to the 60% target |
| --- | --- | --- | --- |
| `apps/api/src/app.ts` | 7,593 (7,451 after the route-domain moves in `61cd349e14`) | -61.0% | none: target is 7,794 lines or fewer |
| `apps/web/src/App.tsx` | 7,238 (after step 4 and the merge of main, `c67ef9ad19`) | -60.2% | none: target is 7,277 lines or fewer |

Main keeps adding code to both roots. The two refreshes alone added
roughly 1,000 API lines and 1,000 web lines after the remediation extractions.

**2026-10-14: the target is no longer met.** Both roots grew back:
`app.ts` has 8,193 lines (target 7,794) and `App.tsx` 7,491 (target 7,277).
Since this date `docs/quality/composition-root-budget.json` records their size
and `scripts/tests/composition-root-size.test.mjs` (part of
`npm run test:architecture`) fails when either grows past it; an extraction
lowers the budget. Getting back under the 60% target remains open.

## Applied on 2026-10-11

The operator approved steps 1–3 and the API domain moves on 2026-10-11. The
scope is recorded in `/opt/spaceapp/docs/space_room_switch_performance_baseline.md`.
- Step 1: `features/pane-grid/pane-grid-layout.ts` and `app-shell-utils.ts` (`9374d229e1`, `bd167a596e`).
- Step 2: `features/pane-dialogs/PaneDialogs.tsx`, byte-identical. `MinimizedPanePreviewCard` was moved at the same time by the minimized-bar work on main (`features/pane-float/MinimizedPanePreview.tsx`); the merge keeps that version.
- Step 3: `features/pane-card/PaneCard.tsx`, byte-identical (same SHA), with the lazy pane chunks. The memo boundary and props are unchanged. When main changed `PaneCard` in parallel (pane actions menu, shortcut order), the merge replayed the same move tool on main's `App.tsx`: 211/211 declarations are verbatim, and only the 10 lazy-chunk import paths are re-relativized.
- API: admin users, agent tool routing, CLI maintenance, CLI egress/VPN and model providers moved to their own route modules. Each is registered from the composition root with the same rate-limit options and audit recorder.

Evidence:
- Typecheck is clean.
- The dependency ratchet passes.
- The web suite has the same per-file failures as main. Two source-text contracts were pointed at `PaneCard.tsx` with identical assertions.
- The Warm-related `resident-pane-render` and `terminal-real-xterm-resize` tests pass 9/9 when run alone.
- Live at `0ff3d53269` (ticket `q-20261011-094714-694b`); `live:verify` passed and the pane-host PID was unchanged.
- Warm browser proof (`BENCHMARK_WARM_CAPACITY`, 6×16, live): capacity and retention pass (96/96 same terminals and sockets after more than 45 s hidden). Warm latency fails with p95 1150 and 966 ms against the 250 ms gate. The cost is browser style recalculation on the first reveal of a hidden room, which the verbatim moves do not change (PERF-001). `BENCHMARK_ROOM_SWITCH` cannot run while the operator account hides the room toolbar (TEST-002).

## What is left in `App.tsx`

After step 4 (2026-10-12):

| Block | Lines | Protected scope |
| --- | --- | --- |
| `App` component | 6,459 | Warm (room activation, pane mounting, visibility, polling, room event streams); instant-UI preload |
| Imports | 313 | — |
| `lazyWithPreload` / `lazy` declarations and the Settings dock card map | ≈200 | Instant-UI (idle preload order, 2026-10-10 approval) |
| Small helpers (refresh queue, shell mode, toolbar migration, server settings) | ≈250 | Mixed; Warm where they feed room activation |

Under the 2026-10-07 rule, every remaining large block needs prior approval of
the specific change, even when the move is mechanical.

## Proposed sequence

Each step is a pure move:
- Same exports.
- No behavior or timing change.
- Separate commit.
- Scoped tests plus the warm p95 ≤ 250 ms and 35-second retention proof.

1. **Done.** **Pure helpers, low risk.** Pane-grid helpers move to `features/pane-grid/pane-grid-layout.ts`; `parseStreamEvent`, `readAppView` and `isTransientUpstreamRuntimeError` to `app-shell-utils.ts`. About 500 lines.
2. **Done.** **Dialogs.** `TaskHistoryDialog` and `MovePaneDialog` move to their feature folders; `MinimizedPanePreviewCard` moves only if minimized deferral stays byte-identical. About 330 lines.
3. **Done.** **`PaneCard` to `features/pane-card/PaneCard.tsx`.** The memo boundary and props stay unchanged (the approved 2026-10-10 re-render work depends on them). About 2,400 lines.
4. **Done for the web root (non-Warm state).** **Hooks out of `App`:**
   - auth/bootstrap,
   - server settings sync,
   - room catalog loading,
   - dock open/close state,
   - workspace navigation.

   Each becomes `use*` hooks in feature folders. This is the largest and riskiest step and needs one approval per hook. It is estimated at 4,000+ lines.
5. **API.** Steps 1–4 do not reach 60% for the API on their own. The largest remaining API groups are `/api/panes/:id` (≈2,500 lines), `/api/rooms/:id` (≈830) and `/api/events` (≈800). These routes are edited by several concurrent sessions daily, so moving them creates merge conflicts for those sessions. Coordinate with them before each move.

Steps 1–3 are done and brought `App.tsx` to 11,471 lines (-36.9%, after merging main on 2026-10-11). Only step 4 can reach 60%. Step 4 brought it to 7,182 lines (-60.5%) on 2026-10-12; see "Step 4 slices" below. Merging main afterwards (docks kit, T3 Code room worktree isolation) left it at 7,225 lines (-60.3%).

### Step 4 analysis, 2026-10-11

Step 4 was analyzed with the TypeScript AST before any change. The `App` body has 702 top-level statements; 22 of them reference locals declared later in the body. The search looked for contiguous blocks that keep hook order unchanged when they are lifted into a custom hook. Those blocks have:
- 80–280 lines;
- 10–40 earlier `App` locals that would become parameters;
- up to 13 return values.

The 4,214-line handler block depends on 369 earlier `App` locals.

Lifting these blocks verbatim would add hooks with 20+ parameters, more indirection and Warm risk, without real separation. Step 4 was therefore not applied. Reaching 60% needs a change of state ownership, for example room, pane and dock stores read by components, instead of pure moves. That is outside the 2026-10-11 approval, which covers moves that keep effects, dependencies and ordering unchanged. It needs a design and a fresh approval with Warm browser proof.

The operator then approved the full remediation scope (2026-10-11 11:30Z, recorded in `/opt/spaceapp/docs/space_room_switch_performance_baseline.md`). Step 4 was applied as below, by giving each non-Warm state cluster its own owner instead of lifting statement blocks verbatim.

### Step 4 slices (web), 2026-10-11 to 2026-10-12

Each slice moves one cohesive state cluster or view out of `App` into a feature module with a small typed API (grouped context objects, not loose parameters). No behavior, UI text, persistence key or timing changes. Rules:
- A controller hook is called where the state it replaces was declared, so its effects keep their place in `App`'s effect order. Where that is not possible, the effect stays in `App`. Each commit body lists the effects that moved and why their order is unchanged.
- `lazyWithPreload` declarations stay in `App` in their order (idle preload registration). Views receive lazy elements as slots or lazy components as props.
- Module evaluation and stylesheet order stay unchanged. Bundling `App.tsx` with esbuild gives the same CSS order as `b4029810ef`. Two bare imports keep `VoiceSettingsCard` and `DesktopNavigation` at their old evaluation positions.
- Warm room runtime, pane mounting, socket/xterm identity, minimized deferral, the upper-rail minimized toggle and `terminal-resize-presentation.ts` are not touched.

| Slice | Moved to | `App.tsx` after |
| --- | --- | --- |
| Start (`b4029810ef`) | — | 11,503 |
| 1. User preferences | `user-settings/useUserPreferences.ts` | 11,076 |
| 2. Docks and Manage dialogs | `docks/useSideSurfaces.ts`, `SideSurfaceFrame.tsx`; `server-actions/useManageController.ts`, `RestartDialogs.tsx` | 10,480 |
| 3. Workspace overlays and notices | `app-notices/`, `toolbar-vpn/`, `live-pane/useLiveRail.tsx`, `snip-tool/useSnipTool.ts`, `desktop-titlebar/useBrowserFullscreen.ts` | 10,000 |
| 4. Rooms dock and app view | `rooms-dock/` (dock, admin users, room catalog), `help/useAppView.ts` | 9,093 |
| 5. Toolbar popovers and actions | `room-toolbar/useToolbarPopovers.ts`, `room-toolbar-actions.ts` | 8,471 |
| Cleanup | unused declarations and imports | 8,185 |
| 6. Room toolbar views and rename | `room-toolbar/CollapsedRoomRail.tsx`, `RoomTitleBar.tsx`, `useRoomRename.ts` | 7,720 |
| 7. Minimized pane bar | `pane-float/useMinimizedPaneBar.ts`, `MinimizedPaneBar.tsx`, `pane-mode-labels.ts` | 7,585 |
| 8. Settings dock | `settings/AgentSettingsDock.tsx` (lazy cards passed in by `App`) | 7,293 |
| 9. Room toolbar action area | `room-toolbar/RoomToolbarActions.tsx` | 7,182 |
| Merge of main (docks kit, T3 Code worktrees) | changes applied where the code now lives: dock title and Previous/Next order in `docks/useSideSurfaces.ts`, room delete confirmation and project errors in `rooms-dock/RoomsDockPanel.tsx`, provider notice and Voice card boundary in `settings/AgentSettingsDock.tsx`, the rest in `App.tsx` | 7,225 |

Evidence for each slice:
- Web typecheck and `domain-boundaries` pass.
- Unit tests were added for each new module.
- Focused web test files were compared one file at a time against `b4029810ef`. Every failure is either a base failure or passes when rerun alone on both trees.
- The Warm A/B browser proof is still to be run on staging.

Left in `App`: the Warm room runtime (room activation, pane loading and mounting, room event streams, polling, presentation barriers), the pane handlers that feed it, the lazy declarations and `renderSideSurfaceContent`/`renderWorkspaceAction`, which render those lazy surfaces.

## What was done without approval

- **API domains:** swarm (`ea5d7b794f`), plus the remediation domains for artifacts, private data, MCP policy, streaming, configuration, Telegram and review.
- **Web modules:**
  - login, voice settings, health, action surfaces;
  - the leaf settings save queue;
  - the removal of 47 unreachable functions.

None of these touches Warm, instant-UI, terminal or cold-pane code.
