import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import {
  FolderPlus,
  FileInput,
  Upload,
  RefreshCw,
  Eye,
  EyeOff,
  LayoutGrid,
  List,
  ShieldCheck,
  UserCheck,
  Search,
  Folder,
  Edit2,
  PanelLeftClose,
  PanelLeft
} from "lucide-react";

export interface FileManagerToolbarProps {
  currentPath: string;
  workspaceRoot: string;
  mode: "user" | "admin";
  isAdminCapable: boolean;
  onModeToggle: () => void;
  onNavigate: (newPath: string) => void;
  onRefresh: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onUploadClick: () => void;
  showHidden: boolean;
  onToggleHidden: () => void;
  viewMode: "table" | "grid";
  onToggleViewMode: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
}

export function FileManagerToolbar({
  currentPath,
  workspaceRoot,
  mode,
  isAdminCapable,
  onModeToggle,
  onNavigate,
  onRefresh,
  onNewFile,
  onNewFolder,
  onUploadClick,
  showHidden,
  onToggleHidden,
  viewMode,
  onToggleViewMode,
  searchQuery,
  onSearchChange,
  sidebarVisible,
  onToggleSidebar
}: FileManagerToolbarProps) {
  const safePath = currentPath || workspaceRoot || "/opt/spaceapp";
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState(safePath);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPathInput(currentPath || workspaceRoot || "/opt/spaceapp");
  }, [currentPath, workspaceRoot]);

  useEffect(() => {
    if (isEditingPath && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditingPath]);

  function handlePathSubmit() {
    setIsEditingPath(false);
    const trimmed = pathInput.trim();
    if (trimmed && trimmed !== currentPath) {
      onNavigate(trimmed);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      handlePathSubmit();
    } else if (e.key === "Escape") {
      setPathInput(safePath);
      setIsEditingPath(false);
    }
  }

  // Generate breadcrumb segments
  const segments = safePath === "/" ? [""] : safePath.split("/").filter(Boolean);
  const currentDirName = segments[segments.length - 1] || "workspace";

  const toolbarRef = useRef<HTMLDivElement>(null);
  const breadcrumbsRef = useRef<HTMLDivElement>(null);
  const [isCompact, setIsCompact] = useState(false);
  const [isTwoLine, setIsTwoLine] = useState(false);

  useEffect(() => {
    if (!toolbarRef.current) return;
    const updateLayout = () => {
      if (!toolbarRef.current) return;
      const width = toolbarRef.current.clientWidth;
      setIsCompact(width < 900);

      // In split or compact panes (< 960px) or whenever path doesn't fit on one row, move full path to second line
      const bc = breadcrumbsRef.current;
      const isOverflowing = bc ? bc.scrollWidth > bc.clientWidth + 4 : false;
      setIsTwoLine(width < 960 || isOverflowing);
    };

    const observer = new ResizeObserver(updateLayout);
    observer.observe(toolbarRef.current);
    updateLayout();
    return () => observer.disconnect();
  }, [safePath]);

  function renderBreadcrumbs() {
    if (isEditingPath) {
      return (
        <input
          ref={inputRef}
          className="fm-path-input"
          type="text"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handlePathSubmit}
          style={{ width: "100%", maxWidth: 600 }}
        />
      );
    }

    return (
      <div className="fm-breadcrumbs">
        {segments.map((seg, idx) => {
          const segPath = idx === 0 && segments[0] === "" ? "/" : "/" + segments.slice(0, idx + 1).filter(Boolean).join("/");
          const isLast = idx === segments.length - 1;
          return (
            <span key={segPath} style={{ display: "inline-flex", alignItems: "center" }}>
              <button
                className={`fm-crumb-btn ${isLast ? "fm-crumb-active" : ""}`}
                onClick={() => onNavigate(segPath)}
              >
                {idx === 0 && seg === "" ? "/" : seg}
              </button>
              {!isLast && <span className="fm-crumb-sep">/</span>}
            </span>
          );
        })}
        <button
          className="fm-action-btn"
          style={{ marginLeft: 4, padding: "2px 4px" }}
          onClick={() => setIsEditingPath(true)}
          title="Edit Path (Ctrl+L)"
        >
          <Edit2 size={13} />
        </button>
      </div>
    );
  }

  function renderControls() {
    return (
      <div className="fm-toolbar-controls">
        {/* Sidebar Toggle */}
        <button
          type="button"
          className={`fm-sidebar-toggle ${sidebarVisible ? "active" : "closed"}`}
          onClick={onToggleSidebar}
          title={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
          aria-label={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
        >
          {sidebarVisible ? <PanelLeftClose size={14} /> : <PanelLeft size={14} />}
        </button>

        {/* Search / Filter Input */}
        <div className="fm-search-wrapper">
          <Search size={14} style={{ position: "absolute", left: 8, color: "var(--modern-muted)", pointerEvents: "none" }} />
          <input
            className="fm-search-input"
            type="text"
            placeholder="Filter files..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>

        {/* User / Admin Mode Toggle */}
        <button
          type="button"
          className={`desktop-mode-switch fm-mode-switch ${mode === "admin" ? "admin-mode" : "user-mode"}`}
          aria-label={mode === "admin" ? "Admin mode" : "User mode"}
          aria-pressed={mode === "admin"}
          onClick={onModeToggle}
          title={
            mode === "admin"
              ? "Admin mode: Full filesystem root & editing unlocked. Click to switch to User mode (Read-only)."
              : isAdminCapable
              ? "User mode: View-only access. Click to unlock Admin mode."
              : "User mode: View-only access."
          }
        >
          {mode === "admin" ? <ShieldCheck size={14} aria-hidden="true" /> : <UserCheck size={14} aria-hidden="true" />}
          <span className="fm-btn-text">{mode === "admin" ? "Admin mode" : "User mode"}</span>
        </button>

        {/* Write Operations - ONLY in Admin Mode */}
        {mode === "admin" && (
          <>
            <button className="fm-btn" onClick={onNewFile} title="New File">
              <FileInput size={14} />
              <span className="fm-btn-text">+ File</span>
            </button>

            <button className="fm-btn" onClick={onNewFolder} title="New Folder">
              <FolderPlus size={14} />
              <span className="fm-btn-text">+ Folder</span>
            </button>

            <button className="fm-btn primary" onClick={onUploadClick} title="Upload File">
              <Upload size={14} />
              <span className="fm-btn-text">Upload</span>
            </button>
          </>
        )}

        {/* Read / View Controls */}
        <button className="fm-btn" onClick={onRefresh} title="Refresh directory">
          <RefreshCw size={14} />
        </button>

        <button
          className="fm-btn"
          onClick={onToggleHidden}
          title={showHidden ? "Hide dotfiles" : "Show dotfiles"}
        >
          {showHidden ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>

        <button
          className="fm-btn"
          onClick={onToggleViewMode}
          title={viewMode === "table" ? "Switch to Grid View" : "Switch to List View"}
        >
          {viewMode === "table" ? <LayoutGrid size={14} /> : <List size={14} />}
        </button>
      </div>
    );
  }

  return (
    <div className={`fm-toolbar ${isTwoLine ? "fm-two-line" : ""} ${isCompact ? "fm-compact" : ""}`} ref={toolbarRef}>
      {/* Top Row: Path if single-line, or current folder + controls */}
      <div className="fm-toolbar-row">
        {!isTwoLine && (
          <div className="fm-breadcrumbs-wrapper" ref={breadcrumbsRef}>
            {renderBreadcrumbs()}
          </div>
        )}

        {isTwoLine && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
            <Folder size={16} color="#ffd43b" style={{ flexShrink: 0 }} />
            <span style={{ fontWeight: 600, fontSize: "0.85rem", color: "var(--modern-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {currentDirName}
            </span>
          </div>
        )}

        {renderControls()}
      </div>

      {/* Second Line: Full Path underneath when narrow or wrapping */}
      {isTwoLine && (
        <div className="fm-toolbar-path-row" ref={breadcrumbsRef}>
          {renderBreadcrumbs()}
        </div>
      )}
    </div>
  );
}
