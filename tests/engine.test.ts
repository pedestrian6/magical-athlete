import { describe, expect, it } from 'vitest';
import { applyAction, createGame, getPlayerView } from '../src/game/engine';
import { AWARDS, RACERS, TRACKS } from '../src/game/content';
import { exportGame, importGame, validateGameState } from '../src/session/storage';
import type { ActionInput, GameState, Task } from '../src/game/types';
let nonce=0;
const act=(s:GameState,a:ActionInput)=>applyAction(s,{...a,id:`test-${++nonce}`,revision:s.revision});
function fixture(ids:string[],positions:number[]=[],powerOverrides:Record<string,string>={}):GameState{
 const s=createGame({names:ids.map((_,i)=>`玩家${i}`),seed:123});s.phase='race';s.deck=[];s.market=[];s.draftOrder=[];s.draftIndex=0;s.selections={};s.duo=ids.length===2;s.firstPlayer=0;
 s.racers=ids.map((id,i)=>({id,playerId:i,position:positions[i]??0,tripped:false,finished:null,eliminated:false,power:powerOverrides[id]??id,eggBonus:false}));
 s.players.forEach((p,i)=>{p.team=[ids[i]];p.used=[ids[i]];p.score=0;s.selections[p.id]=[ids[i]];});s.turnOrder=ids;s.queue=[];s.pending=null;s.finishOrder=[];s.results=[];s.events=[];s.chainSeen=[];
 s.turn={actor:ids[0],number:1,stage:'ready',rolled:null,startPosition:positions[0]??0,rollCount:0,usedMerchants:[],modifiers:0,nextOverride:[]};return s;
}
function run(s:GameState,...queue:Task[]){s.queue=queue;s.paused=true;return act(s,{type:'continue'});}
function pick(s:GameState,id:string){expect(s.pending).not.toBeNull();return act(s,{type:'choose',decisionId:s.pending!.id,optionId:id});}
function main(s:GameState,value:number){s.turn!.rolled=value;return run(s,{kind:'resolveRoll',actor:s.turn!.actor});}
const pos=(s:GameState,id:string)=>s.racers.find(r=>r.id===id)!.position;
const trip=(s:GameState,id:string)=>s.racers.find(r=>r.id===id)!.tripped;
function finishDecisions(s:GameState){let n=0;while(s.pending&&n++<40){const options=s.pending.options;const preferred=options.find(x=>x.id==='skip')??options.find(x=>x.id==='keep')??options[0];s=pick(s,preferred.id);}return s;}
describe('36 名运动员的机制',()=>{
 it('alchemist：低点替换但3不出现替换选项',()=>{let s=main(fixture(['alchemist','twin']),1);s=pick(s,'yes');expect(pos(s,'alchemist')).toBe(4);expect(pos(main(fixture(['alchemist','twin']),3),'alchemist')).toBe(3);});
 it('baba_yaga：单独到达绊倒对方，同时到达不触发',()=>{let s=run(fixture(['baba_yaga','twin'],[3,1]),{kind:'move',moves:[{id:'twin',amount:2}]});expect(trip(s,'twin')).toBe(true);s=run(fixture(['baba_yaga','twin'],[1,1]),{kind:'move',moves:[{id:'twin',amount:2},{id:'baba_yaga',amount:2}]});expect(trip(s,'twin')).toBe(false);});
 it('banana：前后越过均绊倒；同格出发不算',()=>{for(const [a,b,delta,expected] of [[3,1,4,true],[3,5,-4,true],[3,3,2,false]]){const s=run(fixture(['banana','twin'],[a as number,b as number]),{kind:'move',moves:[{id:'twin',amount:delta as number}]});expect(trip(s,'twin')).toBe(expected);}});
 it('blimp：按回合开始位置判断第二拐角',()=>{for(const [p,expected] of [[14,20],[15,17]]){let s=fixture(['blimp','twin'],[p,0]);s.turn!.rolled=3;s=run(s,{kind:'startPower',actor:'blimp'},{kind:'modifiers',actor:'blimp'});expect(pos(s,'blimp')).toBe(expected);}});
 it('centaur：越过者后退2，同格出发不算超越',()=>{let s=run(fixture(['centaur','twin'],[1,3]),{kind:'move',moves:[{id:'centaur',amount:4}]});expect(pos(s,'twin')).toBe(1);s=run(fixture(['centaur','twin'],[3,3]),{kind:'move',moves:[{id:'centaur',amount:4}]});expect(pos(s,'twin')).toBe(3);});
 it('cheerleader：并列最后同时+2然后自己+1，也可放弃',()=>{let s=run(fixture(['cheerleader','twin','egg'],[4,0,0]),{kind:'startPower',actor:'cheerleader'});s=pick(s,'yes');expect(s.racers.map(r=>r.position)).toEqual([5,2,2]);s=pick(run(fixture(['cheerleader','twin']),{kind:'startPower',actor:'cheerleader'}),'skip');expect(pos(s,'cheerleader')).toBe(0);});
 it('coach：同格+1，异格不加',()=>{expect(pos(main(fixture(['twin','coach']),3),'twin')).toBe(4);expect(pos(main(fixture(['twin','coach'],[0,2]),3),'twin')).toBe(3);});
 it('copycat：并列选择、领跑改变后更新、独自领先无额外能力',()=>{let s=run(fixture(['copycat','coach','legs']),{kind:'copyCheck'});s=pick(s,'coach');expect(s.racers[0].power).toBe('coach');s.racers[2].position=5;s=run(s,{kind:'copyCheck'});expect(s.racers[0].power).toBe('legs');s.racers[0].position=8;s=run(s,{kind:'copyCheck'});expect(s.racers[0].power).toBe('copycat');});
 it('dicemonger：他人重掷先前进，保留不移动',()=>{let s=fixture(['twin','dicemonger']);s.turn!.rolled=1;s=run(s,{kind:'reroll',actor:'twin'});expect(pos(pick(s,'keep'),'dicemonger')).toBe(0);s=pick(s,'dicemonger');expect(pos(s,'dicemonger')).toBe(1);expect(s.turn!.usedMerchants).toContain('dicemonger');});
 it('duelist：只在同格提供决斗，可放弃且不改状态',()=>{let s=run(fixture(['duelist','twin']),{kind:'duelWindow',actor:'duelist'});expect(pick(s,'skip').racers.map(r=>r.position)).toEqual([0,0]);s=pick(s,'twin');expect(s.racers.map(r=>r.position).sort()).toEqual([0,2]);expect(run(fixture(['duelist','twin'],[0,2]),{kind:'duelWindow',actor:'duelist'}).pending).toBeNull();});
 it('egg：三选一，复制赛前能力',()=>{let s=fixture(['egg','twin']);s.deck=['sisyphus','coach','legs'];s=run(s,{kind:'preRace',actor:'egg'});expect(s.pending!.options).toHaveLength(3);s=pick(s,'sisyphus');expect(s.players[0].score).toBe(4);expect(s.racers[0].power).toBe('sisyphus');expect(s.deck).toHaveLength(0);});
 it('flip_flop：交换是同时传送且不触发越过',()=>{let s=run(fixture(['flip_flop','banana'],[1,4]),{kind:'main',actor:'flip_flop'});s=pick(s,'banana');expect(s.racers.map(r=>r.position)).toEqual([4,1]);expect(trip(s,'flip_flop')).toBe(false);});
 it('genius：猜中再行动，猜错无奖励；船长覆盖额外回合',()=>{let s=fixture(['genius','twin']);s.turn!.guess=3;s=main(s,3);expect(s.turn!.extra).toBe(true);s=fixture(['genius','twin']);s.turn!.guess=2;s=main(s,3);expect(s.turn!.extra).not.toBe(true);s=fixture(['genius','skipper']);s.turn!.guess=1;s=main(s,1);s=run(s,{kind:'advance',actor:'genius'});expect(s.turn!.actor).toBe('skipper');});
 it('gunk：减移动不减骰子，可叠加为负数',()=>{let s=main(fixture(['twin','gunk','egg'],[5,0,0],{egg:'gunk'}),1);expect(pos(s,'twin')).toBe(4);expect(s.turn!.rolled).toBe(1);expect(pos(main(fixture(['gunk','twin']),3),'gunk')).toBe(3);});
 it('hare：领先时不移动也不起身，并列时+2',()=>{let s=fixture(['hare','twin'],[3,0]);s.racers[0].tripped=true;s=run(s,{kind:'startPower',actor:'hare'},{kind:'main',actor:'hare'});expect(pos(s,'hare')).toBe(3);expect(trip(s,'hare')).toBe(true);expect(pos(main(fixture(['hare','twin']),3),'hare')).toBe(5);});
 it('heckler：完整回合终点距起点≤1才前进',()=>{let s=fixture(['twin','heckler'],[4,0]);s.turn!.startPosition=3;s=run(s,{kind:'endTurn',actor:'twin'});expect(pos(s,'heckler')).toBe(2);s=fixture(['twin','heckler'],[5,0]);s.turn!.startPosition=3;s=run(s,{kind:'endTurn',actor:'twin'});expect(pos(s,'heckler')).toBe(0);});
 it('huge_baby：同格移到后格，起点允许共格',()=>{let s=run(fixture(['huge_baby','twin'],[4,1]),{kind:'move',moves:[{id:'twin',amount:3}]});expect(pos(s,'twin')).toBe(3);s=run(fixture(['huge_baby','twin'],[0,2]),{kind:'move',moves:[{id:'twin',amount:-2}]});expect(pos(s,'twin')).toBe(0);});
 it('hypnotist：回合初传送指定角色，可放弃',()=>{let s=run(fixture(['hypnotist','twin'],[4,1]),{kind:'startPower',actor:'hypnotist'});expect(pos(pick(s,'skip'),'twin')).toBe(1);expect(pos(pick(s,'twin'),'twin')).toBe(4);});
 it('inchworm：别人1完全取消主移动，自己的1不取消',()=>{let s=main(fixture(['alchemist','inchworm']),1);expect(s.pending).toBeNull();expect(pos(s,'alchemist')).toBe(0);expect(pos(s,'inchworm')).toBe(1);expect(pos(main(fixture(['inchworm','twin']),1),'inchworm')).toBe(1);});
 it('lackey：别人6自己先动，自身6不奖励',()=>{const s=main(fixture(['twin','lackey']),6);expect(pos(s,'lackey')).toBe(2);expect(s.events.filter(e=>e.type==='move').map(e=>e.racerId)).toEqual(['lackey','twin']);expect(pos(main(fixture(['lackey','twin']),6),'lackey')).toBe(6);});
 it('leaptoad：只计空格，前后均有效',()=>{let s=run(fixture(['leaptoad','twin','egg'],[0,1,2]),{kind:'move',moves:[{id:'leaptoad',amount:2}]});expect(pos(s,'leaptoad')).toBe(4);s=run(fixture(['leaptoad','twin','egg'],[4,1,2]),{kind:'move',moves:[{id:'leaptoad',amount:-2}]});expect(pos(s,'leaptoad')).toBe(0);});
 it('legs：固定5不掷骰，照常受到距离修正',()=>{let s=run(fixture(['legs','gunk']),{kind:'main',actor:'legs'});s=pick(s,'yes');expect(pos(s,'legs')).toBe(4);expect(s.turn!.rolled).toBeNull();});
 it('lovable_loser：独自最后+1，并列不加，绊倒仍有效',()=>{let s=fixture(['lovable_loser','twin'],[0,2]);s.racers[0].tripped=true;s=run(s,{kind:'startPower',actor:'lovable_loser'});expect(s.players[0].score).toBe(1);expect(run(fixture(['lovable_loser','twin']),{kind:'startPower',actor:'lovable_loser'}).players[0].score).toBe(0);});
 it('magician：最多重掷2次，丢弃的1不触发尺蠖',()=>{let s=fixture(['magician','inchworm']);s.turn!.rolled=1;s=run(s,{kind:'reroll',actor:'magician'});s=pick(s,'magic');expect(pos(s,'inchworm')).toBe(0);s=pick(s,'magic');expect(s.turn!.rollCount).toBe(2);expect(s.pending).toBeNull();});
 it('mastermind：首回合预测；猜中自己获金银并结束',()=>{let s=fixture(['mastermind','twin'],[29,1]);s=run(s,{kind:'startPower',actor:'mastermind'});s=pick(s,'mastermind');s=run(s,{kind:'move',moves:[{id:'mastermind',amount:1}]});expect(s.finishOrder).toEqual(['mastermind','mastermind']);expect(s.players[0].score).toBe(4);expect(s.phase).toBe('raceEnd');});
 it('mouth：主动停入吃掉唯一对手，别人停入不吃',()=>{let s=run(fixture(['mouth','twin','egg'],[0,3,5]),{kind:'move',moves:[{id:'mouth',amount:3}]});expect(s.racers[1].eliminated).toBe(true);s=run(fixture(['mouth','twin','egg'],[3,0,5]),{kind:'move',moves:[{id:'twin',amount:3}]});expect(s.racers[1].eliminated).toBe(false);});
 it('party_animal：双向同时吸引，同格修正不算独立移动',()=>{let s=run(fixture(['party_animal','twin','egg'],[5,3,7]),{kind:'startPower',actor:'party_animal'});expect(s.racers.map(r=>r.position)).toEqual([5,4,6]);expect(pos(main(fixture(['party_animal','twin','egg']),3),'party_animal')).toBe(5);});
 it('rocket_scientist：先翻倍再修正并绊倒，拒绝不绊',()=>{let s=main(fixture(['rocket_scientist','coach']),3);expect(pos(pick(s,'yes'),'rocket_scientist')).toBe(7);expect(trip(pick(s,'yes'),'rocket_scientist')).toBe(true);expect(trip(pick(s,'skip'),'rocket_scientist')).toBe(false);});
 it('romantic：单人到达已有一人触发，同时到达不触发',()=>{let s=run(fixture(['romantic','twin','egg'],[0,3,1]),{kind:'move',moves:[{id:'egg',amount:2}]});expect(pos(s,'romantic')).toBe(2);s=run(fixture(['romantic','twin','egg'],[0,1,1]),{kind:'move',moves:[{id:'twin',amount:2},{id:'egg',amount:2}]});expect(pos(s,'romantic')).toBe(0);});
 it('scoocher：每次其他能力触发+1，自己不触发自己',()=>{let s=run(fixture(['scoocher','coach']),{kind:'notify',actor:'coach'},{kind:'notify',actor:'coach'});expect(pos(s,'scoocher')).toBe(2);s=run(fixture(['scoocher','coach']),{kind:'notify',actor:'scoocher'});expect(pos(s,'scoocher')).toBe(0);});
 it('sisyphus：赛前4分，最终6回起点扣1，分数不为负',()=>{let s=run(fixture(['sisyphus','twin'],[12,0]),{kind:'preRace',actor:'sisyphus'});expect(s.players[0].score).toBe(4);s=main(s,6);expect(pos(s,'sisyphus')).toBe(0);expect(s.players[0].score).toBe(3);s=main(fixture(['sisyphus','twin'],[12,0]),6);expect(s.players[0].score).toBe(0);});
 it('skipper：1改下位，其他点数不改',()=>{let s=main(fixture(['twin','skipper','egg']),1);expect(s.turn!.nextOverride).toEqual(['skipper']);s=main(fixture(['twin','skipper','egg']),2);expect(s.turn!.nextOverride).toEqual([]);});
 it('stickler：超过终点整次不动，恰好可冲线，自己不受限',()=>{let s=run(fixture(['stickler','twin','egg'],[25,28,0]),{kind:'move',moves:[{id:'twin',amount:3}]});expect(pos(s,'twin')).toBe(28);s=run(s,{kind:'move',moves:[{id:'twin',amount:2}]});expect(s.finishOrder[0]).toBe('twin');s=run(fixture(['stickler','twin','egg'],[28,0,1]),{kind:'move',moves:[{id:'stickler',amount:6}]});expect(s.finishOrder[0]).toBe('stickler');});
 it('suckerfish：可跟随后退，传送不提供跟随，前者先冲线',()=>{let s=run(fixture(['twin','suckerfish','egg'],[28,28,1]),{kind:'move',moves:[{id:'twin',amount:3}]});s=pick(s,'twin');expect(s.finishOrder).toEqual(['twin','suckerfish']);s=run(fixture(['twin','suckerfish','egg'],[5,5,0]),{kind:'move',moves:[{id:'twin',amount:-2}]});s=pick(s,'twin');expect(pos(s,'suckerfish')).toBe(3);s=run(fixture(['twin','suckerfish','egg'],[5,5,0]),{kind:'move',moves:[{id:'twin',amount:0,teleport:true,destination:8}]});expect(s.pending).toBeNull();expect(pos(s,'suckerfish')).toBe(5);});
 it('third_wheel：只有双人格可选，可以不传送',()=>{let s=run(fixture(['third_wheel','twin','egg'],[0,4,4]),{kind:'startPower',actor:'third_wheel'});expect(pos(pick(s,'4'),'third_wheel')).toBe(4);expect(pos(pick(s,'skip'),'third_wheel')).toBe(0);expect(run(fixture(['third_wheel','twin','egg'],[0,3,4]),{kind:'startPower',actor:'third_wheel'}).pending).toBeNull();});
 it('twin：只有之前金牌可复制，包含赛前奖励',()=>{let s=fixture(['twin','coach']);s.results=[{race:0,track:'mild',standings:[{racerId:'sisyphus',playerId:0,place:1,points:3},{racerId:'legs',playerId:1,place:2,points:1}],scores:[3,1]}];s=run(s,{kind:'preRace',actor:'twin'});expect(s.pending!.options.map(x=>x.id)).toEqual(['sisyphus','skip']);s=pick(s,'sisyphus');expect(s.players[0].score).toBe(4);expect(run(fixture(['twin','coach']),{kind:'preRace',actor:'twin'}).pending).toBeNull();});
});
describe('流程、赛道、存档和一致性',()=>{
 it('两面格子与奖励准确',()=>{expect(Object.keys(RACERS)).toHaveLength(36);expect(TRACKS.wild.length).toBe(29);expect(TRACKS.wild.spaces[16]).toEqual({kind:'move',amount:-4});expect(AWARDS).toEqual([[3,1],[4,2],[4,2],[5,3]]);});
 it('特殊格包括传送停格，但0移动不重复奖励',()=>{let s=fixture(['twin','egg','coach'],[0,4,6]);s.track='wild';s=run(s,{kind:'move',moves:[{id:'twin',amount:1}]});expect(s.players[0].score).toBe(1);s=run(s,{kind:'move',moves:[{id:'twin',amount:0}]});expect(s.players[0].score).toBe(1);s=run(s,{kind:'move',moves:[{id:'twin',amount:0,teleport:true,destination:7}]});expect(pos(s,'twin')).toBe(10);});
 it('重复动作幂等，过期操作拒绝',()=>{const s=createGame({names:['A','B','C'],seed:4});const a={type:'draft' as const,racerId:s.market[0],id:'abc',revision:0};const next=applyAction(s,a);expect(applyAction(next,a)).toBe(next);expect(()=>applyAction(next,{...a,id:'def'})).toThrow('过期');expect(s.players.every(p=>p.team.length===0)).toBe(true);});
 it('隐藏选择不会从used或selections泄露',()=>{let s=createGame({names:['A','B','C'],seed:4});while(s.phase==='draft')s=act(s,{type:'draft',racerId:s.market[0]});const pid=s.selectionPlayer,id=s.players[pid].team[0];s=act(s,{type:'select',playerId:pid,racerIds:[id]});const v=getPlayerView(s,null);expect(v.selections).toEqual({});expect(v.players[pid].used).not.toContain(id);expect('rng' in v).toBe(false);expect('deck' in v).toBe(false);});
 it('存档恢复待决技能后产生相同结果',()=>{const s=main(fixture(['alchemist','twin','egg']),1);const restored=importGame(exportGame(s));expect(pick(restored,'yes').racers).toEqual(pick(s,'yes').racers);});
 for(const [n,duo] of [[2,true],[3,false],[3,true],[4,false],[5,false],[6,false]] as const){
  it(`${n}人 ${duo?'双角色':'普通'} 从招募至四场结束，全部状态能存档`,()=>{
   let s=createGame({names:Array.from({length:n},(_,i)=>`P${i}`),duo,seed:936+n});let actions=0;
   while(s.phase!=='gameEnd'&&actions++<2500){
    validateGameState(s);
    if(s.phase==='draft')s=act(s,{type:'draft',racerId:s.market[0]});
    else if(s.phase==='selection'){const p=s.players[s.selectionPlayer];s=act(s,{type:'select',playerId:p.id,racerIds:p.team.filter(id=>!p.used.includes(id)).slice(0,s.duo?2:1)});}
    else if(s.phase==='reveal')s=act(s,{type:'reveal'});
    else if(s.phase==='raceEnd')s=act(s,{type:'nextRace'});
    else if(s.pending)s=finishDecisions(s);
    else if(s.paused)s=act(s,{type:'continue'});
    else s=act(s,{type:'roll'});
   }
   expect(s.phase,`停在${s.phase} ${s.turn?.actor} ${s.pending?.title}`).toBe('gameEnd');expect(s.results).toHaveLength(4);expect(s.players.every(p=>p.used.length===(s.duo?8:4))).toBe(true);expect(importGame(exportGame(s)).players).toEqual(s.players);
  });
 }
});
