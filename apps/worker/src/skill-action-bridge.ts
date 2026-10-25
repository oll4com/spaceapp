import {
  spaceAgentSkillActionBridgeResponseSchema,
  spaceAgentSkillActionEnvelopeSchema,
  spaceSkillToolIdSchema,
  type DummyTurnInput,
  type Skill,
  type SpaceAgentSkillActionBridgeResponse,
  type SpaceAgentSkillActionEnvelope,
  type SpaceSkillToolId
} from "@space/contracts";
import { redactMemoryText, type SpaceStore } from "@space/runtime";

const skillActionBlockPattern = /```space-skill-actions\s*([\s\S]*?)```/gi;
type SkillSummaryObservation = NonNullable<SpaceAgentSkillActionBridgeResponse["results"][number]["observation"]>["skills"][number];

export interface ParsedSkillActionBlock {
  found: boolean;
  cleanedContent: string;
  envelope: SpaceAgentSkillActionEnvelope | null;
  error: string | null;
}

export interface SkillActionBridgeExecution {
  cleanedContent: string;
  toolMessageContent: string | null;
  executedActionCount: number;
}

function cleanAssistantContent(content: string): string {
  return content.replace(skillActionBlockPattern, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseSkillActionBlock(content: string): ParsedSkillActionBlock {
  const matches = Array.from(content.matchAll(skillActionBlockPattern));
  const cleanedContent = cleanAssistantContent(content);
  if (!matches.length) {
    return { found: false, cleanedContent: content, envelope: null, error: null };
  }
  const rawJson = matches[0]?.[1]?.trim();
  if (!rawJson) {
    return { found: true, cleanedContent, envelope: null, error: "Skill action block is empty." };
  }
  try {
    const parsed = spaceAgentSkillActionEnvelopeSchema.parse(JSON.parse(rawJson));
    return { found: true, cleanedContent, envelope: parsed, error: null };
  } catch {
    return { found: true, cleanedContent, envelope: null, error: "Skill action block must be valid Space skill action JSON." };
  }
}

function blockedMessage(reason: string): string {
  return `Space skill action bridge result:\n- BLOCKED reason=${redactMemoryText(reason).slice(0, 500)}`;
}

function failedMessage(reason: string): string {
  return `Space skill action bridge result:\n- FAILED reason=${redactMemoryText(reason).slice(0, 500)}`;
}

function selectedSkillToolIds(input: DummyTurnInput): Set<SpaceSkillToolId> {
  return new Set(
    (input.selectedToolIds ?? []).flatMap((toolId) => {
      const parsed = spaceSkillToolIdSchema.safeParse(toolId);
      return parsed.success ? [parsed.data] : [];
    })
  );
}

function skillSummary(skill: Skill): SkillSummaryObservation {
  return {
    skillId: skill.id,
    displayName: redactMemoryText(skill.displayName),
    version: redactMemoryText(skill.version),
    status: skill.status,
    statusReason: skill.statusReason ? redactMemoryText(skill.statusReason) : null,
    triggerDescription: redactMemoryText(skill.triggerDescription),
    allowedTools: skill.allowedTools.map((tool) => redactMemoryText(tool)).slice(0, 50),
    contentHash: skill.contentHash
  };
}

function skillMatchesQuery(skill: Skill, query: string | undefined): boolean {
  if (!query) return true;
  const normalized = query.toLowerCase();
  return [skill.id, skill.displayName, skill.triggerDescription].some((value) => value.toLowerCase().includes(normalized));
}

function formatBridgeResponse(response: SpaceAgentSkillActionBridgeResponse): string {
  const lines = ["Space skill action bridge result:"];
  for (const result of response.results) {
    const observation = result.observation;
    const details = [`${result.status} ${result.request.toolId}`, `action=${result.request.action.type}`, `reason=${result.statusReason}`];
    if (observation?.matchCount !== null && observation?.matchCount !== undefined) details.push(`matches=${observation.matchCount}`);
    if (observation?.skillId) details.push(`skill=${observation.skillId}`);
    lines.push(`- ${details.join("; ")}`);
    for (const skill of observation?.skills ?? []) {
      const summary = [
        `id=${skill.skillId}`,
        `name=${skill.displayName}`,
        `version=${skill.version}`,
        `status=${skill.status}`,
        `trigger=${skill.triggerDescription}`,
        `allowedTools=${skill.allowedTools.join(",") || "none"}`,
        `hash=${skill.contentHash}`
      ];
      if (skill.statusReason) summary.push(`statusReason=${skill.statusReason}`);
      lines.push(`  - ${summary.join("; ")}`);
    }
    if (observation?.body) {
      lines.push(`  body=${observation.body.slice(0, 3000)}`);
    }
  }
  return redactMemoryText(lines.join("\n")).slice(0, 12000);
}

export async function executeSkillActionBridge(input: {
  turnInput: DummyTurnInput;
  assistantContent: string;
  store: SpaceStore;
}): Promise<SkillActionBridgeExecution> {
  const parsed = parseSkillActionBlock(input.assistantContent);
  if (!parsed.found) {
    return { cleanedContent: input.assistantContent, toolMessageContent: null, executedActionCount: 0 };
  }
  const cleanedContent = parsed.cleanedContent || "Requested Space skill actions.";
  if (parsed.error || !parsed.envelope) {
    return {
      cleanedContent,
      toolMessageContent: failedMessage(parsed.error ?? "Skill action request was invalid."),
      executedActionCount: 0
    };
  }
  if (!input.turnInput.agentSessionId) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage("Skill actions require a Space-native agent session."),
      executedActionCount: 0
    };
  }
  const selectedToolIds = selectedSkillToolIds(input.turnInput);
  if (!selectedToolIds.size) {
    return {
      cleanedContent,
      toolMessageContent: blockedMessage("No skill tools are selected for this agent pane."),
      executedActionCount: 0
    };
  }

  const skills = await input.store.listSkills();
  const results: SpaceAgentSkillActionBridgeResponse["results"] = [];
  let executedActionCount = 0;

  for (const request of parsed.envelope.actions) {
    if (!selectedToolIds.has(request.toolId)) {
      results.push({
        request,
        status: "BLOCKED",
        statusReason: `Skill tool ${request.toolId} is not selected for this agent pane.`,
        observation: null
      });
      continue;
    }

    if (request.action.type === "list") {
      const action = request.action;
      const matches = skills
        .filter((skill) => (action.status ? skill.status === action.status : action.includeDisabled || skill.status === "VERIFIED"))
        .filter((skill) => skillMatchesQuery(skill, action.q));
      const selected = matches.slice(0, action.pageSize);
      results.push({
        request,
        status: "EXECUTED",
        statusReason: `Skill list returned ${selected.length} match(es).`,
        observation: {
          actionType: "list",
          skillId: null,
          matchCount: matches.length,
          skills: selected.map(skillSummary),
          body: null
        }
      });
      executedActionCount += 1;
      continue;
    }

    const action = request.action;
    const skill = skills.find((candidate) => candidate.id === action.skillId);
    if (!skill) {
      results.push({
        request,
        status: "FAILED",
        statusReason: "Skill was not found in the Space registry.",
        observation: null
      });
      continue;
    }
    if (skill.status !== "VERIFIED") {
      results.push({
        request,
        status: "BLOCKED",
        statusReason: "Skill is not verified; operator must enable it before agent read.",
        observation: {
          actionType: "read",
          skillId: skill.id,
          matchCount: 1,
          skills: [skillSummary(skill)],
          body: null
        }
      });
      continue;
    }
    results.push({
      request,
      status: "EXECUTED",
      statusReason: "Skill read completed.",
      observation: {
        actionType: "read",
        skillId: skill.id,
        matchCount: 1,
        skills: [skillSummary(skill)],
        body: redactMemoryText(skill.body).slice(0, 8000)
      }
    });
    executedActionCount += 1;
  }

  const response = spaceAgentSkillActionBridgeResponseSchema.parse({
    id: "space-agent-skill-action-bridge",
    results
  });
  return {
    cleanedContent,
    toolMessageContent: formatBridgeResponse(response),
    executedActionCount
  };
}
