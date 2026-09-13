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
