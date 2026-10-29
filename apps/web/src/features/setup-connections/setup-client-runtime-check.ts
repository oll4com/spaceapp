import { getSetupDependencyClosure, setupClientRuntimeFeatureSchema, setupClientRuntimeChallengeSchema, setupClientRuntimeObservationSchema,
  type SetupClientRuntimeFeatureId, type SetupClientRuntimeChallenge, type SetupClientRuntimeObservation, type SetupFeatureId } from "@space/contracts";

export interface SetupClientRuntimeClient {
  beginSetupClientRuntimeCheck?(featureId: SetupClientRuntimeFeatureId, draftRevision: number, signal?: AbortSignal): Promise<SetupClientRuntimeChallenge>;
  completeSetupClientRuntimeCheck?(checkId: string, observation: SetupClientRuntimeObservation, signal?: AbortSignal): Promise<{ verified: boolean }>;
  cancelSetupClientRuntimeCheck?(checkId: string): Promise<void>;
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("The browser tool check was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Executes existing feature code against synthetic local state; never mounts an operator pane or saves playback. */
export async function runSetupClientRuntimeCheck(featureId: SetupClientRuntimeFeatureId, challenge: string, signal: AbortSignal): Promise<SetupClientRuntimeObservation> {
  signal.throwIfAborted();
  if (featureId === "utility:osk") {
    const { OnScreenKeyboard, sendTextToInputOrFocused } = await import("../osk-keyboard/OnScreenKeyboard.js");
    signal.throwIfAborted();
    if (typeof OnScreenKeyboard !== "function") throw new Error("The on-screen keyboard is unavailable.");
    let observed = { text: "", terminalData: "" };
    sendTextToInputOrFocused(challenge, input => { observed = { text: input.text ?? "", terminalData: input.terminalData }; return true; });
    return setupClientRuntimeObservationSchema.parse({ featureId, ...observed });
  }
  if (featureId === "utility:asteroids") {
    const [{ AsteroidsEngine, emptyControls }, { createRenderer }] = await Promise.all([import("../asteroids/engine.js"), import("../asteroids/render.js")]);
    signal.throwIfAborted();
    const canvas = document.createElement("canvas");
    const game = new AsteroidsEngine(320, 240, () => 0.5);
    const renderer = createRenderer(canvas, game, { watermark: false });
    if (!renderer) throw new Error("Asteroids requires a supported canvas drawing context.");
    game.start(); const controls = { ...emptyControls(), fire: true, thrust: true };
    for (let tick = 0; tick < 30; tick++) game.step(1 / 60, controls);
    renderer.resize(320, 240); renderer.draw(controls, true);
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    const painted = pixels.some((value, index) => index % 4 === 3 && value > 0);
    return setupClientRuntimeObservationSchema.parse({ featureId, ticks: 30, elapsed: game.elapsed, shotsFired: game.shotsFired, painted });
  }
  const { loadYouTubeIframeApi } = await import("../vibe-music/youtubePlaylistPlayer.js");
  const stage = document.createElement("div");
  stage.style.cssText = "position:fixed;left:-10000px;top:0;width:320px;height:180px";
  stage.setAttribute("aria-hidden", "true");
  let player: InstanceType<Awaited<ReturnType<typeof loadYouTubeIframeApi>>["Player"]> | undefined;
  const deadline = new AbortController();
  const bounded = AbortSignal.any([signal, deadline.signal]);
  const timer = window.setTimeout(() => deadline.abort(), 15_000);
  try {
    const yt = await abortable(loadYouTubeIframeApi(), bounded);
    bounded.throwIfAborted(); document.body.append(stage);
    await abortable(new Promise<void>((resolve, reject) => {
      player = new yt.Player(stage, { width: 320, height: 180,
        playerVars: { autoplay: 0, mute: 1, origin: window.location.origin },
        events: { onReady: () => resolve(), onError: () => reject(new Error("The YouTube embed runtime is unavailable.")) } });
    }), bounded);
    bounded.throwIfAborted(); player!.setVolume(0); player!.pauseVideo();
    const iframe = stage.querySelector("iframe") ?? (player as unknown as { getIframe?: () => HTMLIFrameElement }).getIframe?.();
    const embedHost = iframe ? new URL(iframe.src).hostname : "";
    return setupClientRuntimeObservationSchema.parse({ featureId, ready: true, position: player!.getCurrentTime(), embedHost });
  } finally {
    window.clearTimeout(timer);
    try { player?.destroy(); } finally { stage.remove(); }
  }
}

export async function verifySelectedSetupClientRuntimes(client: SetupClientRuntimeClient, ids: SetupFeatureId[], revision: number, signal: AbortSignal): Promise<void> {
  const selected = getSetupDependencyClosure(ids);
  const features = setupClientRuntimeFeatureSchema.options.filter(id => selected.includes(id));
  if (!features.length) return;
  if (!client.beginSetupClientRuntimeCheck || !client.completeSetupClientRuntimeCheck || !client.cancelSetupClientRuntimeCheck) {
    throw new Error("Selected browser tools need the current setup client. Reload and retry.");
  }
  for (const featureId of features) {
    signal.throwIfAborted();
    const check = setupClientRuntimeChallengeSchema.parse(await client.beginSetupClientRuntimeCheck(featureId, revision, signal));
    let verified = false;
    try {
      if (check.featureId !== featureId) throw new Error("The browser tool challenge changed. Retry setup.");
      const observation = await runSetupClientRuntimeCheck(featureId, check.challenge, signal);
      signal.throwIfAborted();
      verified = (await client.completeSetupClientRuntimeCheck(check.checkId, observation, signal)).verified === true;
      if (!verified) throw new Error("The selected browser tool did not pass its server check. Retry or remove it.");
    } finally { if (!verified) await client.cancelSetupClientRuntimeCheck(check.checkId).catch(() => undefined); }
  }
}
