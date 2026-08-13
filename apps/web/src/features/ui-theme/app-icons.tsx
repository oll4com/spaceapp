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
  ChevronLeft as LucideChevronLeft,
  ChevronRight as LucideChevronRight,
  Chrome as LucideChrome,
  CircleAlert as LucideCircleAlert,
  CircleHelp as LucideCircleHelp,
  CircleStop as LucideCircleStop,
  Clipboard as LucideClipboard,
  Clock3 as LucideClock3,
  Columns3 as LucideColumns3,
  Copy as LucideCopy,
  Cpu as LucideCpu,
  Crosshair as LucideCrosshair,
  Database as LucideDatabase,
  Download as LucideDownload,
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
  GripVertical as LucideGripVertical,
  HardDrive as LucideHardDrive,
  History as LucideHistory,
  Images as LucideImages,
  Keyboard as LucideKeyboard,
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
  PanelRight as LucidePanelRight,
  PanelTopOpen as LucidePanelTopOpen,
  PanelsTopLeft as LucidePanelsTopLeft,
  Paperclip as LucidePaperclip,
  Pause as LucidePause,
  Pencil as LucidePencil,
  Pin as LucidePin,
  PinOff as LucidePinOff,
  Play as LucidePlay,
  Plus as LucidePlus,
  Printer as LucidePrinter,
  Radio as LucideRadio,
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
  Terminal as LucideTerminal,
  Trash2 as LucideTrash2,
  TriangleAlert as LucideTriangleAlert,
  Undo2 as LucideUndo2,
  Unplug as LucideUnplug,
  Upload as LucideUpload,
  UserCheck as LucideUserCheck,
  Users as LucideUsers,
  Video as LucideVideo,
  Volume2 as LucideVolume2,
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
  Clock3: LucideClock3,
  Columns3: LucideColumns3,
  Copy: LucideCopy,
  Cpu: LucideCpu,
  Crosshair: LucideCrosshair,
  Database: LucideDatabase,
  Download: LucideDownload,
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
  GripVertical: LucideGripVertical,
  HardDrive: LucideHardDrive,
  History: LucideHistory,
  Images: LucideImages,
  Keyboard: LucideKeyboard,
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
  const Component = forwardRef<SVGSVGElement, LucideProps>(function AppIcon(props, ref) {
    const pack = useContext(AppIconPackContext);
    if (pack === "material-rounded") {
      return (
        <MaterialIcon
          {...props}
          ref={ref}
          data-app-icon={name}
          data-icon-pack="material-rounded"
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
  Clock3,
  Columns3,
  Copy,
  Cpu,
  Crosshair,
  Database,
  Download,
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
  GripVertical,
  HardDrive,
  History,
  Images,
  Keyboard,
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
