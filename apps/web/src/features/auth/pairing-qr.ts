// The pairing QR (Nous Pro 1b-6, ADR-013, design §2.1): a QR Code Model 2 symbol of the pairing text, in byte mode at error correction
// level M (L when M does not fit), drawn in the browser so the code never leaves it. After Project Nayuki's QR Code generator (MIT); checked
// module for module against segno in pairing-qr.test.ts. No dependency: the worktrees' node_modules links into stable's tree.

const EC_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28]
};
const BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49]
};
const FORMAT_BITS = { L: 1, M: 0 };
type Level = keyof typeof FORMAT_BITS;

const bit = (value: number, index: number) => ((value >>> index) & 1) !== 0;
function rawDataModules(version: number) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}
const dataCodewords = (version: number, level: Level) => Math.floor(rawDataModules(version) / 8) - EC_PER_BLOCK[level][version]! * BLOCKS[level][version]!;

function gfMultiply(x: number, y: number) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
}
function rsDivisor(degree: number) {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) { result[j] = gfMultiply(result[j]!, root); if (j + 1 < degree) result[j]! ^= result[j + 1]!; }
    root = gfMultiply(root, 0x02);
  }
  return result;
}
function rsRemainder(data: number[], divisor: number[]) {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coefficient, index) => { result[index]! ^= gfMultiply(coefficient, factor); });
  }
  return result;
}

/** The symbol's modules, row by row (true is dark), without the quiet zone. `mask` fixes the mask (tests); otherwise the lowest penalty wins. */
export function pairingQrModules(text: string, mask?: number): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  let level: Level = "M", version = 1;
  const bitsNeeded = (v: number) => 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
  for (;; version++) {
    if (version > 40) { if (level === "L") throw new Error("Too long for a QR code."); level = "L"; version = 1; }
    if (bitsNeeded(version) <= dataCodewords(version, level) * 8) break;
  }
  // Byte mode segment, terminator, byte padding, then alternating pad codewords.
  const bits: number[] = [];
  const append = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  append(4, 4); append(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  const capacity = dataCodewords(version, level) * 8;
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((sum, value) => sum * 2 + value, 0));

  // Error correction blocks, interleaved.
  const blockCount = BLOCKS[level][version]!, eccLength = EC_PER_BLOCK[level][version]!;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (rawCodewords % blockCount), shortLength = Math.floor(rawCodewords / blockCount);
  const divisor = rsDivisor(eccLength);
  const blocks: number[][] = [];
  for (let i = 0, at = 0; i < blockCount; i++) {
    const block = data.slice(at, at + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    at += block.length;
    const ecc = rsRemainder(block, divisor);
    if (i < shortBlocks) block.push(0);
    blocks.push([...block, ...ecc]);
  }
  const codewords: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) blocks.forEach((block, j) => { if (i !== shortLength - eccLength || j >= shortBlocks) codewords.push(block[i]!); });

  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFunction = (x: number, y: number, dark: boolean) => { modules[y]![x] = dark; isFunction[y]![x] = true; };
  for (let i = 0; i < size; i++) { setFunction(6, i, i % 2 === 0); setFunction(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) setFunction(x, y, distance !== 2 && distance !== 4);
    }
  }
  const positions: number[] = [];
  if (version > 1) {
    const count = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    positions.push(6);
    for (let at = size - 7; positions.length < count; at -= step) positions.splice(1, 0, at);
  }
  positions.forEach((y, i) => positions.forEach((x, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const drawFormat = (chosen: number) => {
    const value = (FORMAT_BITS[level] << 3) | chosen;
    let rem = value;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const format = ((value << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFunction(8, i, bit(format, i));
    setFunction(8, 7, bit(format, 6)); setFunction(8, 8, bit(format, 7)); setFunction(7, 8, bit(format, 8));
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, bit(format, i));
    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, bit(format, i));
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, bit(format, i));
    setFunction(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const value = (version << 12) | rem;
    for (let i = 0; i < 18; i++) { const a = size - 11 + (i % 3), b = Math.floor(i / 3); setFunction(a, b, bit(value, i)); setFunction(b, a, bit(value, i)); }
  }
  // Codewords in the zigzag, skipping the function modules.
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical;
        if (!isFunction[y]![x] && index < codewords.length * 8) { modules[y]![x] = bit(codewords[index >>> 3]!, 7 - (index & 7)); index++; }
      }
    }
  }
  const applyMask = (chosen: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const invert = [(x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0, (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
        (x * y) % 2 + (x * y) % 3 === 0, ((x * y) % 2 + (x * y) % 3) % 2 === 0, (((x + y) % 2) + (x * y) % 3) % 2 === 0][chosen]!;
      if (!isFunction[y]![x] && invert) modules[y]![x] = !modules[y]![x];
    }
  };
  let chosen = mask ?? -1;
  if (chosen < 0) {
    let best = Infinity;
    for (let candidate = 0; candidate < 8; candidate++) {
      applyMask(candidate); drawFormat(candidate);
      const score = penalty(modules);
      if (score < best) { best = score; chosen = candidate; }
      applyMask(candidate);
    }
  }
  applyMask(chosen); drawFormat(chosen);
  return modules;
}

/** The standard's mask penalty (rules N1-N4). */
function penalty(modules: boolean[][]) {
  const size = modules.length;
  let result = 0;
  const count = (history: number[]) => {
    const n = history[1]!, core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) + (core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0);
  };
  const add = (length: number, history: number[]) => { if (history[0] === 0) length += size; history.pop(); history.unshift(length); };
  for (const line of [...modules, ...modules.map((_, x) => modules.map((row) => row[x]!))]) {
    let color = false, run = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (const dark of line) {
      if (dark === color) { run++; if (run === 5) result += 3; else if (run > 5) result++; }
      else { add(run, history); if (!color) result += count(history) * 40; color = dark; run = 1; }
    }
    if (color) { add(run, history); run = 0; }
    add(run + size, history);
    result += count(history) * 40;
  }
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const dark = modules[y]![x];
    if (dark === modules[y]![x + 1] && dark === modules[y + 1]![x] && dark === modules[y + 1]![x + 1]) result += 3;
  }
  const dark = modules.flat().filter(Boolean).length, total = size * size;
  return result + (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
}

/** The symbol as one SVG path of dark modules, offset by the 4-module quiet zone; `size` includes it. */
export function pairingQrPath(text: string): { size: number; path: string } {
  const modules = pairingQrModules(text);
  let path = "";
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  return { size: modules.length + 8, path };
}
