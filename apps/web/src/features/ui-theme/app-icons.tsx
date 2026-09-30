import {
  ALargeSmall as LucideALargeSmall,
  Activity as LucideActivity,
  AlertTriangle as LucideAlertTriangle,
  Archive as LucideArchive,
  ArrowLeft as LucideArrowLeft,
  ArrowRightLeft as LucideArrowRightLeft,
  ArrowUp as LucideArrowUp,
  Bell as LucideBell,
  Bookmark as LucideBookmark,
  BookmarkPlus as LucideBookmarkPlus,
  Bot as LucideBot,
  Boxes as LucideBoxes,
  Brain as LucideBrain,
  BrainCircuit as LucideBrainCircuit,
  Bug as LucideBug,
  Camera as LucideCamera,
  Check as LucideCheck,
  CheckCircle2 as LucideCheckCircle2,
  ChevronDown as LucideChevronDown,
  ChevronLeft as LucideChevronLeft,
  ChevronRight as LucideChevronRight,
  Chrome as LucideChrome,
  CircleAlert as LucideCircleAlert,
  CircleHelp as LucideCircleHelp,
  CircleStop as LucideCircleStop,
  Clipboard as LucideClipboard,
  ClipboardList as LucideClipboardList,
  Clock3 as LucideClock3,
  CodeXml as LucideCodeXml,
  Columns2 as LucideColumns2,
  Columns3 as LucideColumns3,
  Copy as LucideCopy,
  Cpu as LucideCpu,
  Crosshair as LucideCrosshair,
  Crop as LucideCrop,
  Database as LucideDatabase,
  Download as LucideDownload,
  Dumbbell as LucideDumbbell,
  Eraser as LucideEraser,
  ExternalLink as LucideExternalLink,
  Eye as LucideEye,
  EyeOff as LucideEyeOff,
  File as LucideFile,
  FileInput as LucideFileInput,
  FileVideo as LucideFileVideo,
  Film as LucideFilm,
  Folder as LucideFolder,
  FolderOpen as LucideFolderOpen,
  FolderPlus as LucideFolderPlus,
  Gauge as LucideGauge,
  GitBranch as LucideGitBranch,
  GitCompare as LucideGitCompare,
  GitMerge as LucideGitMerge,
  Globe as LucideGlobe,
  Globe2 as LucideGlobe2,
  Grid2X2 as LucideGrid2X2,
  Grid3X3 as LucideGrid3X3,
  Github as LucideGithub,
  GripVertical as LucideGripVertical,
  HardDrive as LucideHardDrive,
  Home as LucideHome,
  History as LucideHistory,
  Images as LucideImages,
  Keyboard as LucideKeyboard,
  KeyRound as LucideKeyRound,
  LayoutDashboard as LucideLayoutDashboard,
  Link as LucideLink,
  ListFilter as LucideListFilter,
  ListTodo as LucideListTodo,
  Loader2 as LucideLoader2,
  Lock as LucideLock,
  LogOut as LucideLogOut,
  Maximize2 as LucideMaximize2,
  MemoryStick as LucideMemoryStick,
  MessageSquare as LucideMessageSquare,
  MessageSquareX as LucideMessageSquareX,
  Mic as LucideMic,
  Minimize2 as LucideMinimize2,
  Minus as LucideMinus,
  Monitor as LucideMonitor,
  MoreHorizontal as LucideMoreHorizontal,
  MousePointer2 as LucideMousePointer2,
  MoveHorizontal as LucideMoveHorizontal,
  Music2 as LucideMusic2,
  Network as LucideNetwork,
  Palette as LucidePalette,
  PanelLeft as LucidePanelLeft,
  PanelRight as LucidePanelRight,
  PanelTopOpen as LucidePanelTopOpen,
  PanelsTopLeft as LucidePanelsTopLeft,
  Paperclip as LucidePaperclip,
  Pause as LucidePause,
  Pencil as LucidePencil,
  PictureInPicture as LucidePictureInPicture,
  PictureInPicture2 as LucidePictureInPicture2,
  Pin as LucidePin,
  PinOff as LucidePinOff,
  Play as LucidePlay,
  Plus as LucidePlus,
  Printer as LucidePrinter,
  Radio as LucideRadio,
  RectangleHorizontal as LucideRectangleHorizontal,
  Recycle as LucideRecycle,
  RefreshCw as LucideRefreshCw,
  Rocket as LucideRocket,
  RotateCcw as LucideRotateCcw,
  RotateCw as LucideRotateCw,
  Route as LucideRoute,
  Save as LucideSave,
  Search as LucideSearch,
  Send as LucideSend,
  ServerCog as LucideServerCog,
  SkipBack as LucideSkipBack,
  SkipForward as LucideSkipForward,
  Settings2 as LucideSettings2,
  Shield as LucideShield,
  ShieldAlert as LucideShieldAlert,
  ShieldCheck as LucideShieldCheck,
  Shrink as LucideShrink,
  SlidersHorizontal as LucideSlidersHorizontal,
  Smartphone as LucideSmartphone,
  Sparkles as LucideSparkles,
  Square as LucideSquare,
  Star as LucideStar,
  Tablet as LucideTablet,
  StickyNote as LucideStickyNote,
  Terminal as LucideTerminal,
  Timer as LucideTimer,
  Trash2 as LucideTrash2,
  TriangleAlert as LucideTriangleAlert,
  Undo2 as LucideUndo2,
  Unplug as LucideUnplug,
  Upload as LucideUpload,
  UserCheck as LucideUserCheck,
  Users as LucideUsers,
  Video as LucideVideo,
  Volume2 as LucideVolume2,
  VolumeX as LucideVolumeX,
  Wrench as LucideWrench,
  X as LucideX,
  Youtube as LucideYoutube,
  Zap as LucideZap,
  type LucideIcon,
  type LucideProps
} from "lucide-react";
import { createContext, forwardRef, useContext, type ReactNode } from "react";
import type { ModernIconPack } from "../../ui-theme.js";
import { appIconMaterialSymbols, type AppIconName } from "./app-icon-map.js";
import { materialRoundedPaths, type MaterialSymbolName } from "./material-symbol-paths.js";
import { motionGeometricIcons } from "./motion-geometric-icons.js";

