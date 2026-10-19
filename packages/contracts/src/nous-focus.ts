import { z } from "zod";

/**
 * Nous brings the operator to a pane that needs them (plan clipboard:twwygEtD4uuX): the stream carries ids only, like
 * notifications (every signed-in user receives every event); the owner's visible tab names the room and pane itself.
 */
export const nousFocusRequestPayloadSchema = z.object({
  requestId: z.string().min(1).max(120),
  ownerUserId: z.string().min(1).max(200),
  roomId: z.string().min(1).max(120),
  paneId: z.string().min(1).max(120)
}).strict();
export type NousFocusRequestPayload = z.infer<typeof nousFocusRequestPayloadSchema>;
