import { useEffect, useMemo, useState } from "react";
import type { AdminUserItem, Room } from "@space/contracts";
import { api } from "../../api.js";

// The account directory behind the admin's "Filter rooms by account" control.

export interface AdminUsers {
  adminUsersList: AdminUserItem[];
  userEmailById: Map<string, string>;
  /** Accounts with their room count taken from the live room catalog. */
  adminUsersListWithLiveCounts: AdminUserItem[];
}

export function useAdminUsers(role: string | undefined, rooms: Room[], startupReady = true): AdminUsers {
  const [adminUsersList, setAdminUsersList] = useState<AdminUserItem[]>([]);

  useEffect(() => {
    if (role === "ADMIN" && startupReady) {
      api.listAdminUsers()
        .then((res) => {
          if (Array.isArray(res?.users)) {
            setAdminUsersList(res.users);
          }
        })
        .catch(() => {});
    }
  }, [role, startupReady]);

  const userEmailById = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of adminUsersList) {
      map.set(u.id, u.email || u.id);
    }
    return map;
  }, [adminUsersList]);

  // Compute live room counts per user from the current rooms state
  // (overrides the DB snapshot count from listAdminUsers which may be stale)
  const liveRoomCountByUserId = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rooms) {
      if (r.ownerUserId) {
        map.set(r.ownerUserId, (map.get(r.ownerUserId) ?? 0) + 1);
      }
    }
    return map;
  }, [rooms]);

  // Merge adminUsersList with live room counts
  const adminUsersListWithLiveCounts = useMemo(() => {
    return adminUsersList.map((u) => ({
      ...u,
      roomCount: liveRoomCountByUserId.get(u.id) ?? u.roomCount,
    }));
  }, [adminUsersList, liveRoomCountByUserId]);

  return { adminUsersList, userEmailById, adminUsersListWithLiveCounts };
}
