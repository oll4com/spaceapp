import { createRef, useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PaneLayoutMenu } from '../src/features/pane-layout/PaneLayoutMenu.js';
import { getSpaceRuntime } from '../src/runtime/SpaceRuntime.js';
import { normalizeRailOrder, moveRailIcon, RAIL_ORDER_KEY, UPPER_RAIL_ORDER_KEY, UPPER_RAIL_IDS, LOWER_RAIL_IDS, useRailOrder } from '../src/features/ui-theme/use-rail-order.js';
import { RailVisibilityMenu } from '../src/features/ui-theme/RailVisibilityMenu.js';
import {
  DEFAULT_LOWER_RAIL_ITEMS,
  LOWER_RAIL_HIDDEN_KEY,
  LOWER_RAIL_NON_HIDEABLE,
  LOWER_RAIL_VISIBILITY_IDS,
  normalizeHiddenRailIds,
  UPPER_RAIL_NON_HIDEABLE,
  useRailVisibility,
} from '../src/features/ui-theme/use-rail-visibility.js';
import { normalizeActionOrder } from '../src/icon-toolbar.js';
import { railPopoverPosition } from '../src/features/rail-popover.js';

vi.mock('../src/runtime/SpaceRuntime.js', () => ({ getSpaceRuntime: () => ({ platform: { localStorage: window.localStorage } }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  getSpaceRuntime().platform.localStorage.removeItem(RAIL_ORDER_KEY);
  getSpaceRuntime().platform.localStorage.removeItem(UPPER_RAIL_ORDER_KEY);
  getSpaceRuntime().platform.localStorage.removeItem(LOWER_RAIL_HIDDEN_KEY);
});
it('selects layout visibly from wheel anywhere, but applies only on Enter', () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const select = vi.fn();
  const view = render(<PaneLayoutMenu automaticColumns={3} currentColumns={2} error={null} maximumColumns={4} onClose={vi.fn()} onSelect={select} pending={false} triggerRef={createRef()} visiblePaneCount={5} />);
  const options = screen.getAllByRole('menuitemradio');
  const current = options.findIndex(option => option.getAttribute('aria-checked') === 'true');
  fireEvent.wheel(document.body, { deltaY: 100 });
  expect(document.activeElement).toBe(options[current + 1]);
  expect(options[current + 1]?.getAttribute('data-wheel-selected')).toBe('true');
  expect(select).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
  expect(select).toHaveBeenCalledWith(4);
  view.unmount();
  const event = new WheelEvent('wheel', { deltaY: 100, cancelable: true });
  document.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});
it('applies selected layout on scroll button (middle click / button 1)', () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const select = vi.fn();
  const view = render(<PaneLayoutMenu automaticColumns={3} currentColumns={2} error={null} maximumColumns={4} onClose={vi.fn()} onSelect={select} pending={false} triggerRef={createRef()} visiblePaneCount={5} />);
  const options = screen.getAllByRole('menuitemradio');
  const current = options.findIndex(option => option.getAttribute('aria-checked') === 'true');
  fireEvent.wheel(document.body, { deltaY: 100 });
  expect(options[current + 1]?.getAttribute('data-wheel-selected')).toBe('true');
  expect(select).not.toHaveBeenCalled();
  fireEvent.mouseUp(document.body, { button: 1 });
  expect(select).toHaveBeenCalledWith(4);
  view.unmount();
});
it('applies selected layout on auxclick with button 1 (middle mouse button)', () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const select = vi.fn();
  const view = render(<PaneLayoutMenu automaticColumns={3} currentColumns={2} error={null} maximumColumns={4} onClose={vi.fn()} onSelect={select} pending={false} triggerRef={createRef()} visiblePaneCount={5} />);
  const options = screen.getAllByRole('menuitemradio');
  const current = options.findIndex(option => option.getAttribute('aria-checked') === 'true');
  fireEvent.wheel(document.body, { deltaY: 100 });
  expect(options[current + 1]?.getAttribute('data-wheel-selected')).toBe('true');
  expect(select).not.toHaveBeenCalled();
  fireEvent(document.body, new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
  expect(select).toHaveBeenCalledWith(4);
  view.unmount();
});
it('normalizes stored order and supports insertion in either direction', () => {
  expect(normalizeRailOrder(['music', 'music', 'unknown']).slice(0, 3)).toEqual(['music', 'previous', 'next']);
  expect(moveRailIcon(['create', 'music', 'tools'], 'tools', 'create', false)).toEqual(['tools', 'create', 'music']);
  expect(moveRailIcon(['create', 'music', 'tools'], 'create', 'tools', true)).toEqual(['music', 'tools', 'create']);
});
it('normalizes upper rail order placing minimized-bar unconditionally first and agents-dashboard second', () => {
  expect(UPPER_RAIL_IDS[0]).toBe('minimized-bar');
  expect(UPPER_RAIL_IDS[1]).toBe('agents-dashboard');
  expect(normalizeRailOrder([], UPPER_RAIL_IDS).slice(0, 2)).toEqual(['minimized-bar', 'agents-dashboard']);
  expect(normalizeRailOrder(['accounts', 'cpu'], UPPER_RAIL_IDS).slice(0, 4)).toEqual(['minimized-bar', 'agents-dashboard', 'accounts', 'cpu']);
  expect(normalizeRailOrder(['agents-dashboard', 'minimized-bar', 'accounts'], UPPER_RAIL_IDS).slice(0, 3)).toEqual(['minimized-bar', 'agents-dashboard', 'accounts']);
});
it('normalizes action order placing new-task at the very top when missing from stored order', () => {
  const defaultActions = ['new-task', 'add', 'import', 'stop', 'copy', 'reconnect'];
  expect(normalizeActionOrder(defaultActions, [])).toEqual(['new-task', 'add', 'import', 'stop', 'copy', 'reconnect']);
  const stored = ['add', 'import', 'stop', 'copy'];
  expect(normalizeActionOrder(defaultActions, stored)).toEqual(['new-task', 'add', 'import', 'stop', 'copy', 'reconnect']);
  const userOrder = ['add', 'new-task', 'import'];
  expect(normalizeActionOrder(defaultActions, userOrder)).toEqual(['add', 'new-task', 'import', 'stop', 'copy', 'reconnect']);
  // With preserveUnknownActionIds:
  expect(normalizeActionOrder(['new-task', 'import'], ['custom-unknown', 'import'], true)).toEqual(['new-task', 'custom-unknown', 'import']);
});
it('keeps actions a narrower toolbar never stored next to their default neighbours', () => {
  // CLI panes share one order key; the root shell stores its order without the agent-only actions.
  const rootOrder = ['stop', 'copy', 'paste', 'import', 'add', 'reconnect'];
  const agentActions = ['new-task', 'stop', 'plan', 'memory', 'copy', 'paste', 'import', 'add', 'reconnect'];
  expect(normalizeActionOrder(agentActions, rootOrder, true)).toEqual(agentActions);
  // A custom order keeps its relative order; new actions join their default neighbours.
  expect(normalizeActionOrder(agentActions, ['copy', 'stop', 'reconnect'], true)).toEqual(
    ['new-task', 'copy', 'paste', 'import', 'add', 'stop', 'plan', 'memory', 'reconnect']
  );
});
function Rail() {
  const ref = useRef<HTMLDivElement>(null);
  useRailOrder(ref, true);
  return <div ref={ref}><button data-rail-id="create">Create</button><button data-rail-id="music">Music</button><button data-rail-id="tools">Tools</button></div>;
}
function UpperRail() {
  const ref = useRef<HTMLDivElement>(null);
  useRailOrder(ref, true, { storageKey: UPPER_RAIL_ORDER_KEY, allowedIds: UPPER_RAIL_IDS, group: 'upper' });
  return <div ref={ref}><button data-rail-id="minimized-bar">Minimized</button><button data-rail-id="accounts">Accounts</button><button data-rail-id="memory">Memory</button></div>;
}
it('persists drag order, suppresses accidental activation and restores order on remount', () => {
  const view = render(<Rail />);
  const create = screen.getByText('Create'), tools = screen.getByText('Tools');
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
  fireEvent.dragStart(tools, { dataTransfer });
  fireEvent.dragOver(create, { dataTransfer, clientY: -1 });
  fireEvent.drop(create, { dataTransfer });
  const order = JSON.parse(getSpaceRuntime().platform.localStorage.getItem(RAIL_ORDER_KEY)!);
  expect(order.indexOf('tools')).toBeLessThan(order.indexOf('create'));
  expect(Number(tools.style.order)).toBeLessThan(Number(create.style.order));
  view.unmount(); render(<Rail />);
  expect(screen.getByText('Tools').style.order).toBe(String(order.indexOf('tools')));
});
it('persists upper rail drag order and isolates upper and lower rail drag-and-drop', () => {
  const view = render(
    <div>
      <UpperRail />
      <Rail />
    </div>
  );
  const minimized = screen.getByText('Minimized');
  const accounts = screen.getByText('Accounts');
  const create = screen.getByText('Create');
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };

  // Reorder within upper rail
  fireEvent.dragStart(accounts, { dataTransfer });
  fireEvent.dragOver(minimized, { dataTransfer, clientY: -1 });
  fireEvent.drop(minimized, { dataTransfer });
  const upperOrder = JSON.parse(getSpaceRuntime().platform.localStorage.getItem(UPPER_RAIL_ORDER_KEY)!);
  expect(upperOrder.indexOf('accounts')).toBeLessThan(upperOrder.indexOf('minimized-bar'));
  expect(Number(accounts.style.order)).toBeLessThan(Number(minimized.style.order));

  // Cross-rail drop attempt: dragging accounts (upper) over create (lower) should be ignored
  fireEvent.dragStart(accounts, { dataTransfer });
  fireEvent.dragOver(create, { dataTransfer, clientY: -1 });
  fireEvent.drop(create, { dataTransfer });
  expect(getSpaceRuntime().platform.localStorage.getItem(RAIL_ORDER_KEY)).toBeNull();

  view.unmount();
});

