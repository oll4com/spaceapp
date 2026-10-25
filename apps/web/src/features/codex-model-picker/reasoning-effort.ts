export function reasoningEffortLabel(value: string): string {
  const labels: Record<string, string> = {
    auto: "Auto",
    disabled: "Disabled",
    unknown: "Unknown",
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "XHigh",
    max: "Max",
    ultra: "Ultra"
  };
  return labels[value.toLowerCase()] ?? value;
}

export function reasoningEffortBadge(value: string): string {
  const badges: Record<string, string> = {
    auto: "AUTO",
    disabled: "OFF",
    unknown: "?",
    none: "OFF",
    minimal: "MIN",
    low: "LOW",
    medium: "MED",
    high: "HIGH",
    xhigh: "XHI",
    max: "MAX",
    ultra: "ULTRA"
  };
  return badges[value.toLowerCase()] ?? value.slice(0, 4).toUpperCase();
}

export function reasoningEffortColor(value?: string | null): { border: string; text: string; glow: string } {
  const effort = (value ?? "").toLowerCase();
  switch (effort) {
    case "minimal":
      return { border: "#14b8a6", text: "#2dd4bf", glow: "rgba(20, 184, 166, 0.4)" }; // Teal
    case "low":
      return { border: "#10b981", text: "#34d399", glow: "rgba(16, 185, 129, 0.4)" }; // Emerald Green
    case "medium":
      return { border: "#3b82f6", text: "#60a5fa", glow: "rgba(59, 130, 246, 0.45)" }; // Royal Blue
    case "high":
      return { border: "#8b5cf6", text: "#a78bfa", glow: "rgba(139, 92, 246, 0.45)" }; // Vivid Violet
    case "xhigh":
      return { border: "#d946ef", text: "#f0abfc", glow: "rgba(217, 70, 239, 0.5)" }; // Electric Magenta
    case "max":
      return { border: "#f43f5e", text: "#fb7185", glow: "rgba(244, 63, 94, 0.5)" }; // Hot Coral / Rose
    case "ultra":
      return { border: "#ff5722", text: "#ff8a65", glow: "rgba(255, 87, 34, 0.55)" }; // Blaze Orange-Red
    case "auto":
      return { border: "#06b6d4", text: "#22d3ee", glow: "rgba(6, 182, 212, 0.4)" }; // Cyan
    default:
      return { border: "#52525b", text: "#a1a1aa", glow: "rgba(82, 82, 91, 0.3)" }; // Neutral Slate
  }
}