export type { LucideIcon, LucideProps } from "lucide-react";

const AppIconPackContext = createContext<ModernIconPack>("lucide");

export function AppIconProvider({ children, pack }: { children: ReactNode; pack: ModernIconPack }) {
  return <AppIconPackContext.Provider value={pack}>{children}</AppIconPackContext.Provider>;
}

function createMaterialSymbol(name: MaterialSymbolName): LucideIcon {
  const definition = materialRoundedPaths[name];
  const Component = forwardRef<SVGSVGElement, LucideProps>(function MaterialRoundedSymbol(
    {
      absoluteStrokeWidth: _absoluteStrokeWidth,
      children: _children,
      color = "currentColor",
      fill: _fill,
      size = 24,
      stroke: _stroke,
      strokeWidth: _strokeWidth,
      ...props
    },
    ref
  ) {
    return (
      <svg
        ref={ref}
        {...props}
        width={size}
        height={size}
        viewBox={definition.viewBox}
        fill="currentColor"
        color={color}
        stroke="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {definition.paths.map((path, index) => <path d={path} key={index} />)}
      </svg>
    );
  });
  Component.displayName = `MaterialRounded(${name})`;
  return Component as LucideIcon;
}

const materialRoundedIcons = Object.fromEntries(
  (Object.keys(materialRoundedPaths) as MaterialSymbolName[])
    .map((name) => [name, createMaterialSymbol(name)])
) as Record<MaterialSymbolName, LucideIcon>;