it('normalizes hidden rail ids and refuses non-hideable expand', () => {
  expect(normalizeHiddenRailIds(['music', 'music', 'unknown', 'expand'], LOWER_RAIL_IDS, LOWER_RAIL_NON_HIDEABLE)).toEqual(['music']);
  expect(normalizeHiddenRailIds(['cpu', 'rtt'], UPPER_RAIL_IDS, UPPER_RAIL_NON_HIDEABLE)).toEqual(['cpu', 'rtt']);
});

function VisibilityRail() {
  const visibility = useRailVisibility(LOWER_RAIL_HIDDEN_KEY, LOWER_RAIL_VISIBILITY_IDS, LOWER_RAIL_NON_HIDEABLE);
  return (
    <div>
      <span data-testid="hidden">{visibility.hiddenIds.join(',')}</span>
      <button type="button" onClick={() => visibility.hide('music')}>Hide music</button>
      <button type="button" onClick={() => visibility.hide('expand')}>Hide expand</button>
      <button type="button" onClick={() => visibility.show('music')}>Show music</button>
      <button type="button" onClick={() => visibility.showAll()}>Show all</button>
      <span data-testid="music-visible">{String(visibility.isVisible('music'))}</span>
    </div>
  );
}

it('persists rail icon visibility and keeps expand visible', () => {
  const view = render(<VisibilityRail />);
  fireEvent.click(screen.getByText('Hide music'));
  expect(screen.getByTestId('music-visible').textContent).toBe('false');
  expect(JSON.parse(getSpaceRuntime().platform.localStorage.getItem(LOWER_RAIL_HIDDEN_KEY)!)).toEqual(['music']);
  fireEvent.click(screen.getByText('Hide expand'));
  expect(JSON.parse(getSpaceRuntime().platform.localStorage.getItem(LOWER_RAIL_HIDDEN_KEY)!)).toEqual(['music']);
  view.unmount();
  render(<VisibilityRail />);
  expect(screen.getByTestId('music-visible').textContent).toBe('false');
  fireEvent.click(screen.getByText('Show all'));
  expect(screen.getByTestId('music-visible').textContent).toBe('true');
  expect(getSpaceRuntime().platform.localStorage.getItem(LOWER_RAIL_HIDDEN_KEY)).toBeNull();
});

