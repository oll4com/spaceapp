import { getSpaceVolume, subscribeSpaceVolume } from "../../space-audio.js";
import type { Cue } from "./engine.js";

/** No context, timer, sample download or sound exists until Music is enabled. */
export class ArcadeAudio {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private unsubscribe: (() => void) | null = null;
  private nextBeat = 0;
  private beat = 0;
  private active = false;
  private disposed = false;
  private voices = new Set<OscillatorNode>();
  async enable(): Promise<boolean> {
    if (this.disposed) return false;
    try {
      if (!this.context) {
        this.context = new AudioContext(); this.gain = this.context.createGain();
        this.gain.gain.value = getSpaceVolume() * .32; this.gain.connect(this.context.destination);
        this.unsubscribe = subscribeSpaceVolume(volume => {
          if (this.context && this.gain) this.gain.gain.setTargetAtTime(volume * .32, this.context.currentTime, .04);
        });
      }
      this.active = true;
      await this.context.resume();
      if (this.disposed || !this.active) return false;
      this.nextBeat = this.context.currentTime;
      return this.context.state === "running";
    } catch { this.active = false; return false; }
  }
  pause() {
    this.active = false;
    for (const voice of this.voices) { try { voice.stop(); } catch { /* Already ended. */ } }
    this.voices.clear();
    if (this.context?.state === "running") void this.context.suspend().catch(() => {});
  }
  tick(sector: number, biome = "") {
    const ctx = this.context;
    if (!this.active || !ctx || ctx.state !== "running") return;
    if (ctx.currentTime < this.nextBeat) return;
    const progression = [0, 0, -3, -5], melody = [0, 7, 12, 7, 3, 10, 15, 10];
    const root = 110 * 2 ** (progression[Math.floor(this.beat / 16) % 4]! / 12);
    const note = melody[this.beat % melody.length]!;
    this.tone(root * 2 ** (note / 12), .14, .16, "triangle");
    if (this.beat % 4 === 0) { this.tone(root / 2, .3, .28, "sine"); this.tone(95, .12, .3, "sine", 32); }
    if (this.beat % 2) this.tone(1500, .025, .018, "square", 600);
    if (biome === "storm" && this.beat % 2 === 0) this.tone(70, .2, .2, "sawtooth", 45);
    this.beat++; this.nextBeat = ctx.currentTime + 60 / (108 + Math.min(24, sector * 2)) / 4;
  }
  cue(cue: Cue) {
    if (!this.active) return;
    if (cue === "fire") this.tone(760, .055, .045, "triangle", 220);
    if (cue === "hit") this.tone(125, .1, .12, "sawtooth", 40);
    if (cue === "hurt") this.tone(160, .3, .24, "sawtooth", 35);
    if (cue === "pickup" || cue === "sector") this.tone(440, .25, .17, "sine", 880);
    if (cue === "dash") this.tone(100, .18, .12, "triangle", 700);
    if (cue === "rail") this.tone(1400, .18, .14, "sawtooth", 120);
    if (cue === "missile") this.tone(320, .12, .1, "square", 900);
    if (cue === "arc") this.tone(2000, .1, .08, "sawtooth", 300);
    if (cue === "overheat") this.tone(220, .25, .14, "square", 110);
    if (cue === "swap") this.tone(520, .09, .1, "sine", 780);
    if (cue === "bomb") this.tone(90, .5, .25, "sawtooth", 30);
  }
  private tone(frequency: number, duration: number, volume: number, type: OscillatorType, end?: number) {
    const ctx = this.context;
    if (!ctx || !this.gain || ctx.state !== "running" || this.voices.size >= 16) return;
    const osc = ctx.createOscillator(), envelope = ctx.createGain(), now = ctx.currentTime;
    osc.type = type; osc.frequency.setValueAtTime(frequency, now);
    if (end) osc.frequency.exponentialRampToValueAtTime(end, now + duration);
    envelope.gain.setValueAtTime(.0001, now); envelope.gain.exponentialRampToValueAtTime(volume, now + .008);
    envelope.gain.exponentialRampToValueAtTime(.0001, now + duration);
    osc.connect(envelope); envelope.connect(this.gain); this.voices.add(osc);
    osc.onended = () => { this.voices.delete(osc); osc.disconnect(); envelope.disconnect(); };
    osc.start(now); osc.stop(now + duration + .015);
  }
  dispose() {
    this.disposed = true; this.pause(); this.unsubscribe?.(); this.unsubscribe = null;
    if (this.context) void this.context.close().catch(() => {});
    this.context = null; this.gain = null;
  }
}
