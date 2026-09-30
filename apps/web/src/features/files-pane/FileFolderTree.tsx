import { useState, useEffect, useRef } from "react";
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  HardDrive,
  Package,
  Layers,
  FileText,
  Settings,
  Terminal,
  Home,
  FileCode,
  Copy,
  Check,
} from "lucide-react";
import { api } from "../../api.js";
import type { FileItem, DiskStats } from "@space/contracts";
import { useTouchContextMenu } from "../ui-theme/use-touch-context-menu.js";

export interface FileFolderTreeProps {
  currentPath: string;
  workspaceRoot: string;
  mode: "user" | "admin";
  onNavigate: (path: string) => void;
  collapsed?: boolean;
}

interface TreeNode {
  path: string;
  name: string;
  children?: TreeNode[];
  isExpanded: boolean;
  isLoading: boolean;
}

export function FileFolderTree({
  currentPath = "/opt/spaceapp",
  workspaceRoot = "/opt/spaceapp",
  mode = "user",
  onNavigate,
  collapsed = false
}: FileFolderTreeProps) {
  const root = workspaceRoot || "/opt/spaceapp";
  // Quick bookmarks
  const bookmarks = [
    { label: "Workspace", path: root, icon: <HardDrive size={15} color="var(--modern-accent)" /> },
    { label: "Apps", path: `${root}/apps`, icon: <Layers size={15} color="#4dabf7" /> },
    { label: "Packages", path: `${root}/packages`, icon: <Package size={15} color="#ffa94d" /> },
    { label: "Docs", path: `${root}/docs`, icon: <FileText size={15} color="#69db7c" /> },
    ...(mode === "admin"
      ? [
          { label: "Root (/)", path: "/", icon: <Terminal size={15} color="var(--modern-warning)" />, tag: "ADMIN" },
          { label: "Config (/etc)", path: "/etc", icon: <Settings size={15} color="var(--modern-warning)" />, tag: "ADMIN" },
          { label: "Logs (/var/log)", path: "/var/log", icon: <FileCode size={15} color="var(--modern-warning)" />, tag: "ADMIN" },
          { label: "Home (/home)", path: "/home", icon: <Home size={15} color="var(--modern-warning)" />, tag: "ADMIN" }
        ]
      : [])
  ];

  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const [diskStats, setDiskStats] = useState<DiskStats | null>(null);
  const [isCompact, setIsCompact] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
    label: string;
  } | null>(null);
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!sidebarRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { height, width } = entry.contentRect;
        const compact = height < 520 || width < 160 || window.innerWidth < 768 || window.innerHeight < 600;
        setIsCompact(compact);
      }
    });
    observer.observe(sidebarRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const handleClose = () => setContextMenu(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("click", handleClose);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleClose, true);
    return () => {
      window.removeEventListener("click", handleClose);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleClose, true);
    };
  }, [contextMenu]);

  function openContextMenu(path: string, label: string, clientX: number, clientY: number) {
    const menuWidth = 180;
    const menuHeight = 120;
    const x = Math.max(8, Math.min(clientX, window.innerWidth - menuWidth - 8));
    const y = Math.max(8, Math.min(clientY, window.innerHeight - menuHeight - 8));
    setContextMenu({ x, y, path, label });
  }

  function handleContextMenu(e: React.MouseEvent, path: string, label: string) {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(path, label, e.clientX, e.clientY);
  }

  const touchContext = useTouchContextMenu(
    (source) => source instanceof Element ? source.closest<HTMLElement>(".fm-bookmark-item[data-tree-path]") : null,
    ({ target, x, y }) => {
      const path = target.dataset.treePath;
      if (path) openContextMenu(path, target.dataset.treeLabel ?? path, x, y);
    }
  );

  async function handleCopyPath(path: string) {
    setContextMenu(null);
    try {
      await navigator.clipboard.writeText(path);
      setCopiedNotice(`Copied: ${path}`);
      setTimeout(() => setCopiedNotice(null), 2500);
    } catch {
      try {
        const input = document.createElement("textarea");
        input.value = path;
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
        setCopiedNotice(`Copied: ${path}`);
        setTimeout(() => setCopiedNotice(null), 2500);
      } catch {
        // ignore
      }
    }
  }

  useEffect(() => {
    // Initialize root tree based on current workspace
    const rootPath = mode === "admin" && currentPath.startsWith("/etc") ? "/etc" : workspaceRoot;
    loadTreeChildren(rootPath).then((children) => {
      setTreeData([
        {
          path: rootPath,
          name: rootPath === "/" ? "root" : rootPath.split("/").pop() || "workspace",
          isExpanded: true,
          isLoading: false,
          children
        }
      ]);
    });
  }, [workspaceRoot, mode]);

  useEffect(() => {
    void loadDiskStats();
  }, []);

  async function loadDiskStats() {
    try {
      const res = await api.filesDiskUsage();
      if (res.ok && res.disk) {
        setDiskStats(res.disk);
      }
    } catch {
      // Keep UI resilient
    }
  }

  async function loadTreeChildren(dirPath: string): Promise<TreeNode[]> {
    try {
      const res = await api.filesList({ path: dirPath, mode, showHidden: false });
      return (res?.entries || [])
        .filter((e) => e.isDirectory)
        .map((e) => ({
          path: e.path,
          name: e.name,
          isExpanded: false,
          isLoading: false
        }));
    } catch {
      return [];
    }
  }

  async function toggleNode(node: TreeNode) {
    if (node.isExpanded) {
      node.isExpanded = false;
      setTreeData([...treeData]);
      return;
    }

    node.isLoading = true;
    setTreeData([...treeData]);

    const children = await loadTreeChildren(node.path);
    node.children = children;
    node.isExpanded = true;
    node.isLoading = false;
    setTreeData([...treeData]);
  }

  function renderTreeNode(node: TreeNode, depth = 0) {
    const isCurrent = currentPath === node.path;
    return (
      <div key={node.path}>
        <div
          className={`fm-bookmark-item ${isCurrent ? "active" : ""}`}
          data-tree-path={node.path}
          data-tree-label={node.name}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={() => onNavigate(node.path)}
          onContextMenu={(e) => handleContextMenu(e, node.path, node.name)}
        >
          <span
            onClick={(e) => {
              e.stopPropagation();
              void toggleNode(node);
            }}
            style={{ cursor: "pointer", display: "inline-flex", alignItems: "center" }}
          >
            {node.isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
          {node.isExpanded ? (
            <FolderOpen size={15} color="var(--modern-accent, #61d2c3)" />
          ) : (
            <Folder size={15} color="#ffd43b" />
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {node.name}
          </span>
        </div>
        {node.isExpanded && node.children && (
          <div>{node.children.map((child) => renderTreeNode(child, depth + 1))}</div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={sidebarRef}
      className={`fm-sidebar ${collapsed ? "fm-sidebar-collapsed" : ""} ${isCompact ? "is-compact" : ""}`}
      {...touchContext}
    >
      <div className="fm-sidebar-scroll-area">
        {/* Quick Bookmarks */}
        <div className="fm-sidebar-section">
          <div className="fm-sidebar-title">Bookmarks</div>
          {bookmarks.map((bm) => {
            const isActive = currentPath === bm.path;
            return (
              <div
                key={bm.path}
                className={`fm-bookmark-item ${isActive ? "active" : ""}`}
                data-tree-path={bm.path}
                data-tree-label={bm.label}
                onClick={() => onNavigate(bm.path)}
                onContextMenu={(e) => handleContextMenu(e, bm.path, bm.label)}
              >
                {bm.icon}
                <span>{bm.label}</span>
                {bm.tag && <span className="fm-bookmark-tag">{bm.tag}</span>}
              </div>
            );
          })}
        </div>

        {/* Directory Hierarchy Tree */}
        <div className="fm-sidebar-section">
          <div className="fm-sidebar-title">Folder Tree</div>
          {treeData.map((rootNode) => renderTreeNode(rootNode, 0))}
        </div>
      </div>

      {/* Disk Storage Status Widget */}
      {!isCompact && diskStats && (
        <div className="fm-sidebar-disk-section">
          <div
            className="fm-sidebar-title"
            style={{ display: "flex", alignItems: "center", padding: "0 4px 4px 4px" }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <HardDrive size={13} color="var(--modern-accent, #61d2c3)" />
              Disk Storage
            </span>
          </div>

          <div className="fm-disk-card">
            <div className="fm-disk-bar-track">
              <div
                className="fm-disk-bar-fill"
                style={{
                  width: `${diskStats.usedPercent}%`,
                  background:
                    diskStats.usedPercent > 90
                      ? "var(--modern-danger, #ff7a8c)"
                      : diskStats.usedPercent > 75
                      ? "var(--modern-warning, #efc56c)"
                      : "var(--modern-accent, #61d2c3)"
                }}
              />
            </div>

            <div className="fm-disk-meta-row">
              <span>Used: <strong>{diskStats.usedFormatted}</strong></span>
              <span>Free: <strong>{diskStats.freeFormatted}</strong></span>
            </div>

            <div className="fm-disk-meta-row secondary">
              <span>Total: {diskStats.totalFormatted} ({diskStats.usedPercent}%)</span>
              <span className="fm-disk-tag" title="Daily cached background scan">
                Cached daily
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Right-click Context Menu */}
      {contextMenu && (
        <div
          className="fm-context-menu"
          style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 1000
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="fm-context-menu-header">
            <span className="fm-context-menu-filename" title={contextMenu.path}>
              {contextMenu.label}
            </span>
          </div>
          <div className="fm-context-menu-separator" />
          <button
            type="button"
            className="fm-context-menu-item primary"
            onClick={() => void handleCopyPath(contextMenu.path)}
          >
            <Copy size={14} color="var(--modern-accent, #61d2c3)" />
            <span>Copy Path</span>
          </button>
          <button
            type="button"
            className="fm-context-menu-item"
            onClick={() => {
              setContextMenu(null);
              onNavigate(contextMenu.path);
            }}
          >
            <Folder size={14} color="#ffd43b" />
            <span>Open Folder</span>
          </button>
        </div>
      )}

      {/* Copied Notice Toast */}
      {copiedNotice && (
        <div className="fm-toast-notice">
          <Check size={14} color="#65d8a3" />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {copiedNotice}
          </span>
        </div>
      )}
    </div>
  );
}