it('opens rail visibility menu checkboxes from the menu component', () => {
  const hide = vi.fn();
  const show = vi.fn();
  const showAll = vi.fn();
  const onClose = vi.fn();
  render(
    <RailVisibilityMenu
      items={DEFAULT_LOWER_RAIL_ITEMS}
      hiddenIds={['music']}
      label="Rail icons"
      x={40}
      y={80}
      onClose={onClose}
      onHide={hide}
      onShow={show}
      onShowAll={showAll}
    />
  );
  expect(screen.getByRole('menu', { name: 'Rail icons' })).toBeTruthy();
  expect(screen.queryByRole('menuitemcheckbox', { name: /More|Show room toolbar/ })).toBeNull();
  const musicItem = screen.getByRole('menuitemcheckbox', { name: 'Show Music' });
  expect(musicItem.querySelector('span')?.textContent).toBe('Music');
  expect(musicItem.querySelector('.icon-action-manager-state')?.textContent).toBe('Show');
  fireEvent.click(musicItem);
  expect(show).toHaveBeenCalledWith('music');
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Hide Pane layout' }));
  expect(hide).toHaveBeenCalledWith('layout');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show all hidden icons' }));
  expect(showAll).toHaveBeenCalled();
});

it('adjusts rail visibility menu height dynamically and handles keyboard navigation', () => {
  const hide = vi.fn();
  const show = vi.fn();
  const showAll = vi.fn();
  const onClose = vi.fn();

  const originalInnerHeight = window.innerHeight;
  const originalInnerWidth = window.innerWidth;
  window.innerHeight = 500;
  window.innerWidth = 800;

  try {
    const view = render(
      <RailVisibilityMenu
        items={DEFAULT_LOWER_RAIL_ITEMS}
        hiddenIds={[]}
        label="Rail icons"
        x={750}
        y={450}
        onClose={onClose}
        onHide={hide}
        onShow={show}
        onShowAll={showAll}
      />
    );

    const menu = screen.getByRole('menu', { name: 'Rail icons' });
    expect(menu).toBeTruthy();
    expect(menu.style.maxHeight).toBeTruthy();
    expect(parseInt(menu.style.maxHeight, 10)).toBeLessThanOrEqual(500);

    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    expect(buttons.length).toBeGreaterThan(1);
    const firstButton = buttons[0]!;
    const secondButton = buttons[1]!;
    firstButton.focus();
    expect(document.activeElement).toBe(firstButton);

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(secondButton);

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(firstButton);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();

    view.unmount();
  } finally {
    window.innerHeight = originalInnerHeight;
    window.innerWidth = originalInnerWidth;
  }
});

