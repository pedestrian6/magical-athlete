import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { applyAction, createGame } from '../src/game/engine';
import { getPublicGameView } from '../src/game/public';
import { RULES_VERSION } from '../src/game/content';
import { validateGameState } from '../src/session/storage';
import type { GameState } from '../src/game/types';
import type { CommandAck, RoomCommand, RoomStatus, RoomSummary, RoomView } from '../src/session/protocol';

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export class RoomError extends Error {
  constructor(message: string, public code = 'INVALID', public status = 400) { super(message); }
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const recovery = () => randomBytes(16).toString('hex').match(/.{4}/g)!.join('-').toUpperCase();
const recoveryHash = (s: string) => hash(s.toUpperCase().replace(/[\s-]/g, ''));
const nameSchema = z.string().trim().min(1).max(16);
const short = z.string().min(1).max(120);
const noargs = (type: string) => z.object({ type: z.literal(type) }).strict();
const actionSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('draft'),racerId:short}).strict(),
  z.object({type:z.literal('select'),playerId:z.number().int().min(0).max(5),racerIds:z.array(short).min(1).max(2)}).strict(),
  z.object({type:z.literal('choose'),decisionId:short,optionId:short}).strict(),
  noargs('reveal'),noargs('roll'),noargs('nextRace'),noargs('continue'),
]);
const base = {id:z.string().uuid(),protocolVersion:z.literal(1),roomCode:z.string().regex(/^[A-Z2-9]{8}$/)};
export const commandSchema = z.discriminatedUnion('type', [
  z.object({...base,type:z.literal('ready'),ready:z.boolean()}).strict(),
  z.object({...base,type:z.literal('configure'),capacity:z.number().int().min(2).max(6),duo:z.boolean()}).strict(),
  z.object({...base,type:z.literal('kick'),seatId:z.string().uuid()}).strict(),
  ...(['leave','start','close'] as const).map(type=>z.object({...base,type:z.literal(type)}).strict()),
  z.object({...base,type:z.literal('game'),gameId:short,revision:z.number().int().nonnegative(),race:z.number().int().min(0).max(3),action:actionSchema}).strict(),
]);
interface Seat { id:string; name:string; sessionHash:string; recoveryHash:string; ready:boolean; playerId:number|null; joinedAt:number; controllerPageId?:string }
export interface StoredRoom {
  formatVersion:1; rulesVersion:string; randomMode:'crypto-tape-v1'; code:string; revision:number;
  status:RoomStatus; capacity:number; duo:boolean; hostSeatId:string; seats:Seat[];
  game:GameState|null; createdAt:number; lastActivity:number;
}
export interface Draw { max:number; value:number }
interface Presence { connectionId:string; sessionHash:string }
export interface Access { code:string; recoveryCode:string; seatId:string }
export class RoomService {
  readonly db:DatabaseSync;
  private presence = new Map<string,Presence>();
  private offlineSince = new Map<string,number>();
  private bootTime:number;
  constructor(path:string, private now:()=>number = Date.now, private randomDraw:(max:number)=>number = randomInt) {
    if(path!==':memory:') mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path,{timeout:5000}); this.bootTime=this.now();
    const version=Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if(version>1){this.db.close();throw new Error('数据库版本比当前程序新，请使用匹配版本，未修改数据库。');}
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS rooms(code TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(room TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE, seat TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, ack TEXT NOT NULL, draws TEXT NOT NULL, command TEXT NOT NULL, PRIMARY KEY(room,seat,id));
      PRAGMA user_version=1;`);
    for(const row of this.db.prepare('SELECT data FROM rooms').all()) this.validate(JSON.parse(row.data as string));
    this.cleanup();
  }
  private validate(r:StoredRoom) {
    if(r.formatVersion!==1 || r.rulesVersion!==RULES_VERSION || r.randomMode!=='crypto-tape-v1' || !Array.isArray(r.seats) || r.seats.length>6 || !Number.isFinite(r.lastActivity))
      throw new Error('房间存档格式或规则版本不兼容，已停止启动以保护数据。');
    if(r.game) validateGameState(r.game);
    return r;
  }
  private key(code:string,seat:string){return `${code}:${seat}`;}
  session(raw?:string):{token:string;fresh:boolean} {
    if(raw && /^[\w-]{43}$/.test(raw)) {
      const row=this.db.prepare('SELECT expires FROM sessions WHERE hash=?').get(hash(raw));
      if(row && Number(row.expires)>this.now()) {
        this.db.prepare('UPDATE sessions SET expires=? WHERE hash=?').run(this.now()+30*RETENTION_MS/7,hash(raw));
        return {token:raw,fresh:false};
      }
    }
    const next=token();this.db.prepare('INSERT INTO sessions VALUES(?,?)').run(hash(next),this.now()+30*RETENTION_MS/7);
    return {token:next,fresh:true};
  }
  private requireSession(raw:string) {
    const h=hash(raw);const row=this.db.prepare('SELECT expires FROM sessions WHERE hash=?').get(h);
    if(!row || Number(row.expires)<=this.now())throw new RoomError('浏览器身份已过期，请用恢复码找回座位。','AUTH',401);
    return h;
  }
  getRoom(code:string):StoredRoom {
    const row=this.db.prepare('SELECT data FROM rooms WHERE code=?').get(code);
    if(!row)throw new RoomError('房间不存在或已过期。','NOT_FOUND',404);
    const r=JSON.parse(row.data as string) as StoredRoom;
    if(r.lastActivity+RETENTION_MS<=this.now())throw new RoomError('房间已超过 7 天未活动，已到期。','EXPIRED',410);
    return r;
  }
  private seat(r:StoredRoom,sid:string) {
    const sh=this.requireSession(sid);const s=r.seats.find(s=>s.sessionHash===sh);
    if(!s)throw new RoomError('此浏览器没有该房间的座位，请加入或使用恢复码。','AUTH',403);
    return s;
  }
  private save(r:StoredRoom,entry?:{seat:string;cmd:RoomCommand;ack:CommandAck;draws:Draw[]}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO rooms(code,data) VALUES(?,?) ON CONFLICT(code) DO UPDATE SET data=excluded.data').run(r.code,JSON.stringify(r));
      if(entry)this.db.prepare('INSERT INTO commands VALUES(?,?,?,?,?,?,?)').run(r.code,entry.seat,entry.cmd.id,hash(JSON.stringify(entry.cmd)),JSON.stringify(entry.ack),JSON.stringify(entry.draws),JSON.stringify(entry.cmd));
      this.db.exec('COMMIT');
    } catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  private touch(r:StoredRoom){r.lastActivity=this.now();r.revision++;}
  create(sid:string,input:unknown):Access {
    const p=z.object({name:nameSchema,capacity:z.number().int().min(2).max(6),duo:z.boolean()}).strict().parse(input);
    if(p.duo && p.capacity>3)throw new RoomError('双角色只适用于 2 或 3 人。');
    const sh=this.requireSession(sid);
    if(this.list(sid).filter(r=>r.status!=='closed'&&r.status!=='finished').length>=5)throw new RoomError('每个浏览器最多保留 5 个未结束房间。');
    const count=Number(this.db.prepare('SELECT count(*) AS n FROM rooms').get()!.n);
    if(count>=500)throw new RoomError('当前房间数量已达上限，请稍后再试。','CAPACITY',503);
    const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let code='';
    do {code=Array.from({length:8},()=>alphabet[randomInt(alphabet.length)]).join('');} while(this.db.prepare('SELECT code FROM rooms WHERE code=?').get(code));
    const rc=recovery(), seat:Seat={id:randomUUID(),name:p.name,sessionHash:sh,recoveryHash:recoveryHash(rc),ready:false,playerId:null,joinedAt:this.now()};
    this.save({formatVersion:1,rulesVersion:RULES_VERSION,randomMode:'crypto-tape-v1',code,revision:0,status:'lobby',capacity:p.capacity,duo:p.capacity===2||p.duo,hostSeatId:seat.id,seats:[seat],game:null,createdAt:this.now(),lastActivity:this.now()});
    return {code,recoveryCode:rc,seatId:seat.id};
  }
  join(sid:string,code:string,input:unknown):Access {
    const p=z.object({name:nameSchema}).strict().parse(input);const r=this.getRoom(code),sh=this.requireSession(sid);
    if(r.seats.some(s=>s.sessionHash===sh))throw new RoomError('你已经在这个房间，请直接继续。','ALREADY_JOINED');
    if(r.status!=='lobby'||r.seats.length>=r.capacity)throw new RoomError('房间已开始或已满。');
    if(r.seats.some(s=>s.name===p.name))throw new RoomError('房间中已有这个昵称，请换一个。');
    const rc=recovery(),s:Seat={id:randomUUID(),name:p.name,sessionHash:sh,recoveryHash:recoveryHash(rc),ready:false,playerId:null,joinedAt:this.now()};
    r.seats.push(s);r.seats.forEach(s=>s.ready=false);this.touch(r);this.save(r);return {code,recoveryCode:rc,seatId:s.id};
  }
  recover(sid:string,code:string,input:unknown):Access {
    const p=z.object({recoveryCode:z.string().min(16).max(100)}).strict().parse(input);const r=this.getRoom(code),sh=this.requireSession(sid);
    if(r.status==='closed')throw new RoomError('房间已结束。','CLOSED');
    const s=r.seats.find(s=>s.recoveryHash===recoveryHash(p.recoveryCode));
    if(!s)throw new RoomError('恢复码无效或已被使用。','AUTH',403);
    if(r.seats.some(other=>other.id!==s.id&&other.sessionHash===sh))throw new RoomError('当前浏览器已有另一个座位，请使用独立浏览器恢复。');
    const rc=recovery();s.sessionHash=sh;s.recoveryHash=recoveryHash(rc);delete s.controllerPageId;this.touch(r);this.save(r);
    this.presence.delete(this.key(code,s.id));this.offlineSince.set(this.key(code,s.id),this.now());
    return {code,recoveryCode:rc,seatId:s.id};
  }
  regenerate(sid:string,code:string):Access {
    const r=this.getRoom(code),s=this.seat(r,sid);if(r.status==='closed')throw new RoomError('房间已结束。');
    const rc=recovery();s.recoveryHash=recoveryHash(rc);this.touch(r);this.save(r);return{code,recoveryCode:rc,seatId:s.id};
  }
  list(sid:string):RoomSummary[] {
    const sh=this.requireSession(sid);const out:RoomSummary[]=[];
    for(const row of this.db.prepare('SELECT data FROM rooms').all()) {
      const r=JSON.parse(row.data as string) as StoredRoom,s=r.seats.find(s=>s.sessionHash===sh);
      if(s&&r.lastActivity+RETENTION_MS>this.now())out.push({code:r.code,status:r.status,name:s.name,expiresAt:r.lastActivity+RETENTION_MS});
    } return out;
  }
  connect(sid:string,code:string,connectionId:string,pageId=connectionId,claim=true) {
    const r=this.getRoom(code),s=this.seat(r,sid),key=this.key(code,s.id);
    if(s.controllerPageId && s.controllerPageId!==pageId && !claim)throw new RoomError('此座位已由另一个页面接管，请关闭旧页面。','REVOKED',403);
    if(s.controllerPageId!==pageId){s.controllerPageId=pageId;this.save(r);}
    const old=this.presence.get(key)?.connectionId;
    this.presence.set(key,{connectionId,sessionHash:s.sessionHash});this.offlineSince.delete(key);
    return{seatId:s.id,old};
  }
  disconnect(code:string,seatId:string,connectionId:string){
    const key=this.key(code,seatId);
    if(this.presence.get(key)?.connectionId===connectionId){this.presence.delete(key);this.offlineSince.set(key,this.now());}
  }
  isCurrent(sid:string,code:string,connectionId:string) {
    const r=this.getRoom(code),s=this.seat(r,sid),p=this.presence.get(this.key(code,s.id));
    if(!p||p.connectionId!==connectionId||p.sessionHash!==s.sessionHash)throw new RoomError('此座位已在另一个页面或设备打开。','REVOKED',403);
    return s;
  }
  view(sid:string,code:string):RoomView {
    const r=this.getRoom(code),s=this.seat(r,sid);
    return {protocolVersion:1,code:r.code,status:r.status,revision:r.revision,viewerSeatId:s.id,hostSeatId:r.hostSeatId,capacity:r.capacity,duo:r.duo,
      seats:r.seats.map(p=>({id:p.id,name:p.name,playerId:p.playerId,ready:p.ready,online:this.presence.has(this.key(code,p.id))})),
      game:r.game?getPublicGameView(r.game,s.playerId):null,expiresAt:r.lastActivity+RETENTION_MS,serverTime:this.now()};
  }
  execute(sid:string,connectionId:string,input:unknown):CommandAck {
    const cmd=commandSchema.parse(input) as RoomCommand;const r=this.getRoom(cmd.roomCode);const seat=this.isCurrent(sid,r.code,connectionId);
    const duplicate=this.db.prepare('SELECT fingerprint,ack FROM commands WHERE room=? AND seat=? AND id=?').get(r.code,seat.id,cmd.id);
    if(duplicate){if(duplicate.fingerprint!==hash(JSON.stringify(cmd)))throw new RoomError('命令编号已被其他操作使用。','CONFLICT');return JSON.parse(duplicate.ack as string) as CommandAck;}
    if(r.status==='closed')throw new RoomError('房间已结束。','CLOSED');
    const requireHost=()=>{if(seat.id!==r.hostSeatId)throw new RoomError('此操作需要房主。','FORBIDDEN',403);};
    const lobby=()=>{if(r.status!=='lobby')throw new RoomError('只能在准备大厅进行此操作。');};
    const draws:Draw[]=[];const opts={selectionMode:'simultaneous' as const,drawInt:(max:number)=>{const value=this.randomDraw(max);draws.push({max,value});return value;}};
    switch(cmd.type){
      case 'ready':lobby();r.seats.find(s=>s.id===seat.id)!.ready=cmd.ready;break;
      case 'configure':lobby();requireHost();if(cmd.capacity<r.seats.length||cmd.duo&&cmd.capacity>3)throw new RoomError('人数或双角色设置不合适。');r.capacity=cmd.capacity;r.duo=cmd.capacity===2||cmd.duo;r.seats.forEach(s=>s.ready=false);break;
      case 'kick':lobby();requireHost();if(cmd.seatId===seat.id||!r.seats.some(s=>s.id===cmd.seatId))throw new RoomError('请选择其他玩家。');r.seats=r.seats.filter(s=>s.id!==cmd.seatId);r.seats.forEach(s=>s.ready=false);break;
      case 'leave':lobby();r.seats=r.seats.filter(s=>s.id!==seat.id);r.seats.forEach(s=>s.ready=false);if(r.hostSeatId===seat.id)r.hostSeatId=r.seats[0]?.id??'';if(!r.seats.length)r.status='closed';break;
      case 'close':requireHost();r.status='closed';break;
      case 'start':lobby();requireHost();if(r.seats.length!==r.capacity||r.seats.some(s=>!s.ready||!this.presence.has(this.key(r.code,s.id))))throw new RoomError('请等待人数到齐，所有人在线并准备。');r.seats.forEach((s,i)=>s.playerId=i);r.game=createGame({names:r.seats.map(s=>s.name),duo:r.duo},{...opts,gameId:randomUUID()});r.status='playing';break;
      case 'game': {
        const g=r.game,a=cmd.action,pid=seat.playerId;
        if(!g||r.status!=='playing'||pid===null||cmd.gameId!==g.id||cmd.race!==g.race)throw new RoomError('对局或场次已改变，请按最新界面操作。','STALE');
        if(a.type!=='select'&&cmd.revision!==g.revision)throw new RoomError('操作已过期，已同步最新状态。','STALE');
        if(a.type==='select'&&(a.playerId!==pid||g.phase!=='selection'||g.selections[pid]))throw new RoomError('无法代选或重复锁定角色。','FORBIDDEN',403);
        if(a.type==='draft'&&g.draftOrder[g.draftIndex]!==pid)throw new RoomError('还没有轮到你招募。','FORBIDDEN',403);
        if(a.type==='roll'&&g.racers.find(r=>r.id===g.turn?.actor)?.playerId!==pid)throw new RoomError('还没有轮到你行动。','FORBIDDEN',403);
        if(a.type==='choose'&&g.pending?.playerId!==pid)throw new RoomError('这个技能需要另一位玩家决定。','FORBIDDEN',403);
        if(a.type==='reveal'||a.type==='nextRace')requireHost();
        if(a.type==='continue'&&g.racers.find(r=>r.id===g.turn?.actor)?.playerId!==pid)throw new RoomError('请当前回合玩家继续结算。','FORBIDDEN',403);
        r.game=applyAction(g,{...a,id:cmd.id,revision:g.revision},opts);
        if(r.game.phase==='gameEnd')r.status='finished';
        break;
      }
    }
    this.touch(r);const ack:CommandAck={ok:true,revision:r.revision};this.save(r,{seat:seat.id,cmd,ack,draws});
    for(const [key] of this.presence)if(key.startsWith(r.code+':')&&!r.seats.some(s=>key===this.key(r.code,s.id)))this.presence.delete(key);
    return ack;
  }
  tick():string[]{
    const changed:string[]=[];
    for(const row of this.db.prepare('SELECT data FROM rooms').all()){
      const r=JSON.parse(row.data as string) as StoredRoom;if(r.lastActivity+RETENTION_MS<=this.now()){changed.push(r.code);continue;}
      if(r.status==='closed')continue;
      const key=this.key(r.code,r.hostSeatId);
      if(this.presence.has(key))continue;
      const since=this.offlineSince.get(key)??Math.max(this.bootTime,r.seats.find(s=>s.id===r.hostSeatId)?.joinedAt??this.bootTime);
      if(this.now()-since<30_000)continue;
      const candidate=r.seats.find(s=>this.presence.has(this.key(r.code,s.id)));
      if(candidate&&candidate.id!==r.hostSeatId){r.hostSeatId=candidate.id;r.revision++;this.save(r);changed.push(r.code);}
    }
    this.cleanup();return changed;
  }
  cleanup(){
    for(const row of this.db.prepare('SELECT code,data FROM rooms').all()){
      const r=JSON.parse(row.data as string) as StoredRoom;
      if(r.lastActivity+RETENTION_MS<=this.now()){
        this.db.prepare('DELETE FROM rooms WHERE code=?').run(r.code);
        for(const key of this.presence.keys())if(key.startsWith(r.code+':'))this.presence.delete(key);
        for(const key of this.offlineSince.keys())if(key.startsWith(r.code+':'))this.offlineSince.delete(key);
      }
    }
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(this.now());
  }
  audit(code:string){return this.db.prepare('SELECT command,draws,ack FROM commands WHERE room=? ORDER BY rowid').all(code);}
  stats(){return {rooms:Number(this.db.prepare('SELECT count(*) n FROM rooms').get()!.n),connections:this.presence.size};}
  close(){this.db.close();}
}
