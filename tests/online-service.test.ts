import { afterEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomService, RETENTION_MS, type StoredRoom, type Draw } from '../server/service';
import { applyAction, createGame } from '../src/game/engine';
import type { ActionInput, GameState } from '../src/game/types';
import type { RoomCommandInput, RoomCommand } from '../src/session/protocol';
const services:RoomService[]=[];const dirs:string[]=[];
afterEach(()=>{for(const s of services.splice(0))try{s.close();}catch{}for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function setup(n=3,duo=false,now?:()=>number,path=':memory:'){
 let rng=936+n;
 const draw=(max:number)=>{rng^=rng<<13;rng^=rng>>>17;rng^=rng<<5;rng>>>=0;return Math.floor(rng/4294967296*max);};
 const s=new RoomService(path,now,draw);services.push(s);const tokens=Array.from({length:n},()=>s.session().token);
 const access=s.create(tokens[0],{name:'玩家0',capacity:n,duo});const code=access.code;const accesses=[access];
 for(let i=1;i<n;i++)accesses.push(s.join(tokens[i],code,{name:`玩家${i}`}));
 const connections=tokens.map((t,i)=>{const id=`connection-${i}`;s.connect(t,code,id);return id;});
 function command(i:number,input:RoomCommandInput){return{...input,id:randomUUID(),roomCode:code,protocolVersion:1 as const};}
 function act(i:number,input:RoomCommandInput){return s.execute(tokens[i],connections[i],command(i,input));}
 function game(i:number,action:ActionInput,revision?:number,race?:number){const g=s.getRoom(code).game!;return act(i,{type:'game',gameId:g.id,revision:revision??g.revision,race:race??g.race,action});}
 function start(){for(let i=0;i<n;i++)act(i,{type:'ready',ready:true});act(0,{type:'start'});}
 return{s,tokens,connections,accesses,code,act,game,start,command};
}
function chooseAction(g:GameState):{pid:number;action:ActionInput}{
 if(g.phase==='draft')return{pid:g.draftOrder[g.draftIndex],action:{type:'draft',racerId:g.market[0]}};
 if(g.phase==='selection'){const p=[...g.players].reverse().find(p=>!g.selections[p.id])!;return{pid:p.id,action:{type:'select',playerId:p.id,racerIds:p.team.filter(id=>!p.used.includes(id)).slice(0,g.duo?2:1)}};}
 if(g.phase==='reveal')return{pid:0,action:{type:'reveal'}};
 if(g.phase==='raceEnd')return{pid:0,action:{type:'nextRace'}};
 if(g.pending){const option=g.pending.options.find(o=>o.id==='skip'||o.id==='keep')??g.pending.options[0];return{pid:g.pending.playerId,action:{type:'choose',decisionId:g.pending.id,optionId:option.id}};}
 return{pid:g.racers.find(r=>r.id===g.turn?.actor)!.playerId,action:{type:g.paused?'continue':'roll'}};
}
function toSelection(f:ReturnType<typeof setup>){f.start();while(f.s.getRoom(f.code).game!.phase==='draft'){const g=f.s.getRoom(f.code).game!,a=chooseAction(g);f.game(a.pid,a.action);}}
describe('authoritative friend rooms',()=>{
 test.each([[2,false],[3,false],[3,true],[4,false],[5,false],[6,false]] as const)('%i players duo=%s completes four races and replays private random tape',(n,duo)=>{
  const f=setup(n,duo);f.start();let count=0;
  while(f.s.getRoom(f.code).game!.phase!=='gameEnd'){
   const g=f.s.getRoom(f.code).game!,a=chooseAction(g);f.game(a.pid,a.action);if(++count>3000)throw new Error('match failed to finish');
  }
  const final=f.s.getRoom(f.code).game!;expect(final.results).toHaveLength(4);expect(f.s.view(f.tokens[0],f.code).status).toBe('finished');
  let replay:GameState|undefined;
  for(const row of f.s.audit(f.code)){
   const c=JSON.parse(row.command as string) as RoomCommand,draws=JSON.parse(row.draws as string) as Draw[];let consumed=0;
   const opts={selectionMode:'simultaneous' as const,gameId:final.id,drawInt:(max:number)=>{const d=draws[consumed++];expect(d?.max).toBe(max);return d.value;}};
   if(c.type==='start')replay=createGame({names:final.players.map(p=>p.name),duo},opts);
   if(c.type==='game')replay=applyAction(replay!,{...c.action,id:c.id,revision:replay!.revision},opts);
   expect(consumed).toBe(draws.length);
  }
  expect(replay).toEqual(final);
 });
 test('simultaneous locks accept stale global revision but reject previous race, spoofing and duplicate locks',()=>{
  const f=setup();toSelection(f);const g=f.s.getRoom(f.code).game!,rev=g.revision;
  const ids=g.players.map(p=>p.team[0]);
  expect(()=>f.game(0,{type:'select',playerId:1,racerIds:[ids[1]]},rev)).toThrow();
  f.game(2,{type:'select',playerId:2,racerIds:[ids[2]]},rev);
  const view=f.s.view(f.tokens[0],f.code).game!;
  expect(view.selections[2]).toBeUndefined();expect(view.players[2].used).not.toContain(ids[2]);expect(view.lockedPlayerIds).toEqual([2]);
  expect(JSON.stringify(view)).not.toMatch(/"(rng|queue|task|chainSeen|processedActions|recoveryHash|sessionHash)":/);
  expect(view.id).not.toMatch(/^game-/);
  expect(()=>f.game(2,{type:'select',playerId:2,racerIds:[ids[2]]},rev)).toThrow();
  f.game(0,{type:'select',playerId:0,racerIds:[ids[0]]},rev);
  expect(()=>f.game(1,{type:'select',playerId:1,racerIds:[ids[1]]},rev,1)).toThrow();
  f.game(1,{type:'select',playerId:1,racerIds:[ids[1]]},rev);
  expect(f.s.view(f.tokens[1],f.code).game!.phase).toBe('reveal');
  expect(f.s.view(f.tokens[0],f.code).game!.selections[2]).toEqual([ids[2]]);
 });
 test('authorizes actors, preserves idempotency across ack loss and database restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'athlete-db-'));dirs.push(dir);const path=join(dir,'rooms.sqlite');const f=setup(3,false,undefined,path);f.start();
  const g=f.s.getRoom(f.code).game!,pid=g.draftOrder[g.draftIndex],a:ActionInput={type:'draft',racerId:g.market[0]};
  expect(()=>f.game((pid+1)%3,a)).toThrow();
  const command=f.command(pid,{type:'game',gameId:g.id,revision:g.revision,race:g.race,action:a});
  const ack=f.s.execute(f.tokens[pid],f.connections[pid],command),state=f.s.getRoom(f.code);
  expect(f.s.execute(f.tokens[pid],f.connections[pid],command)).toEqual(ack);expect(f.s.getRoom(f.code)).toEqual(state);
  expect(()=>f.s.execute(f.tokens[pid],f.connections[pid],{...command,action:{type:'draft',racerId:g.market[1]}})).toThrow();
  f.s.close();services.splice(services.indexOf(f.s),1);const next=new RoomService(path);services.push(next);next.connect(f.tokens[pid],f.code,'restart',f.connections[pid],false);
  expect(next.execute(f.tokens[pid],'restart',command)).toEqual(ack);expect(next.getRoom(f.code)).toEqual(state);
 });
 test('new host gets thirty seconds even on long-running service',()=>{
  let now=0;const s=new RoomService(':memory:',()=>now);services.push(s);const a=s.session().token,b=s.session().token;now=60_000;const room=s.create(a,{name:'a',capacity:2,duo:true});s.join(b,room.code,{name:'b'});s.connect(b,room.code,'guest');s.tick();expect(s.getRoom(room.code).hostSeatId).toBe(room.seatId);now+=30_000;s.tick();expect(s.getRoom(room.code).hostSeatId).not.toBe(room.seatId);
 });
 test('old disconnected page cannot steal back current controller',()=>{
  const f=setup();f.s.connect(f.tokens[0],f.code,'old','old-page',true);f.s.disconnect(f.code,f.accesses[0].seatId,'old');f.s.connect(f.tokens[0],f.code,'new','new-page',true);expect(()=>f.s.connect(f.tokens[0],f.code,'old-reconnect','old-page',false)).toThrow(/接管/);expect(f.s.isCurrent(f.tokens[0],f.code,'new').id).toBe(f.accesses[0].seatId);
 });
 test('saving failure does not change authoritative state or acknowledge success',()=>{
  const f=setup();const before=f.s.getRoom(f.code);
  f.s.db.exec("CREATE TRIGGER fail_command BEFORE INSERT ON commands BEGIN SELECT RAISE(ABORT,'test save failure'); END;");
  expect(()=>f.act(0,{type:'ready',ready:true})).toThrow();expect(f.s.getRoom(f.code)).toEqual(before);
 });
 test('recovery rotates code, revokes old browser and makes last page sole controller',()=>{
  const f=setup();const newToken=f.s.session().token;
  const access=f.s.recover(newToken,f.code,{recoveryCode:f.accesses[1].recoveryCode});
  expect(access.recoveryCode).not.toBe(f.accesses[1].recoveryCode);
  expect(()=>f.s.view(f.tokens[1],f.code)).toThrow();
  expect(()=>f.s.recover(f.tokens[1],f.code,{recoveryCode:f.accesses[1].recoveryCode})).toThrow();
  f.s.connect(newToken,f.code,'page-a');expect(f.s.connect(newToken,f.code,'page-b').old).toBe('page-a');
  expect(()=>f.s.execute(newToken,'page-a',f.command(1,{type:'ready',ready:true}))).toThrow();
  expect(f.s.execute(newToken,'page-b',f.command(1,{type:'ready',ready:true})).ok).toBe(true);
 });
 test('offline host transfer is 30 seconds and presence does not extend seven days',()=>{
  let now=1_000_000;const f=setup(3,false,()=>now);const expiry=f.s.view(f.tokens[0],f.code).expiresAt;
  f.s.disconnect(f.code,f.accesses[0].seatId,f.connections[0]);now+=29_999;f.s.tick();expect(f.s.getRoom(f.code).hostSeatId).toBe(f.accesses[0].seatId);
  now++;f.s.tick();expect(f.s.getRoom(f.code).hostSeatId).toBe(f.accesses[1].seatId);expect(f.s.view(f.tokens[1],f.code).expiresAt).toBe(expiry);
  now=expiry;expect(()=>f.s.view(f.tokens[1],f.code)).toThrow(/到期/);f.s.tick();expect(f.s.stats().rooms).toBe(0);expect(f.s.audit(f.code)).toHaveLength(0);
 });
 test('offline nonacting players do not freeze draft; lobby permissions cannot rewrite a running match',()=>{
  const f=setup();f.start();const g=f.s.getRoom(f.code).game!,pid=g.draftOrder[g.draftIndex],offline=(pid+1)%3;
  f.s.disconnect(f.code,f.accesses[offline].seatId,f.connections[offline]);expect(f.game(pid,{type:'draft',racerId:g.market[0]}).ok).toBe(true);
  expect(()=>f.act(pid,{type:'configure',capacity:2,duo:true})).toThrow();expect(()=>f.act(0,{type:'kick',seatId:f.accesses[1].seatId})).toThrow();
 });
 test('decision owner differs from turn actor and survives reopening the database',()=>{
  const dir=mkdtempSync(join(tmpdir(),'athlete-decision-'));dirs.push(dir);const path=join(dir,'rooms.sqlite');const f=setup(3,false,undefined,path);f.start();
  let count=0;
  while(!f.s.getRoom(f.code).game!.pending&&count++<1000){const g=f.s.getRoom(f.code).game!;if(g.phase==='gameEnd')break;const a=chooseAction(g);f.game(a.pid,a.action);}
  const saved=f.s.getRoom(f.code),pending=saved.game!.pending;expect(pending).not.toBeNull();
  const owner=pending!.playerId,other=(owner+1)%3;
  expect(f.s.view(f.tokens[other],f.code).game!.pending!.options).toEqual([]);
  expect(()=>f.game(other,{type:'choose',decisionId:pending!.id,optionId:pending!.options[0].id})).toThrow();
  f.s.close();services.splice(services.indexOf(f.s),1);const next=new RoomService(path);services.push(next);next.connect(f.tokens[owner],f.code,'restored',f.connections[owner],false);
  expect(next.view(f.tokens[owner],f.code).game!.pending!.id).toBe(pending!.id);
  expect(next.getRoom(f.code)).toEqual(saved);
 });
});
