import type { WebSocket } from "ws";

// One write and one replaceable frame; a bounded window follows viewer RTT.
// Socket write completion alone cannot bound buffering across the internet.
export function createBrowserLiveSender(socket: Pick<WebSocket, "readyState" | "send">, requireFrameAck = false) {
  let writing = false;
  const outstanding: Array<{ sentAt: number; bytes: number }> = [];
  let outstandingBytes = 0;
  let frameWindow = 4;
  const ackLatencies: number[] = [];
  const maxOutstandingBytes = 2 * 1024 * 1024;
  let latest: { data: Buffer; dimensions?: { width: number; height: number } } | null = null;
  let dimensionsSent = "";
  let stopped = false;
  const flush = () => {
    if (stopped || writing || !latest || socket.readyState !== 1 || (requireFrameAck && (outstanding.length >= frameWindow || (outstanding.length > 0 && outstandingBytes + latest.data.length > maxOutstandingBytes)))) return;
    const frame = latest;
    latest = null;
    writing = true;
    if (requireFrameAck) {
      outstanding.push({ sentAt: performance.now(), bytes: frame.data.length });
      outstandingBytes += frame.data.length;
    }
    try {
      const dimensions = frame.dimensions ? JSON.stringify({ type: "viewport", dimensions: frame.dimensions }) : "";
      if (dimensions && dimensions !== dimensionsSent) {
        socket.send(dimensions, { binary: false, compress: false });
        dimensionsSent = dimensions;
      }
      socket.send(frame.data, { binary: true, compress: false }, (error) => {
        writing = false;
        if (error) { stopped = true; latest = null; return; }
        flush();
      });
    } catch {
      stopped = true;
      writing = false;
      latest = null;
    }
  };
  return {
    present(data: Buffer, dimensions?: { width: number; height: number }) { if (!stopped) { latest = { data, dimensions }; flush(); } },
    acknowledge() {
      const frame = outstanding.shift();
      if (!frame || stopped) return;
      outstandingBytes -= frame.bytes;
      ackLatencies.push(Math.max(0, performance.now() - frame.sentAt));
      if (ackLatencies.length > 32) ackLatencies.shift();
      // Four frames cap a 250ms connection at 16fps even with ample bandwidth.
      // Use the recent minimum RTT to avoid growing for transient congestion,
      // while allowing up to 35fps across a longer link. Memory stays bounded.
      frameWindow = Math.min(24, Math.max(4, Math.ceil(Math.min(...ackLatencies) * 35 / 1000) + 2));
      flush();
    },
    stop() { stopped = true; latest = null; outstanding.length = 0; outstandingBytes = 0; }
  };
}
