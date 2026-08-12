import type {
  StreamingBotFaq,
  StreamingBotFact,
  StreamingBotPersona,
  StreamingBotSettings
} from "@space/contracts";

export interface BotPromptContext {
  settings: StreamingBotSettings;
  memorySummary: string;
  recentExchange: string;
}

function factLines(facts: StreamingBotFact[]): string {
  if (!facts.length) return "(none configured)";
  return facts.map((fact) => `- ${fact.key}: ${fact.value}`).join("\n");
}

function faqLines(faq: StreamingBotFaq[]): string {
  if (!faq.length) return "(none configured)";
  return faq.map((item) => `- Q: ${item.question}\n  A: ${item.answer}`).join("\n");
}

export function buildBotSystemPrompt(context: BotPromptContext): string {
  const { settings, memorySummary, recentExchange } = context;
  const persona: StreamingBotPersona = settings.persona;
  return [
    `You are ${persona.name}, the live chat assistant for this stream.`,
    `Persona and tone: ${persona.tone}`,
    "",
    "LANGUAGE: Always reply in English.",
    "",
    "LIVE FACTS (provided by the streamer; treat as authoritative):",
    factLines(settings.facts),
    "",
    "FREQUENTLY ASKED QUESTIONS:",
    faqLines(settings.faq),
    "",
    "STREAMER INSTRUCTIONS:",
    settings.instructions.trim() ? settings.instructions.trim() : "(none)",
    "",
    "BOT MEMORY (facts learned from earlier viewer questions in this stream):",
    memorySummary.trim() ? memorySummary.trim() : "(no memory yet)",
    "",
    "RULES:",
    "1. Only reply to viewer messages that contain a genuine question about the stream, the streamer, or the content. Ignore greetings, spam, and statements without a question.",
    "2. Never reply to another bot message or to your own messages.",
    "3. Keep answers short (1-3 sentences). YouTube messages are capped at 200 characters, Twitch at 500.",
    "4. Use live facts and memory first; if you do not know something, say you are not sure instead of inventing an answer.",
    "5. You may use tools: send_reply posts to chat, memory_save stores a fact worth remembering, memory_search looks up prior knowledge, mcp_call runs a Space MCP server tool (e.g. space_ops, olla, space_browser), skill_read loads a Space skill.",
    "6. When you have a reply, call send_reply exactly once. If nothing deserves a reply, respond with an empty tool result and no send_reply.",
    "",
    "RECENT EXCHANGE (last messages in chat):",
    recentExchange.trim() ? recentExchange.trim() : "(no recent messages)"
  ].join("\n");
}

export function buildRecentExchange(messages: Array<{ author: string; message: string }>): string {
  if (!messages.length) return "";
  return messages.map((item) => `${item.author}: ${item.message}`).join("\n");
}