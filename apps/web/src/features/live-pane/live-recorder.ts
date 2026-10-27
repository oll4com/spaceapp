/**
 * Records a Live session into the room's Media: the microphone and the assistant's voice (tapped from the
 * session's playback into a destination that plays nowhere, so nothing echoes) mixed into one audio track,
 * plus the Real View video while it is on. Nothing starts without the operator's switch; a recording stops
 * after `LIVE_RECORDING_MAX_MS` and is uploaded as `source: "LIVE_RECORDING"`.
 */
import { api } from "../../api.js";
import type { Artifact } from "@space/contracts";
import type { LiveSessionHandle } from "./live-session.js";

export const LIVE_RECORDING_MAX_MS = 10 * 60_000;
export const LIVE_RECORDING_VIDEO_MIME = "video/webm;codecs=vp9,opus";
export const LIVE_RECORDING_AUDIO_MIME = "audio/webm;codecs=opus";
export const LIVE_RECORDING_VIDEO_BRIEF = "The Live session recorded just now";

export interface LiveRecorderState {
  status: "idle" | "recording" | "saving" | "saved" | "error";
  startedAt: number | null;
  /** True when the Real View was recorded; otherwise audio only (an audio/webm EXPORT artifact, not a VIDEO). */
  video: boolean;
  artifact: Artifact | null;
  videoRequestId: string | null;
  reason: string | null;
}

export interface LiveRecorderOptions {
  roomId: string;
  paneId: string;
  getHandle: () => LiveSessionHandle | null;
  onState: (state: LiveRecorderState) => void;
  upload?: typeof api.uploadPaneFiles;
  requestVideo?: typeof api.requestVideoFromPane;
  createAudioContext?: () => AudioContext;
  createRecorder?: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder;
  now?: () => number;
  maxMs?: number;
}

function supportedMime(preferred: string, fallback: string): string {
  const probe = typeof MediaRecorder !== "undefined" ? MediaRecorder.isTypeSupported : undefined;
  return !probe || probe.call(MediaRecorder, preferred) ? preferred : fallback;
}

export function createLiveRecorder(options: LiveRecorderOptions) {
  const upload = options.upload ?? ((input: Parameters<typeof api.uploadPaneFiles>[0]) => api.uploadPaneFiles(input));
  const requestVideo = options.requestVideo ?? ((paneId: string, input: Parameters<typeof api.requestVideoFromPane>[1]) => api.requestVideoFromPane(paneId, input));
  const now = options.now ?? (() => Date.now());
  const maxMs = options.maxMs ?? LIVE_RECORDING_MAX_MS;
  let state: LiveRecorderState = { status: "idle", startedAt: null, video: false, artifact: null, videoRequestId: null, reason: null };
  let realView: MediaStream | null = null;
  let context: AudioContext | null = null;
  let mix: MediaStreamAudioDestinationNode | null = null;
  let sources: AudioNode[] = [];
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  const publish = (patch: Partial<LiveRecorderState>) => { state = { ...state, ...patch }; options.onState(state); };

  /** Connects the session's microphone and voice into the mix; run again after a reconnect replaced the session. */
  function tap() {
    const handle = options.getHandle();
    if (!handle?.microphone || !handle.tapPlayback) throw new Error("Start the Live conversation before recording it.");
    const streams = [handle.microphone, handle.tapPlayback()].filter((stream) => stream.getAudioTracks().length > 0);
    const next = streams.map((stream) => context!.createMediaStreamSource(stream));
    sources.forEach((node) => { try { node.disconnect(); } catch { /* already gone */ } });
    sources = next;
    for (const node of sources) node.connect(mix!);
  }

  function release() {
    if (capTimer !== null) { clearTimeout(capTimer); capTimer = null; }
    sources.forEach((node) => { try { node.disconnect(); } catch { /* already gone */ } });
    sources = [];
    recorder = null;
    mix = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
    context = null;
  }

  async function save(video: boolean) {
    const type = video ? "video/webm" : "audio/webm";
    const blob = new Blob(chunks, { type });
    chunks = [];
    release();
    if (!blob.size) { publish({ status: "error", reason: "Nothing was recorded." }); return; }
    publish({ status: "saving" });
    try {
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
      const res = await upload({ roomId: options.roomId, paneId: options.paneId, source: "LIVE_RECORDING", files: [new File([blob], `live-${stamp}.webm`, { type })] });
      const artifact = res.artifacts[0];
      if (!artifact) throw new Error("The upload returned no artifact.");
      publish({ status: "saved", artifact });
      // Best effort: the voice model learns the artifact id so it can name it as a source of space_request_video.
      options.getHandle()?.notify?.(`The session recording was saved as Media artifact ${artifact.id}. To make a video from it, call space_request_video with sourceArtifactIds ["${artifact.id}"].`, `live-recording:${artifact.id}`);
    } catch (error) {
      publish({ status: "error", reason: error instanceof Error ? error.message : "The recording could not be saved." });
    }
  }

  function start() {
    if (state.status === "recording" || state.status === "saving") return;
    try {
      context = (options.createAudioContext ?? (() => new AudioContext()))();
      mix = context.createMediaStreamDestination();
      tap();
      // shortcut: the Real View live when the recording starts is the video; one started later is not added (MediaRecorder takes no new track), upgrade by restarting the recorder on Real View changes.
      const videoTrack = realView?.getVideoTracks().find((track) => track.readyState === "live") ?? null;
      const stream = videoTrack ? new MediaStream([videoTrack, ...mix.stream.getAudioTracks()]) : mix.stream;
      const mimeType = videoTrack ? supportedMime(LIVE_RECORDING_VIDEO_MIME, "video/webm") : supportedMime(LIVE_RECORDING_AUDIO_MIME, "audio/webm");
      chunks = [];
      const active = (options.createRecorder ?? ((input, init) => new MediaRecorder(input, init)))(stream, { mimeType, videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 96_000 });
      recorder = active;
      active.ondataavailable = (event) => { if (event.data && event.data.size > 0) chunks.push(event.data); };
      active.onstop = () => { if (recorder === active) void save(Boolean(videoTrack)); };
      active.onerror = () => { if (recorder === active) stop(); };
      active.start(1000);
      capTimer = setTimeout(stop, maxMs);
      publish({ status: "recording", startedAt: now(), video: Boolean(videoTrack), artifact: null, videoRequestId: null, reason: null });
    } catch (error) {
      release();
      publish({ status: "error", reason: error instanceof Error ? error.message : "The recording could not start." });
    }
  }

  function stop() {
    if (capTimer !== null) { clearTimeout(capTimer); capTimer = null; }
    if (recorder && recorder.state === "recording") { try { recorder.stop(); return; } catch { /* fall through */ } }
    if (recorder) release();
  }

  async function makeVideo() {
    const artifact = state.artifact;
    if (!artifact) throw new Error("No recording was saved.");
    const res = await requestVideo(options.paneId, { brief: LIVE_RECORDING_VIDEO_BRIEF, sources: [{ artifactId: artifact.id }] });
    publish({ videoRequestId: res.request.id });
    return res;
  }

  return {
    start,
    stop,
    makeVideo,
    /** Re-taps the current session's microphone and voice (after a reconnect). */
    retap: () => { if (state.status === "recording") { try { tap(); } catch { /* the next session start taps again */ } } },
    /** The Real View stream to record from the next start on. */
    setRealView: (stream: MediaStream | null) => { realView = stream; },
    getState: () => state
  };
}
