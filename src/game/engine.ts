import { AWARDS, RACERS, RULES_VERSION, TRACKS } from './content';
import type { Decision, GameAction, GameConfig, GameEvent, GameState, MoveSpec, PlayerView, Racer, Task, Trigger } from './types';
/** Trusted session policy. Online adapters must supply these options on every call. */
export interface EngineOptions {
  selectionMode?: 'sequential' | 'simultaneous';
  drawInt?: (max: number) => number;
  gameId?: string;
}
const COLORS = ['#7757bd','#da724b','#339b8d','#4584b8','#bd6386','#a18a32'];
const name = (id: string) => RACERS[id]?.name ?? id;
const get = (s: GameState, id: string) => s.racers.find(r => r.id === id)!;
const active = (r: Racer) => !r.eliminated && r.finished === null;
const live = (s: GameState) => s.racers.filter(active);
const has = (r: Racer, p: string) => r.power === p;
function emit(s: GameState, type: string, message: string, detail: Partial<GameEvent> = {}) { s.events.push({ id: (s.events.at(-1)?.id ?? 0) + 1, type, message, race: s.race, ...detail }); }
function random(s: GameState) { let x = s.rng || 0x6d2b79f5; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; s.rng = x >>> 0; return s.rng / 4294967296; }
function drawInt(s: GameState, max: number, options: EngineOptions): number {
  if (!options.drawInt) return Math.floor(random(s) * max);
  const value = options.drawInt(max);
  if (!Number.isInteger(value) || value < 0 || value >= max) throw new Error('随机抽样结果无效。');
  // In injected mode rng is a persisted draw cursor, not a predictable RNG state.
  // Advancing it also keeps random-consuming chains distinct in loop detection.
  s.rng = (s.rng + 1) >>> 0;
  return value;
}
function die(s: GameState, who: string, options: EngineOptions) { const value = 1 + drawInt(s, 6, options); emit(s, 'die', `${who}掷出 ${value}`, { value }); return value; }
function rolloff(s: GameState, ids: number[], purpose: string, options: EngineOptions): number {
  let contenders = [...ids];
  for (let i = 0; i < 100; i++) { const rolls = contenders.map(id => ({ id, n: die(s, s.players[id].name, options) })); const max = Math.max(...rolls.map(r => r.n)); contenders = rolls.filter(r => r.n === max).map(r => r.id); if (contenders.length === 1) { emit(s, 'order', `${s.players[contenders[0]].name}获得${purpose}`); return contenders[0]; } }
  throw new Error('连续平局异常，请重新开始。');
}
function prepend(s: GameState, ...tasks: Task[]) { s.queue.unshift(...tasks); }
function ask(s: GameState, actor: string, kind: string, title: string, options: Decision['options'], task: Partial<Task> = {}, description?: string) {
  if (!options.length) return;
  s.pending = { id: `${s.revision}:${s.events.at(-1)?.id ?? 0}:${kind}:${actor}`, playerId: get(s, actor).playerId, actor, title, description: description ?? RACERS[get(s, actor).power ?? actor]?.description ?? '', options, task: { kind, actor, ...task } };
}
const skip = { id: 'skip', label: '不发动，继续' };
const yes = { id: 'yes', label: '发动能力' };
const optionsFor = (ids: string[]) => ids.map(id => ({ id, label: name(id) }));
function priority(s: GameState): Racer[] {
  const owner = s.turn ? get(s, s.turn.actor)?.playerId ?? s.firstPlayer : s.firstPlayer;
  return live(s).sort((a,b) => (a.id===s.turn?.actor?-1:b.id===s.turn?.actor?1:0) || ((a.playerId-owner+s.players.length)%s.players.length)-((b.playerId-owner+s.players.length)%s.players.length) || s.turnOrder.indexOf(a.id)-s.turnOrder.indexOf(b.id));
}
function ability(s: GameState, actor: string, tasks: Task[], label?: string) {
  emit(s, 'ability', `${name(actor)} · ${label ?? name(get(s,actor).power ?? actor)}`, { racerId: actor });
  prepend(s, ...tasks, { kind: 'notify', actor });
}
function points(s: GameState, id: string, delta: number) { const r = get(s,id), p = s.players[r.playerId]; const before=p.score; p.score=Math.max(0,p.score+delta); emit(s,'score',`${p.name} ${p.score-before>=0?'+':''}${p.score-before} 分（${name(id)}）`,{racerId:id,value:p.score-before}); }
function makeDraftBatch(s: GameState) {
  const n = s.players.length, batch = s.draftBatch;
  const start = (s.firstPlayer + batch) % n;
  const clockwise = Array.from({length:n},(_,i)=>(start+i)%n);
  let order = [...clockwise,...[...clockwise].reverse()];
  if (n===2) order = [...order,...order];
  s.draftOrder=order; s.draftIndex=0; s.market=s.deck.splice(0,order.length);
}
export function createGame(config: GameConfig, options: EngineOptions = {}): GameState {
  if(config.names.length<2 || config.names.length>6 || config.names.some(n=>!n.trim()||n.trim().length>30)) throw new Error('请填写 2–6 位玩家的名称（每个最多 30 字）。');
  if(config.duo && config.names.length>3) throw new Error('双角色规则仅支持 2 或 3 人。');
  const seed=config.seed ?? 1;
  if(!Number.isInteger(seed)||seed<0||seed>0xffffffff) throw new Error('随机种子必须是 0–4294967295 的整数。');
  if(options.gameId !== undefined && (!options.gameId.trim() || options.gameId.length > 200)) throw new Error('对局标识无效。');
  const s:GameState={schemaVersion:1,rulesVersion:RULES_VERSION,id:options.gameId??`game-${seed}`,revision:0,rng:options.drawInt?0:seed||1,phase:'draft',players:config.names.map((n,id)=>({id,name:n.trim(),color:COLORS[id],team:[],used:[],score:0,gold:0,silver:0})),duo:config.names.length===2||!!config.duo,race:0,track:'mild',deck:Object.keys(RACERS),market:[],draftOrder:[],draftIndex:0,draftBatch:0,firstPlayer:0,selectionPlayer:0,selections:{},racers:[],turnOrder:[],turn:null,queue:[],pending:null,events:[],results:[],raceStartScores:config.names.map(()=>0),finishOrder:[],processedActions:[],chainSeen:[],paused:false};
  for(let i=s.deck.length-1;i>0;i--){const j=drawInt(s,i+1,options);[s.deck[i],s.deck[j]]=[s.deck[j],s.deck[i]];}
  s.firstPlayer=rolloff(s,s.players.map(p=>p.id),'招募先手',options);makeDraftBatch(s);return s;
}
function newTurn(s:GameState,id:string,ready=true){s.turn={actor:id,number:(s.turn?.number??0)+1,stage:ready?'ready':'resolving',rolled:null,startPosition:get(s,id).position,rollCount:0,usedMerchants:[],modifiers:0,nextOverride:[]};s.chainSeen=[];}
function setupRace(s:GameState){
  s.racers=s.players.flatMap(p=>s.selections[p.id].map(id=>({id,playerId:p.id,position:0,tripped:false,finished:null,eliminated:false,power:id,eggBonus:false})));
  s.turnOrder=Array.from({length:s.players.length},(_,i)=>(s.firstPlayer+i)%s.players.length).flatMap(pid=>s.selections[pid]);
  s.finishOrder=[];s.raceStartScores=s.players.map(p=>p.score);s.phase='race';newTurn(s,s.turnOrder[0],false);
  s.queue=s.turnOrder.map(actor=>({kind:'preRace',actor}));s.queue.push({kind:'copyCheck'},{kind:'ready'});
  emit(s,'race',`第 ${s.race+1} 场开始 · ${TRACKS[s.track].name}`);
}
function award(s:GameState,id:string){
  if(s.finishOrder.length>=2)return;
  const r=get(s,id), place=s.finishOrder.length+1;s.finishOrder.push(id);if(r.finished===null)r.finished=place;
  const p=s.players[r.playerId];points(s,id,AWARDS[s.race][place-1]);if(place===1)p.gold++;else p.silver++;
  emit(s,'finish',`${name(id)}获得${place===1?'冠军':'亚军'}！`,{racerId:id,value:place});
}
function finish(s:GameState,id:string){
  const r=get(s,id);if(!active(r))return;
  award(s,id);
  if(s.finishOrder.length===1){
    const prophets=priority(s).filter(r=>has(r,'mastermind')&&r.prediction===id);
    if(has(r,'mastermind')&&r.prediction===id)prophets.unshift(r);
    prophets.sort((a,b)=>(a.id==='mastermind'?-1:0)-(b.id==='mastermind'?-1:0));
    if(prophets[0])award(s,prophets[0].id);
  }
  checkRaceEnd(s);
}
function checkRaceEnd(s:GameState){
  if(s.phase!=='race')return;
  if(s.finishOrder.length<2 && live(s).length===1)award(s,live(s)[0].id);
  if(s.finishOrder.length>=2||live(s).length===0){
    s.queue=[];s.pending=null;s.paused=false;
    s.results.push({race:s.race,track:s.track,standings:s.finishOrder.map((id,i)=>({racerId:id,playerId:get(s,id).playerId,place:i+1,points:AWARDS[s.race][i]})),scores:s.players.map(p=>p.score)});
    s.phase=s.race===3?'gameEnd':'raceEnd';emit(s,'raceEnd',s.phase==='gameEnd'?'四场比赛结束！查看最终积分。':'本场比赛结束。');
  }
}
function copyChecks(s:GameState){
  for(const r of priority(s).filter(r=>r.id==='copycat'||r.mimic||r.power==='copycat')){
    r.mimic=true;const max=Math.max(...live(s).map(r=>r.position));const leaders=live(s).filter(x=>x.position===max);
    // A copycat leading alone copies its own printed text: no additional ability.
    if(leaders.length===1&&leaders[0].id===r.id){if(r.power!=='copycat'){r.power='copycat';delete r.prediction;}continue;}
    const leaderSignature=leaders.map(x=>x.id).sort().join(',');
    const candidates=leaders.filter(x=>x.id!==r.id);
    if(!candidates.length)continue;
    const previous=r.copyTarget && candidates.find(x=>x.id===r.copyTarget);
    if(previous && r.power===previous.id&&r.copyLeaders===leaderSignature)continue;
    if(candidates.length===1){if(r.power!==candidates[0].id)delete r.prediction;r.copyTarget=candidates[0].id;r.copyLeaders=leaderSignature;r.power=candidates[0].id;emit(s,'copy',`${name(r.id)}现在复制${name(r.power)}`);continue;}
    prepend(s,{kind:'copyCheck'});ask(s,r.id,'chooseCopy','并列领先：选择模仿对象',optionsFor(candidates.map(x=>x.id)),{flags:leaders.map(x=>x.id).sort()});return;
  }
}
function trip(s:GameState,id:string){const r=get(s,id);if(!active(r)||r.tripped)return;r.tripped=true;emit(s,'trip',`${name(id)}绊倒，下次主要移动改为起身`,{racerId:id});}
function movableDestination(s:GameState,m:MoveSpec,all:MoveSpec[]):{to:number;jumps:number;blockedBy?:string[]}{
  const r=get(s,m.id), end=TRACKS[s.track].length+1;let pos=r.position,jumps=0;
  if(m.teleport)return {to:m.destination??pos,jumps};
  const direction=Math.sign(m.amount);let steps=Math.abs(m.amount);
  const vacating=new Set(all.filter(x=>!x.follow&&x.amount!==0).map(x=>x.id));
  while(steps-->0){pos+=direction;if(pos<=0){pos=0;break;}if(has(r,'leaptoad'))while(pos>0&&pos<end&&live(s).some(x=>x.id!==r.id&&x.position===pos&&!vacating.has(x.id))){pos+=direction;jumps++;}if(pos>=end) {pos+=steps*direction;break;}}
  if(live(s).some(x=>x.id!==r.id&&has(x,'stickler'))&&pos>end&&!m.ignoreExact)return {to:r.position,jumps:0,blockedBy:priority(s).filter(x=>x.id!==r.id&&has(x,'stickler')).map(x=>x.id)};
  return {to:Math.max(0,Math.min(end,pos)),jumps};
}
function beginMove(s:GameState,t:Task){
  const moves=(t.moves??[]).filter(m=>active(get(s,m.id)));if(!moves.length)return;
  const asked=new Set(t.flags??[]);
  for(const fish of priority(s).filter(r=>has(r,'suckerfish')&&!moves.some(m=>m.id===r.id)&&!asked.has(r.id))){
    const sources=moves.filter(m=>!m.teleport&&m.amount!==0&&get(s,m.id).position===fish.position&&movableDestination(s,m,moves).to!==fish.position);
    if(sources.length){ask(s,fish.id,'chooseFollow','是否跟随同格运动员？',[...optionsFor(sources.map(m=>m.id)),skip],{...t,kind:'chooseFollow',actor:fish.id,moves,flags:[...asked,fish.id]});return;}
  }
  prepend(s,{...t,kind:'commitMove',moves});
}
function commitMove(s:GameState,t:Task){
  const moves=t.moves??[],before=Object.fromEntries(live(s).map(r=>[r.id,r.position]));
  const destinations:Record<string,number>={};let jumpTasks:Task[]=[];const blockedTasks:Task[]=[];
  for(const m of moves.filter(m=>!m.follow)){const result=movableDestination(s,m,moves);destinations[m.id]=result.to;for(const actor of result.blockedBy??[]){emit(s,'ability',`${name(actor)}取消${name(m.id)}超过终点的移动`,{racerId:actor});blockedTasks.push({kind:'notify',actor});}for(let i=0;i<result.jumps;i++)jumpTasks.push({kind:'notify',actor:m.id});}
  for(const m of moves.filter(m=>m.follow)){destinations[m.id]=destinations[m.follow!]??get(s,m.id).position;if(live(s).some(r=>r.id!==m.id&&has(r,'stickler'))&&!moves.find(x=>x.id===m.follow)?.ignoreExact){/* lead has already met exact movement rule */}}
  const moved=moves.filter(m=>destinations[m.id]!==before[m.id]).map(m=>m.id);
  if(!moved.length){prepend(s,...blockedTasks);return;}
  for(const id of moved){const r=get(s,id);r.position=destinations[id];emit(s,moves.find(m=>m.id===id)?.teleport?'teleport':'move',`${name(id)}：${before[id]} → ${r.position}`,{racerId:id,from:before[id],to:r.position});}
  const after=Object.fromEntries(live(s).map(r=>[r.id,r.position]));
  const trigger:Trigger={kind:'movement',actor:moved[0],before,after,moved,teleported:moves.filter(m=>m.teleport).map(m=>m.id)};
  const tasks:Task[]=[];
  // Leader and follower are ordered explicitly at the finish, not by seat.
  for(const id of moved)if(get(s,id).position>TRACKS[s.track].length)tasks.push({kind:'finish',actor:id});
  const ordered=priority(s).filter(r=>moved.includes(r.id));
  // A follower resolves destination effects after its leader regardless of seat.
  for(const m of moves.filter(m=>m.follow)){const fi=ordered.findIndex(r=>r.id===m.id);if(fi>=0){const [fish]=ordered.splice(fi,1);const li=ordered.findIndex(r=>r.id===m.follow);ordered.splice(li+1,0,fish);}}
  for(const r of ordered)tasks.push({kind:'space',actor:r.id,value:after[r.id]});
  tasks.push({kind:'copyCheck'});
  for(const r of priority(s))tasks.push({kind:'reaction',actor:r.id,trigger});
  tasks.push(...jumpTasks,...blockedTasks);
  for(const m of moves.filter(m=>m.follow&&moved.includes(m.id)))tasks.push({kind:'notify',actor:m.id});
  prepend(s,...tasks);
}
function movementReaction(s:GameState,r:Racer,e:Trigger){
  const before=e.before!,after=e.after!, moved=e.moved!, teleported=e.teleported??[];
  const stops=moved.filter(id=>after[id]<=TRACKS[s.track].length);
  const others=(id:string)=>Object.keys(before).filter(x=>x!==id&&after[x]===after[id]&&!moved.includes(x));
  const passed=(id:string,target:string)=>!teleported.includes(id)&&(before[id]-before[target])*(after[id]-after[target])<0;
  switch(r.power){
    case 'banana': {const ids=moved.filter(id=>id!==r.id&&passed(id,r.id));if(ids.length)ability(s,r.id,ids.map(actor=>({kind:'trip',actor})));break;}
    case 'centaur': if(moved.includes(r.id)&&!teleported.includes(r.id)){
      const victims=Object.keys(before).filter(id=>id!==r.id&&passed(r.id,id)&&active(get(s,id))).sort((a,b)=>Math.abs(before[a]-before[r.id])-Math.abs(before[b]-before[r.id]));
      if(victims.length){const positions=[...new Set(victims.map(id=>before[id]))];ability(s,r.id,positions.map(pos=>({kind:'move',moves:victims.filter(id=>before[id]===pos).map(id=>({id,amount:-2}))})));}break;}
      break;
    case 'baba_yaga': {const ids=stops.includes(r.id)?others(r.id):stops.filter(id=>id!==r.id&&after[id]===before[r.id]);if(ids.length)ability(s,r.id,ids.filter(id=>id!==r.id).map(actor=>({kind:'trip',actor})));break;}
    case 'mouth': if(stops.includes(r.id)){const ids=others(r.id);if(ids.length===1&&active(get(s,ids[0]))){get(s,ids[0]).eliminated=true;emit(s,'eliminate',`${name(r.id)}淘汰了${name(ids[0])}`,{racerId:ids[0]});ability(s,r.id,[]);checkRaceEnd(s);}}break;
    case 'romantic': {const meetings=stops.filter(id=>others(id).length===1);if(meetings.length)prepend(s,...meetings.map(()=>({kind:'bonusMove',actor:r.id,amount:2})));break;}
    case 'huge_baby': if(r.position!==0){const ids=live(s).filter(x=>x.id!==r.id&&x.position===r.position).map(x=>x.id);if(ids.length)ability(s,r.id,[{kind:'move',moves:ids.map(id=>({id,amount:0,teleport:true,destination:r.position-1}))},...ids.filter(id=>has(get(s,id),'banana')).map(actor=>({kind:'babyBanana',actor,target:r.id}))]);}break;
    case 'duelist': if(stops.some(id=>id===r.id||after[id]===r.position))prepend(s,{kind:'duelWindow',actor:r.id});break;
  }
}
function startPower(s:GameState,r:Racer){
  const p=r.power, others=live(s).filter(x=>x.id!==r.id), min=Math.min(...live(s).map(x=>x.position));
  if(p==='mastermind'&&!r.firstTurnTaken){ask(s,r.id,'choosePrediction','预测本场冠军',optionsFor(live(s).map(x=>x.id)));return;}
  r.firstTurnTaken=true;
  if(p==='blimp')s.turn!.modifiers+=r.position<TRACKS[s.track].secondCorner?3:-1;
  if(p==='hare'&&others.every(x=>x.position<r.position))s.turn!.skip=true;
  if(p==='lovable_loser'&&r.position===min&&others.every(x=>x.position>r.position)){points(s,r.id,1);ability(s,r.id,[]);}
  if(p==='party_animal')ability(s,r.id,[{kind:'move',moves:others.filter(x=>x.position!==r.position).map(x=>({id:x.id,amount:Math.sign(r.position-x.position)}))}]);
  if(p==='cheerleader')ask(s,r.id,'chooseStart','帮助最后的运动员？',[yes,skip],{power:p});
  if(p==='hypnotist'&&others.length)ask(s,r.id,'chooseStart','传送哪位运动员到身边？',[...optionsFor(others.map(x=>x.id)),skip],{power:p});
  if(p==='third_wheel'){const positions=[...new Set(live(s).map(x=>x.position))].filter(pos=>live(s).filter(x=>x.position===pos).length===2&&pos!==r.position);if(positions.length)ask(s,r.id,'chooseStart','传送到哪一个双人格？',[...positions.map(pos=>({id:String(pos),label:`第 ${pos} 格`})),skip],{power:p});}
}
function runTask(s:GameState,t:Task,options:EngineOptions){
  const r=t.actor?get(s,t.actor):undefined;
  if(t.actor && !r)throw new Error(`未知运动员 ${t.actor}`);
  if(r&&!active(r)&&!['finish','notify','endAbility','endTurn','advance','endReaction'].includes(t.kind))return;
  switch(t.kind){
    case 'preRace':
      if(r!.power==='egg'){
        const choices=s.deck.splice(0,3);if(!choices.length){emit(s,'rule','蛋蛋的未用牌堆为空，没有可复制的能力。');r!.power=null;break;}
        ask(s,r!.id,'chooseEgg','蛋蛋：选择孵化的能力',optionsFor(choices),{flags:[...(t.flags??[]),'egg']});
      }else if(r!.power==='twin'){
        const winners=[...new Set(s.results.flatMap(result=>result.standings.filter(x=>x.place===1).map(x=>x.racerId)))].filter(id=>!(t.flags??[]).includes(id));
        if(winners.length)ask(s,r!.id,'chooseTwin','双胞胎：复制之前的冠军',[...optionsFor(winners),skip],{flags:[...(t.flags??[]),'twin']});
      }else if(r!.power==='sisyphus'&&!r!.eggBonus){r!.eggBonus=true;points(s,r!.id,4);ability(s,r!.id,[]);}
      break;
    case 'copyCheck': copyChecks(s);break;
    case 'ready': if(s.turn)s.turn.stage='ready';break;
    case 'startTurn':
      if(!active(r!)){prepend(s,{kind:'advance',actor:r!.id});break;}
      s.turn!.stage='resolving';s.turn!.startPosition=r!.position;
      emit(s,'turn',`${s.players[r!.playerId].name} · ${name(r!.id)}的回合`);
      prepend(s,{kind:'copyCheck'},{kind:'startPower',actor:r!.id},{kind:'duels'},{kind:'main',actor:r!.id},{kind:'endTurn',actor:r!.id});break;
    case 'startPower':startPower(s,r!);break;
    case 'main':
      if(s.turn!.skip){emit(s,'skip',`${name(r!.id)}独自领先，跳过主要移动`);ability(s,r!.id,[]);break;}
      if(r!.tripped){r!.tripped=false;emit(s,'stand',`${name(r!.id)}起身，跳过主要移动`,{racerId:r!.id});break;}
      if(r!.power==='legs'||r!.power==='flip_flop')ask(s,r!.id,'chooseMain','选择主要移动方式',r!.power==='legs'?[{id:'yes',label:'固定移动 5 格'},{id:'skip',label:'正常掷骰'}]:[...optionsFor(live(s).filter(x=>x.id!==r!.id).map(x=>x.id)),{id:'skip',label:'正常掷骰'}],{power:r!.power});
      else if(r!.power==='genius')ask(s,r!.id,'chooseGuess','预测骰子点数',[...Array.from({length:6},(_,i)=>({id:String(i+1),label:`预测 ${i+1}`})),{id:'skip',label:'不预测'}]);
      else prepend(s,{kind:'rollDie',actor:r!.id});break;
    case 'rollDie':s.turn!.rolled=die(s,name(r!.id),options);prepend(s,{kind:'reroll',actor:r!.id});break;
    case 'reroll': {
      const opts:Decision['options']=[];
      if(r!.power==='magician'&&s.turn!.rollCount<2)opts.push({id:'magic',label:`魔术重掷（剩 ${2-s.turn!.rollCount} 次）`});
      for(const merchant of priority(s).filter(x=>has(x,'dicemonger')&&!s.turn!.usedMerchants.includes(x.id)))opts.push({id:merchant.id,label:`使用${name(merchant.id)}的重掷`});
      if(opts.length)ask(s,r!.id,'chooseReroll',`当前点数 ${s.turn!.rolled}，是否重掷？`,[...opts,{id:'keep',label:'保留结果'}]);else prepend(s,{kind:'resolveRoll',actor:r!.id});break;}
    case 'resolveRoll': {
      const value=s.turn!.rolled!;if(s.turn!.guess===value&&has(r!,'genius')){s.turn!.extra=true;ability(s,r!.id,[],'预测命中');}
      const reactions=priority(s).map(x=>({kind:'rollReaction',actor:x.id,target:r!.id,value}));
      prepend(s,...reactions,{kind:'mainPower',actor:r!.id});break;}
    case 'rollReaction': {
      const value=t.value!,target=t.target!;
      if(has(r!,'skipper')&&value===1){s.turn!.nextOverride.push(r!.id);ability(s,r!.id,[]);}
      if(r!.id!==target&&has(r!,'lackey')&&value===6)ability(s,r!.id,[{kind:'move',moves:[{id:r!.id,amount:2}]}]);
      if(r!.id!==target&&has(r!,'inchworm')&&value===1){s.turn!.skip=true;ability(s,r!.id,[{kind:'move',moves:[{id:r!.id,amount:1}]}]);}
      break;}
    case 'mainPower': {
      if(s.turn!.skip)break;
      if(has(r!,'sisyphus')&&s.turn!.rolled===6){points(s,r!.id,-1);ability(s,r!.id,[{kind:'move',moves:[{id:r!.id,amount:0,teleport:true,destination:0}]}]);break;}
      if((has(r!,'alchemist')&&s.turn!.rolled!<=2)||has(r!,'rocket_scientist'))ask(s,r!.id,'choosePower',has(r!,'alchemist')?'把移动距离改为 4 格？':'翻倍移动，随后绊倒？',[yes,skip],{power:r!.power!});
      else prepend(s,{kind:'modifiers',actor:r!.id});break;}
    case 'modifiers': {
      if(s.turn!.skip)break;
      const turn=s.turn!;if(turn.base===undefined)turn.base=turn.rolled??0;
      const tasks:Task[]=[];
      for(const x of priority(s)){
        let amount=0;
        if(has(x,'coach')&&x.position===r!.position)amount=1;
        if(has(x,'gunk')&&x.id!==r!.id)amount=-1;
        if(x.id===r!.id){if(has(x,'hare'))amount=2;if(has(x,'party_animal'))amount=live(s).filter(o=>o.id!==r!.id&&o.position===r!.position).length;if(has(x,'blimp'))tasks.push({kind:'notify',actor:x.id});}
        if(amount!==0){turn.modifiers+=amount;emit(s,'modifier',`${name(x.id)}：${name(r!.id)}主要移动 ${amount>0?'+':''}${amount}`);tasks.push({kind:'notify',actor:x.id});}
      }
      // Modifier activations finish before the actual main movement, with its computed distance fixed.
      prepend(s,...tasks,{kind:'performMain',actor:r!.id});break;}
    case 'performMain': {
      const distance=(s.turn!.base??s.turn!.rolled??0)+s.turn!.modifiers;
      prepend(s,{kind:'move',moves:[{id:r!.id,amount:distance}]},...(s.turn!.double?[{kind:'trip',actor:r!.id}]:[]));break;}
    case 'move':beginMove(s,t);break;
    case 'commitMove':commitMove(s,t);break;
    case 'space': {
      if(r!.position!==t.value)break;
      const space=TRACKS[s.track].spaces[r!.position];if(!space)break;
      if(space.kind==='trip')trip(s,r!.id);
      if(space.kind==='star')points(s,r!.id,space.amount??1);
      if(space.kind==='move')prepend(s,{kind:'move',moves:[{id:r!.id,amount:space.amount??0}]});break;}
    case 'reaction':movementReaction(s,r!,t.trigger!);break;
    case 'trip':trip(s,r!.id);break;
    case 'babyBanana':ability(s,r!.id,[{kind:'trip',actor:t.target!}]);break;
    case 'bonusMove':ability(s,r!.id,[{kind:'move',moves:[{id:r!.id,amount:t.amount??1}]}]);break;
    case 'notify': {
      // Scoocher reacts after the complete source ability and resolves depth-first.
      const watchers=priority(s).filter(x=>x.id!==t.actor&&has(x,'scoocher'));
      prepend(s,...watchers.map(x=>({kind:'bonusMove',actor:x.id,amount:1})));break;}
    case 'finish':finish(s,r!.id);break;
    case 'duels':prepend(s,...priority(s).filter(x=>has(x,'duelist')).map(x=>({kind:'duelWindow',actor:x.id})));break;
    case 'duelWindow': {
      if(!has(r!,'duelist'))break;const targets=live(s).filter(x=>x.id!==r!.id&&x.position===r!.position);
      if(targets.length)ask(s,r!.id,'chooseDuel','是否发起同格决斗？',[...optionsFor(targets.map(x=>x.id)),skip]);break;}
    case 'endTurn': {
      const ids=priority(s).filter(x=>has(x,'heckler')&&Math.abs(get(s,s.turn!.actor).position-s.turn!.startPosition)<=1).map(x=>x.id);
      prepend(s,...ids.map(actor=>({kind:'bonusMove',actor,amount:2})),{kind:'duels'},{kind:'advance',actor:s.turn!.actor});break;}
    case 'advance': {
      checkRaceEnd(s);if(s.phase!=='race')break;
      const current=s.turn!,overrides=current.nextOverride.filter(id=>active(get(s,id)));
      let next=overrides[0];
      if(!next&&current.extra&&active(get(s,current.actor)))next=current.actor;
      if(!next){let index=s.turnOrder.indexOf(current.actor);for(let i=1;i<=s.turnOrder.length;i++){const id=s.turnOrder[(index+i)%s.turnOrder.length];if(active(get(s,id))){next=id;break;}}}
      newTurn(s,next);if(overrides.length>1)s.turn!.nextOverride=overrides.slice(1);
      break;}
    default:throw new Error(`未知结算步骤：${t.kind}`);
  }
}
function choose(s:GameState,option:string,options:EngineOptions){
  const d=s.pending!;if(!d.options.some(x=>x.id===option))throw new Error('这个选项当前不可用。');
  s.pending=null;const t=d.task,r=get(s,d.actor);
  emit(s,'choice',`${s.players[d.playerId].name} · ${d.title}：${d.options.find(x=>x.id===option)!.label}`,{racerId:r.id});
  switch(t.kind){
    case 'chooseCopy':if(r.power!==option)delete r.prediction;r.copyTarget=option;r.copyLeaders=(t.flags??[]).join(',');r.power=option;break;
    case 'chooseEgg':case 'chooseTwin':
      if(option!=='skip'){
        if((t.flags??[]).includes(option)){r.power=null;emit(s,'rule','复制链回到相同赛前能力，不重复执行。');break;}
        r.power=option;if(option==='copycat')r.mimic=true;ability(s,r.id,[{kind:'preRace',actor:r.id,flags:[...(t.flags??[]),option]}]);
      }break;
    case 'choosePrediction':r.prediction=option;r.firstTurnTaken=true;ability(s,r.id,[]);break;
    case 'chooseStart':
      if(option==='skip')break;
      if(t.power==='cheerleader'){const min=Math.min(...live(s).map(x=>x.position));ability(s,r.id,[{kind:'move',moves:live(s).filter(x=>x.position===min).map(x=>({id:x.id,amount:2}))},{kind:'move',moves:[{id:r.id,amount:1}]}]);}
      if(t.power==='hypnotist')ability(s,r.id,[{kind:'move',moves:[{id:option,amount:0,teleport:true,destination:r.position}]}]);
      if(t.power==='third_wheel')ability(s,r.id,[{kind:'move',moves:[{id:r.id,amount:0,teleport:true,destination:Number(option)}]}]);break;
    case 'chooseMain':
      if(option==='skip')prepend(s,{kind:'rollDie',actor:r.id});
      else if(t.power==='legs'){s.turn!.base=5;ability(s,r.id,[{kind:'modifiers',actor:r.id}]);}
      else {const other=get(s,option);ability(s,r.id,[{kind:'move',moves:[{id:r.id,amount:0,teleport:true,destination:other.position},{id:other.id,amount:0,teleport:true,destination:r.position}]}]);}break;
    case 'chooseGuess':if(option!=='skip')s.turn!.guess=Number(option);prepend(s,{kind:'rollDie',actor:r.id});break;
    case 'chooseReroll':
      if(option==='keep')prepend(s,{kind:'resolveRoll',actor:r.id});
      else if(option==='magic'){s.turn!.rollCount++;ability(s,r.id,[]);s.queue.splice(1,0,{kind:'rollDie',actor:r.id});}
      else {s.turn!.usedMerchants.push(option);ability(s,option,option===r.id?[]:[{kind:'move',moves:[{id:option,amount:1}]}]);const index=s.queue.findIndex(x=>x.kind==='notify'&&x.actor===option);s.queue.splice(index+1,0,{kind:'rollDie',actor:r.id});}break;
    case 'choosePower':
      if(option==='yes'){s.turn!.base=t.power==='alchemist'?4:s.turn!.rolled!*2;if(t.power==='rocket_scientist')s.turn!.double=true;ability(s,r.id,[{kind:'modifiers',actor:r.id}]);}
      else prepend(s,{kind:'modifiers',actor:r.id});break;
    case 'chooseFollow': {
      const moves=[...(t.moves??[])];if(option!=='skip'){const source=moves.find(x=>x.id===option)!;moves.push({id:r.id,amount:source.amount,follow:option});emit(s,'ability',`${name(r.id)}跟随${name(option)}`);}
      prepend(s,{kind:'move',moves,flags:t.flags});break;}
    case 'chooseDuel':if(option!=='skip'){
      if(!active(get(s,option))||get(s,option).position!==r.position)throw new Error('决斗对象已不在同一格。');
      const a=die(s,name(r.id),options),b=die(s,name(option),options);ability(s,r.id,[{kind:'move',moves:[{id:a>=b?r.id:option,amount:2}]}]);}break;
    default:throw new Error('未知选择类型。');
  }
}
function drain(s:GameState,options:EngineOptions){
  let count=0;
  while(s.queue.length&&!s.pending&&s.phase==='race'){
    if(++count>500){s.paused=true;emit(s,'pause','连锁效果较长，已保存进度。点击继续结算。');break;}
    const t=s.queue.shift()!;
    // Only identical semantic state + current effect repeats are suppressed. RNG and score are part of state.
    if(['reaction','bonusMove','move'].includes(t.kind)){
      const signature=JSON.stringify([t,s.racers,s.players.map(p=>p.score),s.rng,s.turn]);
      if(s.chainSeen.includes(signature)){emit(s,'loop','相同状态与效果重复，本次循环按规则停止。');continue;}
      s.chainSeen.push(signature);
      if(s.chainSeen.length>2000)s.chainSeen.shift();
    }
    runTask(s,t,options);
  }
}
export function applyAction(previous:GameState,action:GameAction,options:EngineOptions={}):GameState{
  if(previous.processedActions.includes(action.id))return previous;
  if(action.revision!==previous.revision)throw new Error('操作已经过期，请按当前界面重新选择。');
  const s=structuredClone(previous);s.revision++;s.processedActions.push(action.id);if(s.processedActions.length>1000)s.processedActions.shift();
  if(action.type==='draft'){
    if(s.phase!=='draft'||!s.market.includes(action.racerId))throw new Error('当前不能招募这个角色。');
    const p=s.players[s.draftOrder[s.draftIndex]];p.team.push(action.racerId);s.market=s.market.filter(id=>id!==action.racerId);s.draftIndex++;
    emit(s,'draft',`${p.name}招募了${name(action.racerId)}`);
    if(s.draftIndex===s.draftOrder.length){s.draftBatch++;const total=s.duo&&s.players.length===3?4:2;if(s.draftBatch<total)makeDraftBatch(s);else{s.phase='selection';s.firstPlayer=rolloff(s,s.players.map(p=>p.id),'第一场先手',options);s.selectionPlayer=s.firstPlayer;}}
  }else if(action.type==='select'){
    const ids=action.racerIds,p=s.players[action.playerId];
    if(s.phase!=='selection'||!p||(options.selectionMode!=='simultaneous'&&s.selectionPlayer!==action.playerId)||Object.hasOwn(s.selections,action.playerId)||ids.length!==(s.duo?2:1)||new Set(ids).size!==ids.length||ids.some(id=>!p.team.includes(id)||p.used.includes(id)))throw new Error('请选择尚未出场的角色，双角色按行动顺序选择；已锁定后不能修改。');
    s.selections[p.id]=[...ids];p.used.push(...ids);emit(s,'selection',`${p.name}已锁定出场选择`);
    if(Object.keys(s.selections).length===s.players.length)s.phase='reveal';else if(options.selectionMode!=='simultaneous')s.selectionPlayer=(s.selectionPlayer+1)%s.players.length;
  }else if(action.type==='reveal'){
    if(s.phase!=='reveal')throw new Error('还没有全部选好角色。');setupRace(s);drain(s,options);
  }else if(action.type==='roll'){
    if(s.phase!=='race'||s.pending||s.paused||s.queue.length||s.turn?.stage!=='ready')throw new Error('请先完成当前选择或结算。');
    s.chainSeen=[];prepend(s,{kind:'startTurn',actor:s.turn.actor});drain(s,options);
  }else if(action.type==='choose'){
    if(s.phase!=='race'||!s.pending||s.pending.id!==action.decisionId)throw new Error('这个选择已结束。');choose(s,action.optionId,options);drain(s,options);
  }else if(action.type==='continue'){
    if(!s.paused||s.pending)throw new Error('没有等待继续的结算。');s.paused=false;drain(s,options);
  }else if(action.type==='nextRace'){
    if(s.phase!=='raceEnd')throw new Error('本场尚未结束。');
    let contenders:number[];
    if(s.duo){const deltas=s.players.map(p=>p.score-s.raceStartScores[p.id]);const min=Math.min(...deltas);contenders=s.players.filter(p=>deltas[p.id]===min).map(p=>p.id);}
    else {const eliminated=s.events.find(e=>e.race===s.race&&e.type==='eliminate');const firstEliminated=eliminated?.racerId;const unfinished=s.racers.filter(r=>r.finished===null);const min=Math.min(...unfinished.map(r=>r.position));contenders=firstEliminated?[get(s,firstEliminated).playerId]:unfinished.filter(r=>r.position===min).map(r=>r.playerId);if(!contenders.length)contenders=[get(s,s.finishOrder.at(-1)!).playerId];}
    s.firstPlayer=contenders.length===1?contenders[0]:rolloff(s,contenders,'下一场先手',options);s.race++;s.track=s.race%2?'wild':'mild';s.phase='selection';s.selections={};s.selectionPlayer=s.firstPlayer;s.racers=[];s.turnOrder=[];s.turn=null;s.finishOrder=[];s.chainSeen=[];
  }else throw new Error('未知操作。');
  return s;
}
export function getPlayerView(s:GameState,viewerId:number|null):PlayerView{
  const {deck,rng:_rng,selections,queue:_q,chainSeen:_c,processedActions:_p,...rest}=structuredClone(s);
  const hidden=s.phase==='selection';
  if(hidden)rest.players=rest.players.map(p=>({...p,used:p.used.filter(id=>!(selections[p.id]??[]).includes(id))}));
  return {...rest,deckCount:deck.length,selections:hidden?(viewerId!==null&&selections[viewerId]?{[viewerId]:selections[viewerId]}:{}):selections};
}
