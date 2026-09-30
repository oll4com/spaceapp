import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DemoCatalogResponse, DemoProject, DemoVariant } from "@space/contracts";

/**
 * Static catalog. Projects and variants are data, not code paths: adding a demo
 * means adding a definition plus its template directory. Availability is always
 * observed from the build output, never promised by the catalog.
 */
export interface DemoVariantDefinition {
  id: string;
  projectId: string;
  language: "javascript" | "typescript" | "python";
  label: string;
  stack: string[];
  /** Directory relative to the demo projects root. */
  templateDirectory: string;
  /** Server entry relative to the template directory. */
  serverEntry: string;
  /** Built web entry relative to the template directory. */
  webEntry: string;
  supportsLive: boolean;
}

export interface DemoProjectDefinition {
  id: string;
  index: number;
  name: string;
  summary: string;
  description: string;
  variantIds: string[];
  requiresConnections: Array<"salesforce" | "google-sheets">;
}

export const demoProjectDefinitions: readonly DemoProjectDefinition[] = Object.freeze([
  {
    id: "project-1-salesforce-crm",
    index: 1,
    name: "Project 1 — Salesforce CRM",
    summary: "Salesforce Accounts and Contacts with Google Sheets synchronisation.",
    description:
      "Creates a real Account and its linked Contact through the Salesforce API, lists existing Accounts with pagination and search, and appends one Google Sheets row per created record. Live mode uses the Space connectors; Sample mode runs with synthetic data and never touches an external service.",
    variantIds: ["javascript-react-node", "typescript-react-node"],
    requiresConnections: ["salesforce", "google-sheets"]
  },
  {
    id: "project-2-crud-playground",
    index: 2,
    name: "Project 2 — CRUD Playground",
    summary: "Small task list with create, status change and delete.",
    description:
      "Isolated CRUD demo used to prove run lifecycle, preview, logs and variant switching without any external dependency. Every write stays inside the run workspace.",
    variantIds: ["javascript-react-node", "typescript-react-node"],
    requiresConnections: []
  }
]);

export const demoVariantDefinitions: readonly DemoVariantDefinition[] = Object.freeze([
  {
    id: "javascript-react-node",
    projectId: "project-1-salesforce-crm",
    language: "javascript",
    label: "JavaScript · React · Node.js",
    stack: ["JavaScript", "React", "Node.js"],
    templateDirectory: "project-1-salesforce-crm/javascript-react-node",
    serverEntry: "server/index.mjs",
    webEntry: "web/dist/index.html",
    supportsLive: true
  },
  {
    id: "typescript-react-node",
    projectId: "project-1-salesforce-crm",
    language: "typescript",
    label: "TypeScript · React · Node.js",
    stack: ["TypeScript", "React", "Node.js"],
    templateDirectory: "project-1-salesforce-crm/typescript-react-node",
    serverEntry: "server-dist/index.js",
    webEntry: "web/dist/index.html",
    supportsLive: true
  },
  {
    id: "javascript-react-node",
    projectId: "project-2-crud-playground",
    language: "javascript",
    label: "JavaScript · React · Node.js",
    stack: ["JavaScript", "React", "Node.js"],
    templateDirectory: "project-2-crud-playground/javascript-react-node",
    serverEntry: "server/index.mjs",
    webEntry: "web/dist/index.html",
    supportsLive: true
  },
  {
    id: "typescript-react-node",
    projectId: "project-2-crud-playground",
    language: "typescript",
    label: "TypeScript · React · Node.js",
    stack: ["TypeScript", "React", "Node.js"],
    templateDirectory: "project-2-crud-playground/typescript-react-node",
    serverEntry: "server-dist/index.js",
    webEntry: "web/dist/index.html",
    supportsLive: true
  }
]);

export const defaultDemoProjectId = "project-1-salesforce-crm";
export const defaultDemoVariantId = "javascript-react-node";

export function findDemoProject(id: string | null | undefined): DemoProjectDefinition | null {
  if (!id) return null;
  return demoProjectDefinitions.find((project) => project.id === id) ?? null;
}

export function findDemoVariant(
  projectId: string | null | undefined,
  variantId: string | null | undefined
): DemoVariantDefinition | null {
  if (!projectId || !variantId) return null;
  return demoVariantDefinitions.find((variant) => variant.projectId === projectId && variant.id === variantId) ?? null;
}

export function variantsForProject(projectId: string): DemoVariantDefinition[] {
  return demoVariantDefinitions.filter((variant) => variant.projectId === projectId);
}

export function resolveTemplateDirectory(root: string, variant: DemoVariantDefinition): string {
  return join(root, variant.templateDirectory);
}

export function resolveServerEntry(root: string, variant: DemoVariantDefinition): string {
  return join(resolveTemplateDirectory(root, variant), variant.serverEntry);
}

export function resolveWebEntry(root: string, variant: DemoVariantDefinition): string {
  return join(resolveTemplateDirectory(root, variant), variant.webEntry);
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function isReadableDirectory(path: string): Promise<boolean> {
  try {
    await access(path);
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

export interface DemoVariantAvailability {
  available: boolean;
  unavailableReason: string | null;
}

export async function resolveVariantAvailability(
  root: string,
  variant: DemoVariantDefinition
): Promise<DemoVariantAvailability> {
  const templateDirectory = resolveTemplateDirectory(root, variant);
  if (!(await isReadableDirectory(templateDirectory))) {
    return { available: false, unavailableReason: "The template source is not installed on this host." };
  }
  if (!(await isReadableFile(resolveServerEntry(root, variant)))) {
    return {
      available: false,
      unavailableReason:
        variant.language === "typescript"
          ? "The TypeScript server build is missing. Run the demo build step."
          : "The Node.js server entry is missing."
    };
  }
  if (!(await isReadableFile(resolveWebEntry(root, variant)))) {
    return { available: false, unavailableReason: "The built React preview is missing. Run the demo build step." };
  }
  return { available: true, unavailableReason: null };
}

export async function buildDemoCatalog(root: string): Promise<DemoCatalogResponse> {
  const variants: DemoVariant[] = [];
  for (const variant of demoVariantDefinitions) {
    const availability = await resolveVariantAvailability(root, variant);
    variants.push({
      id: variant.id,
      projectId: variant.projectId,
      language: variant.language,
      label: variant.label,
      stack: [...variant.stack],
      available: availability.available,
      unavailableReason: availability.unavailableReason,
      supportsLive: variant.supportsLive
    });
  }
  const projects: DemoProject[] = demoProjectDefinitions.map((project) => ({
    id: project.id,
    index: project.index,
    name: project.name,
    summary: project.summary,
    description: project.description,
    variantIds: [...project.variantIds],
    requiresConnections: [...project.requiresConnections]
  }));
  return { projects, variants };
}
