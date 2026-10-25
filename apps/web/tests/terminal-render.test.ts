import {describe,it,expect,vi} from "vitest";
import type {TerminalRenderObservation} from "@space/contracts";
import {classifyTerminalRender,observeTerminalRender} from "../src/features/terminal-render/terminal-render-observer.js";
import {createTerminalRenderSampler} from "../src/features/terminal-render/terminal-render-sampler.js";
const sample=():TerminalRenderObservation=>({schemaVersion:1,roomId:"room:render1",paneId:"pane:render1",surfaceGeneration:"surface:one",sessionId:null,runtimeId:null,observedAt:1000,renderer:"DOM",visibility:"VISIBLE",verdict:"INCONCLUSIVE",reasons:[],geometry:{hostWidth:801,hostHeight:482,screenWidth:800,screenHeight:480,cols:100,rows:30,cellWidth:8,cellHeight:16,domRows:30,dpr:2,zoom:1,coverageRatio:0.99,clippedWidth:0,clippedHeight:0},transportSequence:null,parserSequence:null,renderSequence:null,sampleDurationMs:0.2});
describe('read-only terminal render diagnostics',()=>{
 it('tolerates legal cell rounding and does not infer faults from coverage alone',()=>{const s=sample();s.geometry!.coverageRatio=0.2;expect(classifyTerminalRender(s).verdict).toBe('HEALTHY');});
 it('requires persistent stable clipping and same surface before FAULT',()=>{const s=sample();s.geometry!.clippedHeight=48;const first=classifyTerminalRender(s);expect(first.verdict).toBe('SUSPECTED');expect(classifyTerminalRender({...s,observedAt:1500},first).verdict).toBe('FAULT');expect(classifyTerminalRender({...s,surfaceGeneration:'surface:two',observedAt:1500},first).verdict).toBe('SUSPECTED');expect(classifyTerminalRender({...s,observedAt:9000},first).verdict).toBe('SUSPECTED');});
 it.each(['HIDDEN','MINIMIZED'] as const)('never faults %s panes',visibility=>{const s=sample();s.geometry!.clippedHeight=500;expect(classifyTerminalRender({...s,visibility}).verdict).toBe('NOT_APPLICABLE');});
 it('reports unsupported renderer and unmounted surfaces honestly',()=>{expect(classifyTerminalRender({...sample(),renderer:'UNKNOWN'}).verdict).toBe('INCONCLUSIVE');expect(observeTerminalRender('room:missing','pane:missing').visibility).toBe('UNMOUNTED');});
 it('never reads terminal text to classify literal ANSI, idle or scrollback',()=>{const div=document.createElement('div');Object.defineProperty(div,'textContent',{get(){throw Error('private content read');}});document.body.append(div);expect(()=>observeTerminalRender('room:missing','pane:missing')).not.toThrow();div.remove();});
 it('has no timers, bounds rate fairly and stops without additional work',()=>{
   const targets=vi.fn(()=>Array.from({length:16},(_,i)=>({roomId:'room:render1',paneId:`pane:render${i}`})));
   const take=vi.fn((roomId,paneId)=>({...sample(),roomId,paneId}));const event=vi.fn();
   const timer=vi.spyOn(window,'setInterval'),timeout=vi.spyOn(window,'setTimeout');
   const sampler=createTerminalRenderSampler(event,{now:()=>0,targets,sample:take});expect(targets).not.toHaveBeenCalled();
   for(let t=0;t<4000;t+=16)sampler.tick(t);
   expect(take.mock.calls.length).toBeLessThanOrEqual(16);expect(new Set(take.mock.calls.map(c=>c[1])).size).toBe(16);
   expect(timer).not.toHaveBeenCalled();expect(timeout).not.toHaveBeenCalled();
   sampler.stop();const count=take.mock.calls.length;sampler.tick(5000);expect(take).toHaveBeenCalledTimes(count);expect(sampler.records()).toEqual([]);vi.restoreAllMocks();
 });
 it('backs off only sampling when cost exceeds budget and caps ring',()=>{let time=0;const event=vi.fn();const sampler=createTerminalRenderSampler(event,{now:()=>time+=3,targets:()=>[{roomId:'room:render1',paneId:'pane:render1'}],sample:()=>sample()});for(let t=0;t<300000;t+=250)sampler.tick(t);expect(sampler.records()).toHaveLength(256);expect(event.mock.calls[0]![0].reasons).toContain('BUDGET_LIMITED');expect(event).toHaveBeenCalledTimes(300);sampler.stop();});
});
