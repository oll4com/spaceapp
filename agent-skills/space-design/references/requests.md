# Requests

A request carries the requester (a pane, an agent, Nous, a Dot or the operator), the brief, the formats, an optional
engine, brand kit and reference artifacts, and an optional callback (a Marketing Copilot post the delivery attaches to).

| Status | Meaning |
|---|---|
| `QUEUED` | Waiting; routed to a Design pane, or to none yet ("Open a Design pane" notification) |
| `TAKEN` | A Design pane took it with `space_design_next` |
| `IN_PROGRESS` | The designer is generating, rendering or asked a question |
| `NEEDS_APPROVAL` | Delivered by the designer; the pane's setting holds it for the operator's approval |
| `DELIVERED` | The requester has the assets (and a Marketing post its graphics) |
| `FAILED` | The designer could not make it; `message` says why |
| `CANCELLED` | The requester or the operator cancelled it |

Routing: an explicit `designPaneId`, else an open Design pane in the requester's room, else the owner's most recently
active unpaused one. A request nobody takes for 30 minutes after it was taken goes back to the queue.

Every step is in the pane's Requests tab and Activity; the operator answers questions and approves deliveries there.
Notifications: queued without a pane, a question, approval needed, a failure (attention) and a delivery (information),
per the pane's notification settings.
