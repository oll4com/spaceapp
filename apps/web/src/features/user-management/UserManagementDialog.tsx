import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent
} from "react";
import type { AdminUserItem, UserInvite, UserInviteRole } from "@space/contracts";
import { Users, X, Search, RefreshCw, Copy } from "../ui-theme/app-icons.js";
import { api, SpaceApiError } from "../../api.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
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
  // null: multi-user accounts are off (404 MULTI_USER_DISABLED) or not for this role, so none of it is shown.
  const [invites, setInvites] = useState<UserInvite[] | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<UserInviteRole>("USER");
  // The invite token is returned once; the link lives only in this state until Done.
  const [inviteLink, setInviteLink] = useState<string | null>(null);

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

  const fetchInvites = useCallback(async () => {
    try {
      setInvites((await api.listUserInvites()).invites);
    } catch (err) {
      setInvites(null);
      if (!(err instanceof SpaceApiError && (err.status === 404 || err.status === 403))) {
        setError(err instanceof Error ? err.message : "Failed to load invites");
      }
    }
  }, []);

  useEffect(() => {
    void fetchUsers();
    void fetchInvites();
  }, [fetchUsers, fetchInvites]);

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

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const { token } = await api.createUserInvite({ email: inviteEmail.trim(), role: inviteRole });
      setInviteLink(`${window.location.origin}/invite#token=${token}`);
      setInviteEmail("");
      await fetchInvites();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the invite");
    }
  }

  async function handleRevoke(invite: UserInvite) {
    setError(null);
    try {
      await api.revokeUserInvite(invite.id);
      await fetchInvites();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to revoke the invite for ${invite.email}`);
    }
  }

  async function handleActiveChange(user: AdminUserItem, active: boolean) {
    setUpdatingUserId(user.id);
    setError(null);
    try {
      await api.setUserDisabled(user.id, !active);
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, disabled: !active } : u)));
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to update ${user.email}`);
    } finally {
      setUpdatingUserId(null);
    }
  }

  function inviteStatus(invite: UserInvite) {
    if (invite.acceptedAt) return "Accepted";
    if (invite.revokedAt) return "Revoked";
    if (Date.parse(invite.expiresAt) <= Date.now()) return "Expired";
    return `Open until ${formatDate(invite.expiresAt)}`;
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
            onClick={() => {
              void fetchUsers();
              void fetchInvites();
            }}
            disabled={loading}
          >
            <RefreshCw aria-hidden="true" width={14} height={14} />
            <span>Refresh</span>
          </button>
        </div>

        <div className="user-management-body">
          {error ? <div className="user-management-error">{error}</div> : null}

          {invites ? (
            <section className="user-management-invites" aria-label="Invites">
              <form className="user-management-invite-form" onSubmit={(event) => void handleInvite(event)}>
                <input
                  type="email"
                  required
                  placeholder="name@example.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  aria-label="Invite email"
                />
                <select
                  className="role-select"
                  value={inviteRole}
                  aria-label="Invite role"
                  onChange={(e) => setInviteRole(e.target.value as UserInviteRole)}
                >
                  <option value="USER">USER</option>
                  <option value="OPERATOR">OPERATOR</option>
                </select>
                <button type="submit" className="button">Invite</button>
              </form>
              {inviteLink ? (
                <div className="user-management-invite-link" role="status">
                  <span>Send this link to the invited person. It is shown only once.</span>
                  <code>{inviteLink}</code>
                  <button
                    type="button"
                    className="button"
                    onClick={() => void navigator.clipboard?.writeText(inviteLink).catch(() => setError("Copy failed; select the link and copy it."))}
                  >
                    <Copy aria-hidden="true" width={14} height={14} />
                    <span>Copy link</span>
                  </button>
                  <button type="button" className="button" onClick={() => setInviteLink(null)}>Done</button>
                </div>
              ) : null}
              {invites.length > 0 ? (
                <ul className="user-management-invite-list">
                  {invites.map((invite) => {
                    const status = inviteStatus(invite);
                    return (
                      <li key={invite.id}>
                        <span className="user-cell-email">{invite.email}</span>
                        <span className={`user-role-badge user-role-${invite.role.toLowerCase()}`}>{invite.role}</span>
                        <span className="user-management-invite-status">{status}</span>
                        {status.startsWith("Open") ? (
                          <button
                            type="button"
                            className="button"
                            aria-label={`Revoke invite for ${invite.email}`}
                            onClick={() => void handleRevoke(invite)}
                          >
                            Revoke
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          ) : null}

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
                  {invites ? <th>Active</th> : null}
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
                      <td data-label="Current role">
                        <span
                          className={`user-role-badge user-role-${user.role.toLowerCase()}`}
                        >
                          {user.role}
                        </span>
                      </td>
                      <td data-label="Change role">
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
                      <td data-label="Rooms">{user.roomCount}</td>
                      {invites ? (
                        <td data-label="Active">
                          <SpaceToggle
                            compact
                            label="Active"
                            ariaLabel={`Active account ${user.email}`}
                            checked={!user.disabled}
                            disabled={isCurrent || user.id === "user:owner" || isUpdating}
                            title={isCurrent || user.id === "user:owner" ? "The owner and your own account cannot be disabled" : undefined}
                            onChange={(active) => void handleActiveChange(user, active)}
                          />
                        </td>
                      ) : null}
                      <td data-label="Created">{formatDate(user.createdAt)}</td>
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
