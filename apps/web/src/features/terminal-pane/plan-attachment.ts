import type { ClipboardItem } from "@space/contracts";

export function formatPlanAttachment(plan: Pick<ClipboardItem, "text" | "title" | "minimumModel" | "minimumReasoning">): string {
  const text = plan.text.trim();
  const title = plan.title?.trim();
  const content = title && !text.startsWith("# ") ? `# ${title}\n\n${text}` : text;
  const recommendations = [
    plan.minimumModel ? `Minimum capable model: ${plan.minimumModel}` : null,
    plan.minimumReasoning ? `Recommended reasoning: ${plan.minimumReasoning}` : null
  ].filter(Boolean);
  return recommendations.length ? `${recommendations.join("\n")}\n\n${content}` : content;
}
