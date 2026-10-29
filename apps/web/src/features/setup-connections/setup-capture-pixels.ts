/** Reject unrelated crops locally and serialize only the validated synthetic tile samples. */
export function buildSetupCaptureProofPixels(crop: Uint8ClampedArray, colors: string[]): string {
  if (crop.length !== 4096 || colors.length !== 64 || colors.some(color => !/^#[a-f0-9]{6}$/i.test(color))) {
    throw new Error("The capture test pattern could not be read.");
  }
  const safe = new Uint8Array(4096);
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
    const at = ((row * 4 + 2) * 32 + col * 4 + 2) * 4;
    const sample = crop.slice(at, at + 4); const color = colors[row * 8 + col]!;
    if (sample[3] !== 255 || [0, 1, 2].some(channel =>
      Math.abs(sample[channel]! - parseInt(color.slice(1 + channel * 2, 3 + channel * 2), 16)) > 12)) {
      throw new Error("The captured area does not match this test pattern. Select this Space tab and try again.");
    }
    for (let y = row * 4; y < row * 4 + 4; y++) for (let x = col * 4; x < col * 4 + 4; x++) {
      safe.set(sample, (y * 32 + x) * 4);
    }
  }
  return btoa(String.fromCharCode(...safe));
}
