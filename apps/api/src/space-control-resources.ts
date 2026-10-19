import { readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { SpaceConflictError } from "@space/runtime";
import type { ControlAction, Skill } from "@space/contracts";
import { pluginsService } from "./plugins-service.js";

// Only installed Space skill directories. No arbitrary path or file reads.
const skillRoots = [
  "/var/lib/spaceapp-user/.codex/skills",
  "/var/lib/spaceapp-user/.agents/skills",
  "/var/lib/spaceapp-cli/.codex/skills",
  "/var/lib/spaceapp-cli/.agents/skills"
];

// space_inspect SKILLS: one page of metadata (the full list with every skill's text went over 5 MiB); skills.read returns a skill's text.
export async function controlSkillsPage(registeredSkills: Skill[], input: { query?: string; offset: number; limit: number }) {
  const q = input.query?.toLowerCase();
  const page = <T>(items: T[]) => items.slice(input.offset, input.offset + input.limit);
  const installed = ((await controlSkills()).skills ?? []).filter((skill) => !q || skill.name.includes(q));
  const registered = registeredSkills.map((skill) => ({ id: skill.id, name: skill.displayName, description: skill.triggerDescription }))
    .filter((skill) => !q || `${skill.id} ${skill.name} ${skill.description}`.toLowerCase().includes(q));
  return { installed: { skills: page(installed), total: installed.length, source: "installed Space skills" },
    registered: page(registered), registeredTotal: registered.length, offset: input.offset, limit: input.limit };
}

export async function controlSkills(name?: string) {
  const entries: Array<{ name: string; root: string }> = [];
  for (const root of skillRoots) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      // Space skills; job-applications and run-spaceapp-devtest remain only as deprecated aliases.
      if (!/^space[-a-z0-9]*$/.test(entry.name)) continue;
      if (!entries.some((e) => e.name === entry.name)) entries.push({ name: entry.name, root });
    }
  }
  const enabledEntries: Array<{ name: string; root: string }> = [];
  for (const entry of entries) {
    if (await pluginsService.isSkillEnabled(entry.name)) {
      enabledEntries.push(entry);
    }
  }
  if (!name) return { skills: enabledEntries.map(({ name }) => ({ name })), source: "installed Space skills" };
  const entry = enabledEntries.find((e) => e.name === name);
  if (!entry) throw new SpaceConflictError("Skill is not in the installed Space catalog or has been disabled in Plugins settings.");
  const path = await realpath(join(entry.root, entry.name, "SKILL.md"));
  const allowed = [
    ...skillRoots,
    "/opt/spaceapp/agent-skills",
    "/app/agent-skills",
    "/var/lib/spaceapp-user/.codex/skill-bundles"
  ];
  if (!allowed.some((root) => path.startsWith(resolve(root) + sep))) throw new SpaceConflictError("Installed skill target is outside approved roots.");
  const text = await readFile(path, "utf8");
  // Same limit as readSkill in deploy/space-skill-reader.mjs.
  if (Buffer.byteLength(text, "utf8") > 128 * 1024) throw new SpaceConflictError("Skill exceeds the 128 KiB size limit.");
  return { name, content: text, source: "installed Space skill" };
}
export type ResourceAction=Extract<ControlAction,{kind:"resource"}>;
export const controlResourceRoutes:Partial<Record<ResourceAction["operation"],{method:"GET"|"POST"|"PATCH"|"PUT"|"DELETE";path:string;scope?:"pane"|"artifact"}>>={
 "panes.move":{method:"POST",path:"/api/panes/:id/move",scope:"pane"},
 "panes.split":{method:"PATCH",path:"/api/panes/:id",scope:"pane"},
 "panes.update":{method:"PATCH",path:"/api/panes/:id",scope:"pane"},
 "rooms.reorder":{method:"POST",path:"/api/rooms/reorder"},
 "browser.navigate":{method:"POST",path:"/api/panes/:id/browser/navigate",scope:"pane"},
 "links.list":{method:"GET",path:"/api/links"},
 "links.create":{method:"POST",path:"/api/links"},
 "links.update":{method:"PATCH",path:"/api/links/:id"},
 "links.delete":{method:"DELETE",path:"/api/links/:id"},
 "tasks.list":{method:"GET",path:"/api/task-items"},
 "tasks.get":{method:"GET",path:"/api/task-items/:id"},
 "tasks.create":{method:"POST",path:"/api/task-items"},
 "tasks.update":{method:"PATCH",path:"/api/task-items/:id"},
 "tasks.delete":{method:"DELETE",path:"/api/task-items/:id"},
 "skills.list":{method:"GET",path:"/api/skills"},
 "files.delete":{method:"DELETE",path:"/api/artifacts/:id",scope:"artifact"},
 "media.delete":{method:"DELETE",path:"/api/artifacts/:id",scope:"artifact"},
 "files.preview":{method:"GET",path:"/api/artifacts/:id/preview",scope:"artifact"},
 "settings.providers":{method:"PATCH",path:"/api/provider-settings"},
 "settings.tools":{method:"PUT",path:"/api/agent-tools/policies"},
 "settings.task_titles":{method:"PATCH",path:"/api/settings/task-titles"},
 "models.list":{method:"GET",path:"/api/models"}
};
export const controlPublishInput=z.object({filename:z.string().min(1).max(200).regex(/^[^/\\\x00-\x1f]+$/),mimeType:z.string().min(1).max(100),
 text:z.string().max(200_000).optional(),base64:z.string().max(400_000).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional()}).strict()
 .refine(v=>(v.text!==undefined)!==(v.base64!==undefined),"Supply text or base64, not both.");
