import { getSpaceVolume } from "../../space-audio.js";

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
      sharedAudioCtx = new AudioContextClass();
    }
    if (sharedAudioCtx.state === "suspended") {
      void sharedAudioCtx.resume();
    }
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

export type ChimeToneType = "timer-done" | "pushup-alert" | "click" | "log-done";

/**
 * Synthesizes clear, harmonic tones without external audio assets.
 * Respects system space volume preferences.
 */
export function playChime(type: ChimeToneType): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const baseVolume = getSpaceVolume();
    if (baseVolume <= 0) return;

    const now = ctx.currentTime;

    if (type === "click") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(800, now);
      gain.gain.setValueAtTime(baseVolume * 0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.04);
      return;
    }

    if (type === "timer-done") {
      // Pleasant dual bell chime: D5 (587.33 Hz) -> A5 (880.00 Hz)
      const notes = [
        { freq: 587.33, start: 0, duration: 0.35 },
        { freq: 880.00, start: 0.18, duration: 0.55 },
        { freq: 1174.66, start: 0.36, duration: 0.65 }
      ];

      for (const note of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(note.freq, now + note.start);
        gain.gain.setValueAtTime(0.001, now + note.start);
        gain.gain.linearRampToValueAtTime(baseVolume * 0.28, now + note.start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + note.start + note.duration);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + note.start);
        osc.stop(now + note.start + note.duration + 0.05);
      }
      return;
    }

    if (type === "pushup-alert") {
      // Energetic triumph sequence: C5 (523.25) -> E5 (659.25) -> G5 (783.99) -> C6 (1046.50)
      const notes = [
        { freq: 523.25, start: 0, duration: 0.15 },
        { freq: 659.25, start: 0.12, duration: 0.15 },
        { freq: 783.99, start: 0.24, duration: 0.22 },
        { freq: 1046.50, start: 0.38, duration: 0.45 }
      ];

      for (const note of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(note.freq, now + note.start);
        gain.gain.setValueAtTime(0.001, now + note.start);
        gain.gain.linearRampToValueAtTime(baseVolume * 0.32, now + note.start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + note.start + note.duration);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + note.start);
        osc.stop(now + note.start + note.duration + 0.05);
      }
      return;
    }

    if (type === "log-done") {
      // Quick encouraging chime
      const notes = [
        { freq: 440.00, start: 0, duration: 0.12 },
        { freq: 659.25, start: 0.10, duration: 0.28 }
      ];

      for (const note of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(note.freq, now + note.start);
        gain.gain.setValueAtTime(0.001, now + note.start);
        gain.gain.linearRampToValueAtTime(baseVolume * 0.25, now + note.start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + note.start + note.duration);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + note.start);
        osc.stop(now + note.start + note.duration + 0.05);
      }
    }
  } catch {
    // Graceful fallback if Web Audio is blocked or unavailable
  }
}
