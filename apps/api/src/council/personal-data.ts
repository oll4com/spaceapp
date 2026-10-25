import type { JobApplyCandidate } from "@space/contracts";
import { clip, scrubContactDetails } from "./ranking.js";

/** Where the coordinator learns about the operator; every source is optional and read-only. */
export interface CouncilPersonalSources {
  candidate(owner: string): Promise<JobApplyCandidate | null>;
  cvText(owner: string): Promise<string | null>;
  personalMemory(owner: string): Promise<Array<{ key: string; value: string; category?: string }>>;
  /** Job Copilot facts and preferences (listMemory, which does not count as a use). */
  jobMemory(owner: string, query: string | null): Promise<string[]>;
  /** Space Memory keyword search: title and excerpt per hit. */
  spaceMemory(query: string): Promise<Array<{ title: string; body: string }>>;
}

const safe = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => {
  try { return await read(); } catch { return fallback; }
};

function candidateText(candidate: JobApplyCandidate): string {
  const lines = [
    candidate.fullName && `Name: ${candidate.fullName}`,
    candidate.headline && `Headline: ${candidate.headline}`,
    [candidate.location, candidate.country].filter(Boolean).length ? `Location: ${[candidate.location, candidate.country].filter(Boolean).join(", ")}` : "",
    candidate.yearsOfExperience !== null ? `Years of experience: ${candidate.yearsOfExperience}` : "",
    candidate.skills.length ? `Skills: ${candidate.skills.slice(0, 25).join(", ")}` : "",
    candidate.languages.length ? `Languages: ${candidate.languages.join(", ")}` : "",
    candidate.workAuthorization && `Work authorization: ${candidate.workAuthorization}`,
    candidate.summary && `Summary: ${clip(candidate.summary, 600)}`,
    candidate.experience.length ? `Experience:\n${candidate.experience.slice(0, 6).map((item) => `- ${[item.title, item.company].filter(Boolean).join(" at ")} (${[item.start, item.end].filter(Boolean).join("–")})`).join("\n")}` : "",
    candidate.education.length ? `Education: ${candidate.education.slice(0, 3).map((item) => [item.degree, item.field, item.school].filter(Boolean).join(", ")).join("; ")}` : ""
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * One text block for the coordinator: profile, CV excerpt, personal memory, Job Copilot facts and Space Memory hits.
 * Email addresses and phone numbers are removed; the coordinator then writes the short personal context the
 * operator approves before any member sees it.
 */
export async function buildCouncilPersonalData(sources: CouncilPersonalSources, owner: string, question: string, memoryQueries: readonly string[]): Promise<string> {
  const keywords = question.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((word) => word.length > 3).slice(0, 8).join(" ");
  const [candidate, cv, personal, jobFacts, spaceHits] = await Promise.all([
    safe(() => sources.candidate(owner), null),
    safe(() => sources.cvText(owner), null),
    safe(() => sources.personalMemory(owner), []),
    safe(() => sources.jobMemory(owner, null), []),
    Promise.all([keywords, ...memoryQueries].filter(Boolean).map((query) => safe(() => sources.spaceMemory(query), [])))
  ]);
  const extraJobFacts = await Promise.all(memoryQueries.map((query) => safe(() => sources.jobMemory(owner, query), [])));
  const seen = new Set<string>();
  const hits = spaceHits.flat().filter((hit) => !seen.has(hit.title) && seen.add(hit.title));
  const sections = [
    candidate ? `PROFILE:\n${candidateText(candidate)}` : "",
    cv ? `CV EXCERPT:\n${clip(cv.replace(/\s+\n/g, "\n").trim(), 1_800)}` : "",
    personal.length ? `PERSONAL MEMORY:\n${clip(personal.slice(0, 40).map((item) => `- ${item.key}: ${item.value}`).join("\n"), 1_200)}` : "",
    jobFacts.length || extraJobFacts.flat().length ? `JOB COPILOT MEMORY:\n${clip([...new Set([...jobFacts, ...extraJobFacts.flat()])].slice(0, 20).map((text) => `- ${text}`).join("\n"), 1_000)}` : "",
    hits.length ? `SPACE MEMORY:\n${clip(hits.slice(0, 6).map((hit) => `- ${hit.title}: ${clip(hit.body.replace(/\s+/g, " "), 240)}`).join("\n"), 1_200)}` : ""
  ].filter(Boolean);
  return sections.length ? scrubContactDetails(sections.join("\n\n")) : "(no stored data about the operator)";
}
