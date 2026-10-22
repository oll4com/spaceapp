import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import type { RailVisibilityMenuState } from "../ui-theme/use-rail-visibility.js";

// Open/closed state of the room toolbar's menus and popovers, the anchors they
// open from and return focus to, and the toolbar containers they measure.

type Flag = [boolean, Dispatch<SetStateAction<boolean>>];

export interface ToolbarPopovers {
  isThemeMenuOpen: boolean;
  setIsThemeMenuOpen: Dispatch<SetStateAction<boolean>>;
  isPaneLayoutMenuOpen: boolean;
  setIsPaneLayoutMenuOpen: Dispatch<SetStateAction<boolean>>;
  /** The pane layout menu of the collapsed rail. */
  isCollapsedPaneLayoutMenuOpen: boolean;
  setIsCollapsedPaneLayoutMenuOpen: Dispatch<SetStateAction<boolean>>;
  isPaneSpanAllMenuOpen: boolean;
  setIsPaneSpanAllMenuOpen: Dispatch<SetStateAction<boolean>>;
  isWorkspaceTextSizePickerOpen: boolean;
  setIsWorkspaceTextSizePickerOpen: Dispatch<SetStateAction<boolean>>;
  isCliLauncherOpen: boolean;
  setIsCliLauncherOpen: Dispatch<SetStateAction<boolean>>;
  isChatLauncherOpen: boolean;
  setIsChatLauncherOpen: Dispatch<SetStateAction<boolean>>;
  isVibeMusicOpen: boolean;
  setIsVibeMusicOpen: Dispatch<SetStateAction<boolean>>;
  isOskKeyboardOpen: boolean;
  setIsOskKeyboardOpen: Dispatch<SetStateAction<boolean>>;
  isQuickLinksOpen: boolean;
  setIsQuickLinksOpen: Dispatch<SetStateAction<boolean>>;
  /** The right-click menu that shows or hides lower rail icons. */
  lowerRailVisibilityMenu: RailVisibilityMenuState;
  setLowerRailVisibilityMenu: Dispatch<SetStateAction<RailVisibilityMenuState>>;
  boardToolbarRef: RefObject<HTMLDivElement | null>;
  roomToolbarActionsRef: RefObject<HTMLDivElement | null>;
  roomToolbarScrollRef: RefObject<HTMLDivElement | null>;
  collapsedToolbarRef: RefObject<HTMLDivElement | null>;
  roomOverflowTriggerRef: MutableRefObject<HTMLButtonElement | null>;
  cliLauncherButtonRef: MutableRefObject<HTMLButtonElement | null>;
  chatLauncherButtonRef: MutableRefObject<HTMLButtonElement | null>;
  /** Where focus returns when the CLI launcher closes. */
  cliLauncherReturnFocusRef: MutableRefObject<HTMLButtonElement | null>;
  workspaceTextSizeButtonRef: MutableRefObject<HTMLButtonElement | null>;
  vibeMusicButtonRef: MutableRefObject<HTMLButtonElement | null>;
  quickLinksButtonRef: MutableRefObject<HTMLButtonElement | null>;
  paneLayoutButtonRef: MutableRefObject<HTMLButtonElement | null>;
  paneLayoutCollapsedButtonRef: MutableRefObject<HTMLButtonElement | null>;
  paneSpanAllButtonRef: MutableRefObject<HTMLButtonElement | null>;
  roomThemeButtonRef: MutableRefObject<HTMLButtonElement | null>;
  /** Closes the pane layout menu and, by default, returns focus to its trigger. */
  closePaneLayoutMenu: (restoreFocus?: boolean) => void;
  /** Closes the "span all panes" menu and, by default, returns focus to its trigger. */
  closePaneSpanAllMenu: (restoreFocus?: boolean) => void;
}

/** Opens the music player from elsewhere (the Nous dock's full-screen launcher, plan clipboard:wr9yNPJwkDrp). */
export const OPEN_VIBE_MUSIC_EVENT = "space:open-vibe-music";

