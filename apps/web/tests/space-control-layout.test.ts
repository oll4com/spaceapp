// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyControlLayout } from "../src/features/room-agent/space-control-client.js";
function element(id:string,left:number,top:number,width:number,height:number){
 const parent=document.querySelector("main")??document.body.appendChild(document.createElement("main"));
 parent.getBoundingClientRect=()=>({left:10,top:20,width:1000,height:1000}) as DOMRect;
 const pane=parent.appendChild(document.createElement("article"));pane.dataset.spacePaneId=id;pane.dataset.spaceRoomId="room";
 pane.getBoundingClientRect=()=>({left,top,width,height}) as DOMRect;
 Object.defineProperty(pane,"offsetParent",{value:parent});return pane;
}
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks();});
describe("Space control DOM evidence",()=>{
 it("requires rendered custom positions and sizes rather than an accepted state update",()=>{
  const pane=element("a",260,44,500,240);
  const layout={mode:"CUSTOM" as const,columns:2,placements:[{paneId:"a",x:25,y:2,width:50,height:20}]};
  expect(verifyControlLayout("room",layout,["a"])).toBe(true);
  pane.getBoundingClientRect=()=>({left:260,top:44,width:400,height:240}) as DOMRect;
  expect(verifyControlLayout("room",layout,["a"])).toBe(false);
 });
 it("rejects missing panes and verifies the visual grid order",()=>{
  element("a",510,20,500,240);element("b",10,20,500,240);
  expect(verifyControlLayout("room",null,["a","b"])).toBe(false);
  expect(verifyControlLayout("room",null,["b","a"])).toBe(true);
  expect(verifyControlLayout("room",null,["b","a","missing"])).toBe(false);
 });
 it("does not require minimized panes to occupy their saved custom rectangle",()=>{
  element("a",10,20,500,240);
  expect(verifyControlLayout("room",{mode:"CUSTOM",columns:2,placements:[{paneId:"a",x:0,y:0,width:50,height:20},{paneId:"minimized",x:50,y:0,width:50,height:20}]},["a"])).toBe(true);
 });
});