const lucideIcons = {
  ALargeSmall: LucideALargeSmall,
  Activity: LucideActivity,
  AlertTriangle: LucideAlertTriangle,
  Archive: LucideArchive,
  ArrowLeft: LucideArrowLeft,
  ArrowRightLeft: LucideArrowRightLeft,
  ArrowUp: LucideArrowUp,
  Bell: LucideBell,
  Bookmark: LucideBookmark,
  BookmarkPlus: LucideBookmarkPlus,
  Bot: LucideBot,
  Boxes: LucideBoxes,
  Brain: LucideBrain,
  BrainCircuit: LucideBrainCircuit,
  Bug: LucideBug,
  Camera: LucideCamera,
  Check: LucideCheck,
  CheckCircle2: LucideCheckCircle2,
  ChevronLeft: LucideChevronLeft,
  ChevronRight: LucideChevronRight,
  CircleAlert: LucideCircleAlert,
  CircleHelp: LucideCircleHelp,
  CircleStop: LucideCircleStop,
  Clipboard: LucideClipboard,
  ClipboardList: LucideClipboardList,
  Clock3: LucideClock3,
  CodeXml: LucideCodeXml,
  Columns2: LucideColumns2,
  Columns3: LucideColumns3,
  Copy: LucideCopy,
  Cpu: LucideCpu,
  Crosshair: LucideCrosshair,
  Crop: LucideCrop,
  Database: LucideDatabase,
  Download: LucideDownload,
  Eraser: LucideEraser,
  ExternalLink: LucideExternalLink,
  Eye: LucideEye,
  EyeOff: LucideEyeOff,
  File: LucideFile,
  FileInput: LucideFileInput,
  FileVideo: LucideFileVideo,
  Film: LucideFilm,
  Folder: LucideFolder,
  FolderOpen: LucideFolderOpen,
  FolderPlus: LucideFolderPlus,
  Gauge: LucideGauge,
  GitBranch: LucideGitBranch,
  GitCompare: LucideGitCompare,
  GitMerge: LucideGitMerge,
  Globe: LucideGlobe,
  Globe2: LucideGlobe2,
  Grid2X2: LucideGrid2X2,
  Grid3X3: LucideGrid3X3,
  GripVertical: LucideGripVertical,
  HardDrive: LucideHardDrive,
  Home: LucideHome,
  History: LucideHistory,
  Images: LucideImages,
  Keyboard: LucideKeyboard,
  KeyRound: LucideKeyRound,
  LayoutDashboard: LucideLayoutDashboard,
  Link: LucideLink,
  ListFilter: LucideListFilter,
  ListTodo: LucideListTodo,
  Loader2: LucideLoader2,
  Lock: LucideLock,
  LogOut: LucideLogOut,
  Maximize2: LucideMaximize2,
  MemoryStick: LucideMemoryStick,
  MessageSquare: LucideMessageSquare,
  MessageSquareX: LucideMessageSquareX,
  Mic: LucideMic,
  Minimize2: LucideMinimize2,
  Minus: LucideMinus,
  Monitor: LucideMonitor,
  MoreHorizontal: LucideMoreHorizontal,
  MousePointer2: LucideMousePointer2,
  MoveHorizontal: LucideMoveHorizontal,
  Music2: LucideMusic2,
  Network: LucideNetwork,
  Palette: LucidePalette,
  PanelLeft: LucidePanelLeft,
  PanelRight: LucidePanelRight,
  PanelTopOpen: LucidePanelTopOpen,
  PanelsTopLeft: LucidePanelsTopLeft,
  Paperclip: LucidePaperclip,
  Pause: LucidePause,
  Pencil: LucidePencil,
  Pin: LucidePin,
  PinOff: LucidePinOff,
  Play: LucidePlay,
  Plus: LucidePlus,
  Printer: LucidePrinter,
  Radio: LucideRadio,
  RectangleHorizontal: LucideRectangleHorizontal,
  RefreshCw: LucideRefreshCw,
  Rocket: LucideRocket,
  RotateCcw: LucideRotateCcw,
  RotateCw: LucideRotateCw,
  Route: LucideRoute,
  Save: LucideSave,
  Search: LucideSearch,
  Send: LucideSend,
  ServerCog: LucideServerCog,
  Settings2: LucideSettings2,
  SkipBack: LucideSkipBack,
  SkipForward: LucideSkipForward,
  Shield: LucideShield,
  ShieldAlert: LucideShieldAlert,
  ShieldCheck: LucideShieldCheck,
  Shrink: LucideShrink,
  SlidersHorizontal: LucideSlidersHorizontal,
  Smartphone: LucideSmartphone,
  Sparkles: LucideSparkles,
  Square: LucideSquare,
  Star: LucideStar,
  Tablet: LucideTablet,
  Terminal: LucideTerminal,
  Trash2: LucideTrash2,
  TriangleAlert: LucideTriangleAlert,
  Undo2: LucideUndo2,
  Unplug: LucideUnplug,
  Upload: LucideUpload,
  UserCheck: LucideUserCheck,
  Users: LucideUsers,
  Video: LucideVideo,
  Volume2: LucideVolume2,
  Wrench: LucideWrench,
  X: LucideX,
  Youtube: LucideYoutube,
  Zap: LucideZap
} satisfies Record<AppIconName, LucideIcon>;

function createPackAwareIcon(name: AppIconName, fallback: LucideIcon): LucideIcon {
  const materialName = appIconMaterialSymbols[name] as MaterialSymbolName;
  const MaterialIcon = materialRoundedIcons[materialName];
  const MotionIcon = motionGeometricIcons[name];
  const Component = forwardRef<SVGSVGElement, LucideProps>(function AppIcon(props, ref) {
    const pack = useContext(AppIconPackContext);
    if (pack === "material-rounded" && MaterialIcon) {
      return (
        <MaterialIcon
          {...props}
          ref={ref}
          data-app-icon={name}
          data-icon-pack="material-rounded"
        />
      );
    }
    if (pack === "motion" && MotionIcon) {
      return (
        <MotionIcon
          {...props}
          ref={ref}
          data-app-icon={name}
          data-icon-pack="motion"
        />
      );
    }
    const FallbackIcon = fallback;
    return <FallbackIcon {...props} ref={ref} data-app-icon={name} data-icon-pack="lucide" />;
  });
  Component.displayName = `AppIcon(${name})`;
  return Component as LucideIcon;
}

