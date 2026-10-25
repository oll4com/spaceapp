import type { ClipboardItem } from "@space/contracts";

export interface PlanStepModelCandidate {
  title: string;
  agent?: string | null;
  notes?: string | null;
}

export function isLikelyModelDescriptor(str: string): boolean {
  const lower = str.toLowerCase().trim();
  if (
    lower.startsWith("step") ||
    lower.startsWith("stage") ||
    lower.startsWith("wip") ||
    lower.startsWith("done") ||
    lower.startsWith("completed") ||
    lower.startsWith("pending") ||
    lower.startsWith("blocked")
  ) {
    return false;
  }
  return (
    lower.includes("/") ||
    lower.includes("gpt") ||
    lower.includes("claude") ||
    lower.includes("gemini") ||
    lower.includes("deepseek") ||
    lower.includes("qwen") ||
    lower.includes("opencode") ||
    lower.includes("codex") ||
    lower.includes("sol") ||
    lower.includes("astra") ||
    lower.includes("luna") ||
    lower.includes("flash") ||
    lower.includes("pro") ||
    lower.includes("sonnet") ||
    lower.includes("opus") ||
    lower.includes("pickle") ||
    /\b(low|medium|high|xhigh)\b/i.test(lower)
  );
}

export function normalizeModelDisplay(str: string): string {
  return str.replace(/\s*\/\s*/g, " · ").trim();
}

export function isSameModel(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const cleanA = a.toLowerCase().replace(/[\s\/\·\-_]/g, "");
  const cleanB = b.toLowerCase().replace(/[\s\/\·\-_]/g, "");
  return cleanA === cleanB || cleanA.includes(cleanB) || cleanB.includes(cleanA);
}

export function resolveStepModel(
  step: PlanStepModelCandidate,
  plan?: Pick<ClipboardItem, "minimumModel" | "minimumReasoning"> | null
): string | null {
  // 1. Check title for bracketed model specification, e.g. [gpt-6.1-sol / high] or [opencode/deepseek-v4-flash-free]
  const titleBracketMatch = step.title.match(/\[([^\]]+)\]/);
  if (titleBracketMatch) {
    const candidate = titleBracketMatch[1]?.trim();
    if (candidate && isLikelyModelDescriptor(candidate)) {
      return normalizeModelDisplay(candidate);
    }
  }

  // 2. Check notes for Recommended model or Model declaration
  if (step.notes) {
    const notesMatch = step.notes.match(
      /(?:Recommended model|Model):\s*([a-zA-Z0-9_\-\.\/]+)(?:;\s*reasoning:\s*([a-zA-Z0-9_\-]+))?/i
    );
    if (notesMatch) {
      const model = notesMatch[1]?.trim();
      const reasoning = notesMatch[2]?.trim();
      if (model) {
        return reasoning ? `${model} · ${reasoning}` : model;
      }
    }
  }

  // 3. Check step.agent if it looks like an actual model (and not a runtime/session failure disclaimer)
  if (
    step.agent &&
    !step.agent.toLowerCase().includes("unavailable") &&
    !step.agent.toLowerCase().includes("runtime model id")
  ) {
    if (isLikelyModelDescriptor(step.agent)) {
      return normalizeModelDisplay(step.agent);
    }
  }

  // 4. Fallback to plan's default/minimum model
  if (plan?.minimumModel) {
    return `${plan.minimumModel}${plan.minimumReasoning ? ` · ${plan.minimumReasoning}` : ""}`;
  }

  return null;
}
