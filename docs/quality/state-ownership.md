# State ownership for recovery review

| State | Ownership | Recovery rule |
| --- | --- | --- |
| Rooms, panes, tasks, sessions, events and artifact metadata | PostgreSQL stores (`packages/db/src`) | Persist intent and reconcile status with actual host/provider state; never recreate a native session solely from pane status |
| CLI process and terminal buffers | Independent CLI host (`packages/cli-host/src/session-registry.ts`) | API transport detachment must not terminate host-owned PTY; preserve immutable session identity |
| Provider conversation/context | Provider-native runtime storage | Resume only through supported native identity; copied transcripts are not native resume |
| Browser process and subscriptions | Browser host (`packages/browser-host/src`) | Transport subscriptions are disposable; browser state needs explicit recovery proof |
| Canonical memory source | Approved canonical files and mutation journal | Lock, compare expected hashes, journal, mutate, then reconcile/cache; preserve provenance |
| Memory embeddings and retrieval cache | Derived graph/vector state | Invalidate deleted/stale source records; rebuild from canonical sources and recorded versions |
| Agent file bytes | Artifact filesystem, identified by stored hash and metadata | Stream to exclusive partial file, verify complete bytes, journal intent, publish metadata, retain complete bytes on uncertain confirmation; reconcile by URI/hash/size |
| Upload staging | Temporary request-owned filesystem data | Never count as a completed artifact; delete on abort/error |
| UI visibility/warm cache | Derived frontend state | Preserve protected six-room/96-pane policy; no timed parking or session-host replacement |

This map describes ownership boundaries, not a completed distributed-consistency
proof. Artifact metadata/files and memory source/cache transitions need the
fault/restore matrix before atomicity or recovery claims can be strengthened.
