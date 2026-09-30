import { defaultLiveTimeZone } from "./live-bootstrap.js";

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

export function getGreetingForThailandTime(userName = "", timeZone = defaultLiveTimeZone()): string {
  try {
    const hourStr = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false
    }).format(new Date());
    const hour = parseInt(hourStr, 10);
    const raw = userName.trim();
    const vocativeName = raw.endsWith("ς") ? raw.slice(0, -1) : raw;
    if (hour >= 5 && hour < 12) {
      return `Καλημέρα ${vocativeName}, τι κάνεις;`;
    }
    return `Καλησπέρα ${vocativeName}, τι κάνεις;`;
  } catch {
    const raw = userName.trim();
    const vocativeName = raw.endsWith("ς") ? raw.slice(0, -1) : raw;
    return `Καλησπέρα ${vocativeName}, τι κάνεις;`;
  }
}

