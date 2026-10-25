
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

  return `${current}${incoming}`;
}