export function useToolbarPopovers(): ToolbarPopovers {
  const [isThemeMenuOpen, setIsThemeMenuOpen]: Flag = useState(false);
  const [isPaneLayoutMenuOpen, setIsPaneLayoutMenuOpen]: Flag = useState(false);
  const [isCollapsedPaneLayoutMenuOpen, setIsCollapsedPaneLayoutMenuOpen]: Flag = useState(false);
  const [isPaneSpanAllMenuOpen, setIsPaneSpanAllMenuOpen]: Flag = useState(false);
  const [isWorkspaceTextSizePickerOpen, setIsWorkspaceTextSizePickerOpen]: Flag = useState(false);
  const [isCliLauncherOpen, setIsCliLauncherOpen]: Flag = useState(false);
  const [isChatLauncherOpen, setIsChatLauncherOpen]: Flag = useState(false);
  const [isVibeMusicOpen, setIsVibeMusicOpen]: Flag = useState(false);
  useEffect(() => {
    const open = () => setIsVibeMusicOpen(true);
    window.addEventListener(OPEN_VIBE_MUSIC_EVENT, open);
    return () => window.removeEventListener(OPEN_VIBE_MUSIC_EVENT, open);
  }, []);
  const [isOskKeyboardOpen, setIsOskKeyboardOpen]: Flag = useState(false);
  const [isQuickLinksOpen, setIsQuickLinksOpen]: Flag = useState(false);
  const [lowerRailVisibilityMenu, setLowerRailVisibilityMenu] = useState<RailVisibilityMenuState>(null);
  const boardToolbarRef = useRef<HTMLDivElement | null>(null);
  const roomToolbarActionsRef = useRef<HTMLDivElement | null>(null);
  const roomToolbarScrollRef = useRef<HTMLDivElement | null>(null);
  const collapsedToolbarRef = useRef<HTMLDivElement | null>(null);
  const roomOverflowTriggerRef = useRef<HTMLButtonElement | null>(null);
  const cliLauncherButtonRef = useRef<HTMLButtonElement | null>(null);
  const chatLauncherButtonRef = useRef<HTMLButtonElement | null>(null);
  const cliLauncherReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const workspaceTextSizeButtonRef = useRef<HTMLButtonElement | null>(null);
  const vibeMusicButtonRef = useRef<HTMLButtonElement | null>(null);
  const quickLinksButtonRef = useRef<HTMLButtonElement | null>(null);
  const paneLayoutButtonRef = useRef<HTMLButtonElement | null>(null);
  const paneLayoutCollapsedButtonRef = useRef<HTMLButtonElement | null>(null);
  const paneSpanAllButtonRef = useRef<HTMLButtonElement | null>(null);
  const roomThemeButtonRef = useRef<HTMLButtonElement | null>(null);

  function closePaneLayoutMenu(restoreFocus = true) {
    setIsPaneLayoutMenuOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => paneLayoutButtonRef.current?.focus());
    }
  }

  function closePaneSpanAllMenu(restoreFocus = true) {
    setIsPaneSpanAllMenuOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => paneSpanAllButtonRef.current?.focus());
    }
  }

  return {
    isThemeMenuOpen, setIsThemeMenuOpen,
    isPaneLayoutMenuOpen, setIsPaneLayoutMenuOpen,
    isCollapsedPaneLayoutMenuOpen, setIsCollapsedPaneLayoutMenuOpen,
    isPaneSpanAllMenuOpen, setIsPaneSpanAllMenuOpen,
    isWorkspaceTextSizePickerOpen, setIsWorkspaceTextSizePickerOpen,
    isCliLauncherOpen, setIsCliLauncherOpen,
    isChatLauncherOpen, setIsChatLauncherOpen,
    isVibeMusicOpen, setIsVibeMusicOpen,
    isOskKeyboardOpen, setIsOskKeyboardOpen,
    isQuickLinksOpen, setIsQuickLinksOpen,
    lowerRailVisibilityMenu, setLowerRailVisibilityMenu,
    boardToolbarRef,
    roomToolbarActionsRef,
    roomToolbarScrollRef,
    collapsedToolbarRef,
    roomOverflowTriggerRef,
    cliLauncherButtonRef,
    chatLauncherButtonRef,
    cliLauncherReturnFocusRef,
    workspaceTextSizeButtonRef,
    vibeMusicButtonRef,
    quickLinksButtonRef,
    paneLayoutButtonRef,
    paneLayoutCollapsedButtonRef,
    paneSpanAllButtonRef,
    roomThemeButtonRef,
    closePaneLayoutMenu,
    closePaneSpanAllMenu
  };
}
