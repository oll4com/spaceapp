import type { RoomMiniRoute } from "@space/contracts";
/** Complete control-only phrases. Anything else retains the model's contextual routing. */
export function parseSpaceControlQuick(input:string):RoomMiniRoute|null{
 const text=input.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim().replace(/[!.]+$/u,"").trim();
 if(text.length>500||/[\n`]/.test(text))return null;
 if(/^(?:ταξινομησε|ταξινομηση|sort) (?:τα |ολα τα )?panes? (?:συμφωνα με |κατα |by )?(?:την |την ωρα |ωρα )?(?:εναρξης|δημιουργιας|ανοιγματος|creation time|start time)$/.test(text))
  return {type:"CONTROL",actions:[{kind:"layout",operation:"sort",sortBy:"createdAt",direction:"asc"}]};
 if(/^(?:φτιαξε|σχηματισε|δημιουργησε|make|create) (?:ενα |a )?(?:χριστουγεννιατικο δεντρο|christmas tree) (?:με |with |απο )(?:τα )?panes?$/.test(text))
  return {type:"CONTROL",actions:[{kind:"layout",operation:"tree",sortBy:"createdAt",direction:"asc"}]};
 if(/^(?:κλεισε|close) (?:ολα τα |all (?:the )?)panes? (?:και |and )(?:ανοιξε τα ξανα|ξανανοιξε τα|reopen them)(?: (?:ιδιου τυπου |του ιδιου τυπου )?(?:στις ιδιες θεσεις|in the same positions))?$/.test(text))
  return {type:"CONTROL",actions:[{kind:"pane",operation:"restart",target:{state:"OPEN"},when:"AFTER_TURN"}]};
 return null;
}
/**
 * "@Bob fix the tests" or "@Bob @Dana run the checks": the text goes straight to those panes as their next prompt
 * (after their current turn), without a model in between. Names resolve like Live voice targets.
 */
export function parseRoomAgentMention(input:string):RoomMiniRoute|null{
 const match=input.trim().match(/^((?:@[\p{L}][\p{L}\p{N}_-]{0,59}:?[\s,]+)+)([\s\S]+)$/u);
 if(!match)return null;
 const names=[...new Set(match[1]!.split(/[\s,]+/).filter(Boolean).map(name=>name.slice(1).replace(/:$/u,"")))];
 const text=match[2]!.replace(/^[:\-–—]\s*/u,"").trim();
 if(!names.length||names.length>16||!text||text.length>20_000)return null;
 return {type:"CONTROL",actions:[{kind:"pane",operation:"prompt",target:{paneNames:names,state:"OPEN"},text,when:"AFTER_TURN"}]};
}
