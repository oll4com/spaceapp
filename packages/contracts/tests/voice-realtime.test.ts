import {
  voiceRealtimeSessionRequestSchema,
  voiceRealtimeSessionResponseSchema
} from "@space/contracts";
import { describe, expect, it } from "vitest";

describe("voice realtime contracts", () => {
  const offerSdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Space Voice\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
  const answerSdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=OpenAI\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

  it("preserves the terminal CRLF in WebRTC offer and answer SDP", () => {
    expect(voiceRealtimeSessionRequestSchema.parse({ offerSdp }).offerSdp).toBe(offerSdp);
    expect(voiceRealtimeSessionResponseSchema.parse({ answerSdp }).answerSdp).toBe(answerSdp);
  });

  it("rejects whitespace-only session descriptions", () => {
    expect(() => voiceRealtimeSessionRequestSchema.parse({ offerSdp: " ".repeat(40) })).toThrow();
    expect(() => voiceRealtimeSessionResponseSchema.parse({ answerSdp: "\r\n".repeat(20) })).toThrow();
  });

  it("accepts arbitrary voice model strings without throwing validation error", () => {
    const parsed = voiceRealtimeSessionRequestSchema.parse({
      offerSdp,
      model: "gpt-realtime-2.1",
      delegatedModel: "gpt-6-astra"
    });
    expect(parsed.model).toBe("gpt-realtime-2.1");
    expect(parsed.delegatedModel).toBe("gpt-6-astra");
  });
});