const packAwareIcons = Object.fromEntries(
  (Object.entries(lucideIcons) as Array<[AppIconName, LucideIcon]>)
    .map(([name, fallback]) => [name, createPackAwareIcon(name, fallback)])
) as Record<AppIconName, LucideIcon>;

export const {
  ALargeSmall,
  Activity,
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRightLeft,
  ArrowUp,
  Bell,
  Bookmark,
  BookmarkPlus,
  Bot,
  Boxes,
  Brain,
  BrainCircuit,
  Bug,
  Camera,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  CircleStop,
  Clipboard,
  ClipboardList,
  Clock3,
  CodeXml,
  Columns2,
  Columns3,
  Copy,
  Cpu,
  Crosshair,
  Crop,
  Database,
  Download,
  Eraser,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileInput,
  FileVideo,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  Gauge,
  GitBranch,
  GitCompare,
  GitMerge,
  Globe,
  Globe2,
  Grid2X2,
  Grid3X3,
  GripVertical,
  HardDrive,
  Home,
  History,
  Images,
  Keyboard,
  KeyRound,
  LayoutDashboard,
  Link,
  ListFilter,
  ListTodo,
  Loader2,
  Lock,
  LogOut,
  Maximize2,
  MemoryStick,
  MessageSquare,
  MessageSquareX,
  Mic,
  Minimize2,
  Minus,
  Monitor,
  MoreHorizontal,
  MousePointer2,
  MoveHorizontal,
  Music2,
  Network,
  Palette,
  PanelLeft,
  PanelRight,
  PanelTopOpen,
  PanelsTopLeft,
  Paperclip,
  Pause,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  Printer,
  Radio,
  RectangleHorizontal,
  RefreshCw,
  Rocket,
  RotateCcw,
  RotateCw,
  Route,
  Save,
  Search,
  Send,
  ServerCog,
  Settings2,
  Shield,
  SkipBack,
  SkipForward,
  ShieldAlert,
  ShieldCheck,
  Shrink,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Square,
  Star,
  Tablet,
  Terminal,
  Trash2,
  TriangleAlert,
  Undo2,
  Unplug,
  Upload,
  UserCheck,
  Users,
  Video,
  Volume2,
  Wrench,
  X,
  Youtube,
  Zap
} = packAwareIcons;

// Keep the three-arrow restart glyph triangular in every icon pack.
export const Recycle = LucideRecycle;
export const PictureInPicture = LucidePictureInPicture;
export const PictureInPicture2 = LucidePictureInPicture2;
export const VolumeX = LucideVolumeX;
export const StickyNote = LucideStickyNote;
export const Timer = LucideTimer;
export const Dumbbell = LucideDumbbell;
export const ChevronDown = LucideChevronDown;

const ChromeBrand = forwardRef<SVGSVGElement, LucideProps>(function ChromeBrand(props, ref) {
  return (
    <LucideChrome
      {...props}
      ref={ref}
      className={["lucide-chrome", props.className].filter(Boolean).join(" ")}
      data-brand-icon="chrome"
      data-icon-pack="brand"
    />
  );
});
ChromeBrand.displayName = "BrandIcon(Chrome)";
export const Chrome = ChromeBrand as LucideIcon;

const GithubBrand = forwardRef<SVGSVGElement, LucideProps>(function GithubBrand(props, ref) {
  return (
    <LucideGithub
      {...props}
      ref={ref}
      className={["lucide-github", props.className].filter(Boolean).join(" ")}
      data-brand-icon="github"
      data-icon-pack="brand"
    />
  );
});
GithubBrand.displayName = "BrandIcon(Github)";
export const Github = GithubBrand as LucideIcon;

const XBrand = forwardRef<SVGSVGElement, LucideProps>(function XBrand(props, ref) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={props.size ?? 24}
      height={props.size ?? 24}
      fill="currentColor"
      {...props}
      ref={ref}
      className={["lucide", "brand-icon-x", props.className].filter(Boolean).join(" ")}
      data-brand-icon="x"
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 24.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
});
XBrand.displayName = "BrandIcon(X)";
export const XSocialIcon = XBrand as LucideIcon;

const DiscordBrand = forwardRef<SVGSVGElement, LucideProps>(function DiscordBrand(props, ref) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={props.size ?? 24}
      height={props.size ?? 24}
      fill="currentColor"
      {...props}
      ref={ref}
      className={["lucide", "brand-icon-discord", props.className].filter(Boolean).join(" ")}
      data-brand-icon="discord"
    >
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994.021-.041.001-.09-.041-.106a13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
});
DiscordBrand.displayName = "BrandIcon(Discord)";
export const Discord = DiscordBrand as LucideIcon;
