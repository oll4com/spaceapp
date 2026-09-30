export function pcm16FromFloat32(input: Float32Array): ArrayBuffer {
  const output = new ArrayBuffer(input.length * 2);
  const view = new DataView(output);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return output;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export function createAudioContextWithFallback(sampleRate?: number): AudioContext {
  const AudioContextClass =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("AudioContext is not supported in this browser.");
  }
  if (sampleRate) {
    try {
      return new AudioContextClass({ sampleRate });
    } catch {
      // Fallback to hardware default rate
    }
  }
  return new AudioContextClass();
}

export function downsampleBuffer(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || toRate <= 0 || fromRate <= 0) return input;
  const ratio = fromRate / toRate;
  const newLength = Math.round(input.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetInput = 0;
  while (offsetResult < result.length) {
    const nextOffsetInput = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetInput; i < nextOffsetInput && i < input.length; i++) {
      accum += input[i] ?? 0;
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : (input[offsetInput] ?? 0);
    offsetResult++;
    offsetInput = nextOffsetInput;
  }
  return result;
}

export function mergeTranscriptText(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;
  const curTrim = current.trim();
  const incTrim = incoming.trim();
  if (!curTrim) return incoming;
  if (!incTrim) return current;

  if (curTrim === incTrim) return current;

  if (incTrim.startsWith(curTrim)) {
    return incoming;
  }

  if (curTrim.startsWith(incTrim)) {
    return current;
  }

  const maxOverlap = Math.min(curTrim.length, incTrim.length);
  for (let len = maxOverlap; len >= 2; len--) {
    if (curTrim.slice(-len).toLowerCase() === incTrim.slice(0, len).toLowerCase()) {
      return `${curTrim}${incTrim.slice(len)}`;
    }
  }

  return `${current} ${incoming}`;
}
