import type { ControlAction, RoomQuickCommand } from "@space/contracts";
type MusicCommand = Extract<RoomQuickCommand, { type: "MUSIC" }>;
interface PlaybackTarget {
  roomId: string;
  kind: "YOUTUBE" | "MUSIC";
  playing: boolean;
  control?(command: Extract<ControlAction,{kind:"playback"}>): boolean | Promise<boolean>;
  run(command: MusicCommand): boolean | Promise<boolean>;
}
const targets = new Map<string, PlaybackTarget>();
const applied = new Map<string, { payload: string; result: Promise<boolean>; settled: boolean }>();
const playbackTails = new Map<string, Promise<boolean>>();
export function registerRoomPlaybackTarget(id: string, target: PlaybackTarget) {
  targets.set(id, target);
  return () => { if (targets.get(id) === target) targets.delete(id); };
}
export function runRoomPlaybackCommand(roomId: string, requestId: string, command: MusicCommand): Promise<boolean> {
  const key = JSON.stringify([roomId, requestId]);
  const existing = applied.get(key);
  const payload = JSON.stringify([command.action, command.target]);
  if (existing) return existing.payload === payload ? existing.result : Promise.resolve(false);
  const previous = playbackTails.get(roomId) ?? Promise.resolve(true);
  const entry = { payload, settled: false, result: Promise.resolve(false) };
  const result = previous.then(async () => {
    // Re-evaluate playing state after the preceding command has actually finished.
    const candidates = [...targets.values()].filter(target => target.roomId === roomId);
    const youtube = candidates.filter(target => target.kind === "YOUTUBE");
    const active = candidates.filter(target => target.playing);
    const preferred = command.target === "YOUTUBE" ? youtube : active.length ? active : youtube.length ? youtube : candidates;
    return preferred.length === 1 ? Boolean(await preferred[0]!.run(command)) : false;
  }).catch(() => false);
  entry.result = result;
  applied.set(key, entry);
  playbackTails.set(roomId, result);
  void result.then(() => {
    entry.settled = true;
    if (playbackTails.get(roomId) === result) playbackTails.delete(roomId);
    // Never evict an in-flight NEXT promise, even under a burst of commands.
    for (const [oldKey, old] of applied) {
      if (applied.size <= 256) break;
      if (old.settled) applied.delete(oldKey);
    }
  });
  return result;
}

export function inspectPlaybackTargets(roomId:string){return [...targets.entries()].filter(([,t])=>t.roomId===roomId).map(([id,t])=>({id,kind:t.kind,playing:t.playing}));}
export async function runExtendedPlaybackCommand(roomId:string,command:Extract<ControlAction,{kind:"playback"}>){
 const candidates=[...targets.entries()].filter(([id,t])=>t.roomId===roomId&&(!command.targetId||id===command.targetId)&&(command.target==="AUTO"||t.kind===command.target));
 const playing=candidates.filter(([,t])=>t.playing);
 const selected=command.targetId?candidates:playing.length?playing:candidates;
 if(selected.length!==1)return false;
 const target=selected[0]![1];
 if(target.control)return Boolean(await target.control(command));
 if(["play","pause","next","previous"].includes(command.operation))return target.run({type:"MUSIC",action:command.operation.toUpperCase() as MusicCommand["action"],target:command.target==="MUSIC"?"AUTO":command.target});
 return false;
}
