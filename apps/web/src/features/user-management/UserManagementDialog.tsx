import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import type { AdminUserItem } from "@space/contracts";
import { Users, X, Search, RefreshCw } from "../ui-theme/app-icons.js";
import { api } from "../../api.js";
import { formatAppDate } from "../date-time-settings/date-time-settings.js";
import "./user-management.css";

export interface UserManagementDialogProps {
  embedded?: boolean;
  currentUserId?: string;
  onClose: () => void;
}

export function UserManagementDialog({
  embedded = false,
  currentUserId,
  onClose
}: UserManagementDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.listAdminUsers();
      setUsers(response.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled)"
      ) ?? []
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function handleRoleChange(user: AdminUserItem, newRole: "ADMIN" | "USER") {
    if (user.role === newRole) return;
    if (user.id === currentUserId) {
      setError("You cannot change your own role.");
      return;
    }
    setUpdatingUserId(user.id);
    setError(null);
    try {
      await api.updateUserRole(user.id, newRole);
      setUsers((prev) =>
        prev.map((u) => (u.id === user.id ? { ...u, role: newRole } : u))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to update role for ${user.email}`);
    } finally {
      setUpdatingUserId(null);
    }
  }

  const filteredUsers = users.filter((u) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return u.email.toLowerCase().includes(q) || u.role.toLowerCase().includes(q);
  });

  function formatDate(iso: string) {
    try {
      return formatAppDate(iso);
    } catch {
      return iso;
    }
  }

  return (
    <div
      className={`user-management-backdrop${embedded ? " manage-embedded" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="user-management-dialog"
        role={embedded ? "region" : "dialog"}
        aria-modal={embedded ? undefined : true}
        aria-label="Users and Permissions"
        onKeyDown={handleKeyDown}
      >
        <header className="user-management-header">
          <span className="user-management-icon">
            <Users aria-hidden="true" />
          </span>
          <div>
            <h2>Users &amp; Permissions</h2>
            <p>Manage user accounts, roles, and room ownership in Space.</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="user-management-close-btn"
            aria-label="Close user management dialog"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="user-management-toolbar">
          <div className="user-management-search">
            <Search aria-hidden="true" width={16} height={16} />
            <input
              type="search"
              placeholder="Filter by email or role..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Filter users"
            />
          </div>
          <button
            type="button"
            className="button"
            style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
            onClick={() => void fetchUsers()}
            disabled={loading}
          >
            <RefreshCw aria-hidden="true" width={14} height={14} />
            <span>Refresh</span>
          </button>
        </div>

        <div className="user-management-body">
          {error ? <div className="user-management-error">{error}</div> : null}

          {loading && users.length === 0 ? (
            <div className="user-management-loading">Loading users...</div>
          ) : filteredUsers.length === 0 ? (
            <div className="user-management-empty">
              {users.length === 0 ? "No users found." : "No users match your filter."}
            </div>
          ) : (
            <table className="user-management-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Current Role</th>
                  <th>Change Role</th>
                  <th>Rooms</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((user) => {
                  const isCurrent = user.id === currentUserId;
                  const isOperator = user.role === "OPERATOR";
                  const isUpdating = updatingUserId === user.id;

                  return (
                    <tr key={user.id}>
                      <td>
                        <div className="user-cell-profile">
                          <div className="user-avatar-circle">
                            {user.avatarUrl ? (
                              <img src={user.avatarUrl} alt="" />
                            ) : (
                              user.email.slice(0, 1).toUpperCase()
                            )}
                          </div>
                          <div>
                            <span className="user-cell-email">{user.email}</span>
                            {isCurrent ? (
                              <span className="user-current-tag">You</span>
                            ) : null}
                            {user.googleId ? (
                              <span className="user-google-badge" title="Signed in with Google">
                                Google
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td>
                        <span
                          className={`user-role-badge user-role-${user.role.toLowerCase()}`}
                        >
                          {user.role}
                        </span>
                      </td>
                      <td>
                        {isOperator ? (
                          <span style={{ fontSize: "0.75rem", color: "var(--room-muted, #a7a59e)" }}>
                            Fixed Operator
                          </span>
                        ) : (
                          <select
                            className="role-select"
                            value={user.role}
                            disabled={isCurrent || isUpdating}
                            aria-label={`Role for ${user.email}`}
                            title={isCurrent ? "You cannot modify your own role" : undefined}
                            onChange={(e) =>
                              void handleRoleChange(
                                user,
                                e.target.value as "ADMIN" | "USER"
                              )
                            }
                          >
                            <option value="USER">USER</option>
                            <option value="ADMIN">ADMIN</option>
                          </select>
                        )}
                      </td>
                      <td>{user.roomCount}</td>
                      <td>{formatDate(user.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <footer className="user-management-footer">
          <span>Total users: {users.length}</span>
          <span>New Google users default to USER role with their own isolated workspace</span>
        </footer>
      </section>
    </div>
  );
}
