import { useEffect, useRef, useState } from "react";
import type { RoomAgentStreamFrame } from "@space/contracts";
import { eventGateway } from "../../runtime/SpaceRuntime.js";

export interface RoomAgentStreamTool {
  rowId: string;
  name: string;
  label: string;
  status: string;
}

/** The answer the Room Agent is writing, as its stream shows it; empty between turns. */
export interface RoomAgentStreamState {
  messageId: string | null;
  text: string;
  tools: RoomAgentStreamTool[];
  phase: "idle" | RoomAgentStreamFrame["phase"];
  version: number;
}

const idle: RoomAgentStreamState = { messageId: null, text: "", tools: [], phase: "idle", version: 0 };

function parseFrame(data: string): RoomAgentStreamFrame | null {
  try {
    const frame = JSON.parse(data) as RoomAgentStreamFrame;
    return frame && typeof frame.phase === "string" && typeof frame.messageId === "string" ? frame : null;
  } catch {
    return null;
  }
}

/**
 * Opens the room's Room Agent stream only while the dock is visible (a hidden dock keeps no connection) and folds its
 * frames into one answer. On done or error the caller reloads the session, which then holds the saved answer.
 */
export function useRoomAgentStream(roomId: string | null, active: boolean, onFinished: (roomId: string) => void): RoomAgentStreamState {
  const [state, setState] = useState<RoomAgentStreamState>(idle);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(() => {
    setState(idle);
    if (!roomId || !active || !eventGateway.supported) return;
    let closed = false;
    const source = eventGateway.open(`/api/rooms/${encodeURIComponent(roomId)}/room-agent/stream`, { withCredentials: true });
    source.onmessage = (message: MessageEvent<string>) => {
      const frame = parseFrame(message.data);
      if (closed || !frame) return;
      if (frame.phase === "done" || frame.phase === "error") {
        setState((current) => ({ ...current, messageId: frame.messageId, text: frame.text ?? current.text, phase: frame.phase, version: current.version + 1 }));
        finishedRef.current(roomId);
        return;
      }
      setState((current) => {
        const base = current.messageId === frame.messageId && current.phase !== "done" && current.phase !== "error"
          ? current : { ...idle, version: current.version };
        if (frame.phase === "text") return { ...base, messageId: frame.messageId, text: frame.text ?? base.text, phase: "text", version: base.version + 1 };
        if (!frame.tool) return base;
        const tools = base.tools.some((tool) => tool.rowId === frame.tool!.rowId)
          ? base.tools.map((tool) => tool.rowId === frame.tool!.rowId ? frame.tool! : tool)
          : [...base.tools, frame.tool];
        return { ...base, messageId: frame.messageId, tools, phase: "tool", version: base.version + 1 };
      });
    };
    return () => {
      closed = true;
      source.close();
    };
  }, [roomId, active]);

  return state;
}
