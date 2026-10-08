import type { GameState, PlayerView } from '../game/types';
import { getPlayerView } from '../game/engine';
import type { PublicGameView } from '../game/public';
/** Presentation snapshots only: never feed these intermediate frames back into the engine. */
export function makeReplay(previous: GameState, next: GameState, viewer: number | null): PlayerView[] {
  if(previous.racers.length===0||previous.racers.some(r=>!next.racers.some(n=>n.id===r.id)))return [];
  const frame=getPlayerView(previous,viewer), frames:PlayerView[]=[];
  const events=next.events.filter(e=>e.id>(previous.events.at(-1)?.id??0));
  for(const event of events){
    frame.events.push(event);
    const racer=frame.racers.find(r=>r.id===event.racerId);
    if(racer){
      if(event.type==='move'||event.type==='teleport')racer.position=event.to!;
      if(event.type==='trip')racer.tripped=true;
      if(event.type==='stand')racer.tripped=false;
      if(event.type==='eliminate')racer.eliminated=true;
      if(event.type==='finish')racer.finished=event.value!;
      if(event.type==='score')frame.players[racer.playerId].score+=event.value??0;
    }
    if(['move','teleport','trip','stand','eliminate','finish','ability','score','die'].includes(event.type))frames.push(structuredClone(frame));
  }
  // The final authority snapshot handles copy powers, turn changes and grouped arrivals.
  if(frames.length)frames.push(getPlayerView(next,viewer));
  return frames;
}

/** Network presentation reads only public snapshots, never reconstructs authority. */
export function makePublicReplay(previous: PublicGameView, next: PublicGameView): PublicGameView[] {
  if(previous.id !== next.id || previous.race !== next.race || previous.racers.length === 0 || previous.racers.some(r => !next.racers.some(n => n.id === r.id))) return [];
  const frame = structuredClone(previous), frames: PublicGameView[] = [];
  for(const event of next.events.filter(e => e.id > (previous.events.at(-1)?.id ?? 0))) {
    frame.events.push(event);
    const racer = frame.racers.find(r => r.id === event.racerId);
    if(racer) {
      if(event.type === 'move' || event.type === 'teleport') racer.position = event.to!;
      if(event.type === 'trip') racer.tripped = true;
      if(event.type === 'stand') racer.tripped = false;
      if(event.type === 'eliminate') racer.eliminated = true;
      if(event.type === 'finish') racer.finished = event.value!;
      if(event.type === 'score') frame.players[racer.playerId].score += event.value ?? 0;
    }
    if(['move','teleport','trip','stand','eliminate','finish','ability','score','die'].includes(event.type)) frames.push(structuredClone(frame));
  }
  if(frames.length) frames.push(next);
  return frames;
}