it('positions rail visibility menu relative to rail anchor instead of offset cursor', () => {
  const onClose = vi.fn();
  const dummyRail = document.createElement('div');
  dummyRail.className = 'room-toolbar-collapsed';
  dummyRail.getBoundingClientRect = () => ({
    left: 740,
    top: 150,
    right: 792,
    bottom: 600,
    width: 52,
    height: 450,
    x: 740,
    y: 150,
    toJSON: () => {},
  });
  document.body.appendChild(dummyRail);

  try {
    const view = render(
      <RailVisibilityMenu
        items={DEFAULT_LOWER_RAIL_ITEMS}
        hiddenIds={[]}
        label="Rail icons"
        x={770}
        y={400}
        anchorRef={{ current: dummyRail }}
        onClose={onClose}
        onHide={vi.fn()}
        onShow={vi.fn()}
        onShowAll={vi.fn()}
      />
    );

    const menu = screen.getByRole('menu', { name: 'Rail icons' });
    expect(menu).toBeTruthy();
    expect(menu.getAttribute('data-rail-popover')).toBe('true');
    // Left should be cleanly placed to the left of the rail (rail.left - width - 8)
    const menuLeft = parseInt(menu.style.left, 10);
    expect(menuLeft).toBeLessThan(740);
    expect(menuLeft).toBeGreaterThan(0);
    // Top should align with rail.top (150) rather than cursor y (400)
    const menuTop = parseInt(menu.style.top, 10);
    expect(menuTop).toBeLessThanOrEqual(150);

    // Right click on the menu itself closes it
    fireEvent.contextMenu(menu);
    expect(onClose).toHaveBeenCalled();

    view.unmount();
  } finally {
    dummyRail.remove();
  }
});


it('keeps rail popovers below the desktop title bar', () => {
  const rail = document.createElement('div');
  rail.className = 'room-toolbar-floating-controls';
  rail.getBoundingClientRect = () => ({ left: 900, right: 950, top: 40, bottom: 700, width: 50, height: 660, x: 900, y: 40, toJSON: () => ({}) });
  const titlebar = document.createElement('div');
  titlebar.className = 'desktop-window-titlebar';
  titlebar.getBoundingClientRect = () => ({ left: 0, right: 1000, top: 0, bottom: 32, width: 1000, height: 32, x: 0, y: 0, toJSON: () => ({}) });
  document.body.append(rail);
  try {
    expect(railPopoverPosition(rail, 280)?.maxHeight).toBe(700 - 8);
    document.body.append(titlebar);
    // The menu's top edge (bottom - maxHeight) starts 8px under the 32px title bar.
    expect(railPopoverPosition(rail, 280)?.maxHeight).toBe(700 - 32 - 8);
  } finally {
    rail.remove();
    titlebar.remove();
  }
});
