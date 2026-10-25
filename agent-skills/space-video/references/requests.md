# Requests

A request carries the requester (a pane, an agent, Nous, a Dot, the Live pane or the operator), the brief, the sources, the
formats, the options (technique, reframe, transition, filter, captions, narration, music, longest duration) and an optional
callback (a Marketing Copilot post the delivery attaches to).

| Status | Meaning |
|---|---|
| `QUEUED` | Waiting; routed to a Video pane, or to none yet ("Open a Video pane" notification) |
| `TAKEN` | A Video pane took it with `space_video_next` |
| `IN_PROGRESS` | The editor is working (every engine job marks it) or asked a question |
| `NEEDS_APPROVAL` | Delivered by the editor; the pane's setting holds it for the operator's approval |
| `DELIVERED` | The requester has the outputs (and a Marketing post its video); a corrected delivery replaces them |
| `FAILED` | The editor could not make it; `message` says why |
| `CANCELLED` | The requester or the operator cancelled it |

Routing: an explicit `videoPaneId`, else an open Video pane in the requester's room, else the owner's most recently active
unpaused one; with none open, one opens in the requester's room. A request nobody takes for 30 minutes after it was taken goes
back to the queue.

What a requester reads of each delivered output (`space_video_request_status`, `space_video_request_wait`): `assetId`,
`artifactId`, `thumbnailArtifactId` (the poster frame), `label`, `formatId`, `width` × `height`, `durationSec`, `mimeType`,
`kind`, `description`, `madeBy` (`by` AGENT or OPERATOR, `runtimeId`, `model`), `credits`, `parentAssetId`, `createdAt` and
`replacedBy` (the newest later version in the same format).

Jobs: every engine call (fetch, probe, transcribe, analyze, assemble, tts) answers `{job}` with `id`, `status` (QUEUED, RUNNING,
DONE, FAILED), `progress`, `message`, `result` and `error`; `space_video_job_wait` waits up to 300 s. One job at a time per
owner; finished jobs stay readable for an hour. Files live in the pane's work folder for a day; outputs are saved to Media when
you assemble.

Every step is in the pane's Requests tab and Activity; the operator answers questions and approves deliveries there.
Notifications: queued without a pane, a question, approval needed, a failure (attention) and a delivery (information), per the
pane's notification settings.
