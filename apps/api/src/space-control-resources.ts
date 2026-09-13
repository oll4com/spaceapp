import { readFile, readdir, realpath } from "node:fs/promises";
import { join,resolve,sep } from "node:path";
import { z } from "zod";
import { SpaceConflictError } from "@space/runtime";
import type { ControlAction } from "@space/contracts";
// Only installed Space skill directories. No arbitrary path or file reads.
const skillRoots=["/var/lib/spaceapp-user/.codex/skills","/var/lib/spaceapp-user/.agents/skills"];
export async function controlSkills(name?:string){
 const entries:Array<{name:string;root:string}>=[];
 for(const root of skillRoots){
  for(const entry of await readdir(root,{withFileTypes:true}).catch(()=>[])){
   if(!/^space[-a-z0-9]*$/.test(entry.name)&&entry.name!=="run-spaceapp-devtest")continue;
   if(!entries.some(e=>e.name===entry.name))entries.push({name:entry.name,root});
  }
 }
 if(!name)return {skills:entries.map(({name})=>({name})),source:"installed Space skills"};
 const entry=entries.find(e=>e.name===name);if(!entry)throw new SpaceConflictError("Skill is not in the installed Space catalog.");
 const path=await realpath(join(entry.root,entry.name,"SKILL.md"));
 const allowed=[...skillRoots,"/opt/spaceapp/agent-skills","/var/lib/spaceapp-user/.codex/skill-bundles"];
 if(!allowed.some(root=>path.startsWith(resolve(root)+sep)))throw new SpaceConflictError("Installed skill target is outside approved roots.");
 const text=await readFile(path,"utf8");if(text.length>100_000)throw new SpaceConflictError("Skill exceeds the content limit.");
 return {name,content:text,source:"installed Space skill"};
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
