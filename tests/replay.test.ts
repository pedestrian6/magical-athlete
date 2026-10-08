import { expect, it } from 'vitest';
import { createGame,applyAction } from '../src/game/engine';
import { makeReplay } from '../src/ui/replay';
import type { GameState,ActionInput } from '../src/game/types';
let id=0;
const act=(s:GameState,a:ActionInput)=>applyAction(s,{...a,id:String(++id),revision:s.revision});
it('动画为只读展示，关闭或播放不改变对局权威状态',()=>{
 let s=createGame({names:['A','B','C'],seed:30});while(s.phase==='draft')s=act(s,{type:'draft',racerId:s.market[0]});while(s.phase==='selection'){const p=s.players[s.selectionPlayer];s=act(s,{type:'select',playerId:p.id,racerIds:[p.team[0]]});}s=act(s,{type:'reveal'});while(s.pending)s=act(s,{type:'choose',decisionId:s.pending.id,optionId:s.pending.options[0].id});
 const before=JSON.stringify(s),next=act(s,{type:'roll'}),nextBefore=JSON.stringify(next);const frames=makeReplay(s,next,null);
 expect(JSON.stringify(s)).toBe(before);expect(JSON.stringify(next)).toBe(nextBefore);expect(frames.length).toBeGreaterThan(0);expect(frames.at(-1)!.racers).toEqual(next.racers);frames[0].players[0].score=999;expect(next.players[0].score).not.toBe(999);
});
it('相同种子与相同操作产生完全一致的状态',()=>{
 const config={names:['A','B','C','D'],seed:20261003};let a=createGame(config),b=createGame(config);
 for(let i=0;i<4;i++){const action={type:'draft' as const,racerId:a.market[0],id:`repro-${i}`,revision:a.revision};a=applyAction(a,action);b=applyAction(b,action);}expect(a).toEqual(b);
});
