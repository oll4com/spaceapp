export type MemoryRolloutMode = "disabled" | "read-only" | "mutations";

const memoryRolloutFlags = [
  "SPACE_MEMORY_GRAPH_ENABLED",
  "SPACE_MEMORY_MAINTENANCE_ENABLED",
  "SPACE_MEMORY_MUTATIONS_ENABLED"
] as const;

const valuesByMode: Record<MemoryRolloutMode, readonly [string, string, string]> = {
  disabled: ["false", "false", "false"],
  "read-only": ["true", "true", "false"],
  mutations: ["true", "true", "true"]
};

function rolloutFlagStatus(values: string[]): string {
  if (values.length === 0) return "unset";
  if (values.length > 1) return "duplicate";
  return values[0] === "true" || values[0] === "false" ? values[0] : "invalid";
}

export function memoryRolloutEnvironmentState(source: string): Record<(typeof memoryRolloutFlags)[number], string> {
  return Object.fromEntries(memoryRolloutFlags.map((key) => {
    const values = source.split("\n")
      .filter((line) => line.startsWith(`${key}=`))
      .map((line) => line.slice(key.length + 1).replace(/\r$/, ""));
    return [key, rolloutFlagStatus(values)];
  })) as Record<(typeof memoryRolloutFlags)[number], string>;
}

export function renderMemoryRolloutEnvironment(source: string, mode: MemoryRolloutMode): string {
  const values = valuesByMode[mode];
  const lines = source.replace(/\n$/, "").split("\n");

  memoryRolloutFlags.forEach((key, index) => {
    const matchingIndexes = lines.flatMap((line, lineIndex) => line.startsWith(`${key}=`) ? [lineIndex] : []);
    if (matchingIndexes.length > 1) throw new Error(`Duplicate ${key} declarations prevent a safe memory rollout.`);
    const replacement = `${key}=${values[index]}`;
    if (matchingIndexes.length === 1) lines[matchingIndexes[0]!] = replacement;
    else lines.push(replacement);
  });

  return `${lines.join("\n")}\n`;
}
