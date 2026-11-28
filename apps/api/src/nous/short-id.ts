/** The one record a short id ("nous_goal:9d03b8f1", 8+ characters after the colon, as Nous and the operator write ids) names; null when none or several. */
export function byShortId<T extends { id: string }>(items: readonly T[], ref: string): T | null {
  const short = ref.trim();
  if (!/^[a-z_]+:[A-Za-z0-9_-]{8,}$/.test(short)) return null;
  const found = items.filter((item) => item.id.startsWith(short));
  return found.length === 1 ? found[0]! : null;
}
