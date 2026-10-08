import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { isIP } from 'node:net';
import { Server, type Socket } from 'socket.io';
import { ZodError } from 'zod';
import { RoomError, RoomService } from './service';
import type { CommandAck } from '../src/session/protocol';
export interface ServerOptions { database:string; origin:string; staticDir:string; now?:()=>number; tickMs?:number; trustedProxyIps?:string[] }
function cookie(req:IncomingMessage):string|undefined {
  return req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('ma_session='))?.slice(11);
}
function error(e:unknown):{error:string;code:string;status:number}{
  if(e instanceof RoomError)return{error:e.message,code:e.code,status:e.status};
  if(e instanceof ZodError)return{error:'请求格式不正确。',code:'INVALID',status:400};
  return{error:'服务端处理或保存失败，请稍后重试。',code:'SERVER_ERROR',status:500};
}
function json(res:ServerResponse,status:number,body:unknown){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));}
async function body(req:IncomingMessage){let content='';for await(const chunk of req){content+=chunk.toString();if(Buffer.byteLength(content)>8192)throw new RoomError('请求过大。','SIZE',413);}try{return JSON.parse(content||'{}');}catch{throw new RoomError('请求不是有效 JSON。');}}
class Limits {
  private buckets=new Map<string,{count:number;until:number}>();
  check(key:string,max:number,windowMs:number){const now=Date.now();if(this.buckets.size>10000)for(const [k,b]of this.buckets)if(b.until<now)this.buckets.delete(k);let b=this.buckets.get(key);if(!b||b.until<=now){b={count:0,until:now+windowMs};this.buckets.set(key,b);}if(++b.count>max)throw new RoomError('操作过于频繁，请稍后重试。','RATE_LIMIT',429);}
}
export function createOnlineServer(options:ServerOptions){
  const service=new RoomService(options.database,options.now);const limits=new Limits();
  const publicOrigin=new URL(options.origin).origin;const secure=publicOrigin.startsWith('https:');
  const root=resolve(options.staticDir);const connections=new Map<string,{socket:Socket;sid:string;code:string;seatId:string}>();
  function clientIp(req:IncomingMessage){
    const remote=(req.socket.remoteAddress??'unknown').replace(/^::ffff:/,'');
    if(options.trustedProxyIps?.includes(remote)){
      const forwarded=req.headers['x-forwarded-for'];const last=(Array.isArray(forwarded)?forwarded[0]:forwarded)?.split(',').at(-1)?.trim();
      if(last&&isIP(last))return last;
    }
    return remote;
  }
  function revoke(id:string,reason:string){const c=connections.get(id);if(c){c.socket.emit('revoked',{reason});c.socket.disconnect(true);}}
  function broadcast(code:string){for(const [id,c] of connections)if(c.code===code){try{service.isCurrent(c.sid,code,id);c.socket.emit('room',service.view(c.sid,code));}catch(e){revoke(id,error(e).error);}}}
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    try{
      const url=new URL(req.url??'/',options.origin),path=url.pathname;
      if(path==='/healthz'){json(res,200,{status:'ok',protocolVersion:1,...service.stats()});return;}
      if(path.startsWith('/api/')){
        if(req.headers.origin && req.headers.origin!==publicOrigin)throw new RoomError('不允许跨站请求。','ORIGIN',403);
        if(req.method==='POST'&&req.headers.origin!==publicOrigin)throw new RoomError('请从游戏页面提交请求。','ORIGIN',403);
        limits.check(`http:${clientIp(req)}`,240,60_000);
        if(req.method==='POST'&&!req.headers['content-type']?.startsWith('application/json'))throw new RoomError('请发送 JSON 请求。','INVALID',415);
        const s=service.session(cookie(req));
        res.setHeader('Set-Cookie',`ma_session=${s.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure?'; Secure':''}`);
        if(req.method==='GET'&&path==='/api/session'){json(res,200,{rooms:service.list(s.token)});return;}
        if(req.method==='POST'&&path==='/api/rooms'){
          limits.check(`create:${s.token}`,10,60_000);const access=service.create(s.token,await body(req));json(res,201,{code:access.code,recoveryCode:access.recoveryCode});return;
        }
        const match=path.match(/^\/api\/rooms\/([A-Z2-9]{8})\/(join|recover|recovery)$/);
        if(req.method==='POST'&&match){
          const [,code,op]=match;
          limits.check(`sensitive:${s.token}`,20,60_000);
          const input=await body(req);let access;
          if(op==='join')access=service.join(s.token,code,input);
          else if(op==='recover'){
            limits.check(`recover:${clientIp(req)}`,30,60_000);
            access=service.recover(s.token,code,input);
            for(const [id,c]of connections)if(c.code===code&&c.seatId===access.seatId)revoke(id,'座位已在另一台设备恢复，此页面已停止操作。');
          }else access=service.regenerate(s.token,code);
          json(res,200,{code:access.code,recoveryCode:access.recoveryCode});broadcast(code);return;
        }
        throw new RoomError('接口不存在。','NOT_FOUND',404);
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw new RoomError('不支持该请求方式。','METHOD',405);
      let requested=resolve(root,'.'+decodeURIComponent(path));
      if(requested!==root&&!requested.startsWith(root+sep))throw new RoomError('路径无效。','INVALID',403);
      try{if(!(await stat(requested)).isFile())requested=resolve(root,'index.html');}catch{if(extname(path))throw new RoomError('资源不存在。','NOT_FOUND',404);requested=resolve(root,'index.html');}
      const data=await readFile(requested);const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
      res.writeHead(200,{'content-type':types[extname(requested)]??'application/octet-stream','cache-control':path.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache'});res.end(req.method==='HEAD'?undefined:data);
    }catch(e){const p=error(e);if(!res.headersSent)json(res,p.status,{error:p.error,code:p.code});else res.end();}
  });
  const io=new Server(server,{maxHttpBufferSize:8192,pingInterval:10_000,pingTimeout:10_000,serveClient:false,
    allowRequest:(req,done)=>done(null,req.headers.origin===publicOrigin || (!req.headers.origin && req.headers.host===new URL(publicOrigin).host && req.headers['sec-fetch-site']==='same-origin')),cors:{origin:publicOrigin,credentials:true},});
  io.use((socket,next)=>{
    try{
      limits.check(`connect:${clientIp(socket.request)}`,120,60_000);
      const sid=cookie(socket.request);const {roomCode,pageId,claim}=socket.handshake.auth??{};
      if(!sid||typeof roomCode!=='string'||!/^[A-Z2-9]{8}$/.test(roomCode)||typeof pageId!=='string'||pageId.length>100)throw new RoomError('身份或房间信息缺失。','AUTH',401);
      service.view(sid,roomCode);socket.data.sid=sid;socket.data.code=roomCode;socket.data.pageId=pageId;socket.data.claim=claim===true;next();
    }catch(e){next(new Error(error(e).error));}
  });
  io.on('connection',socket=>{
    const sid=socket.data.sid as string,code=socket.data.code as string;
    try{
      const {seatId,old}=service.connect(sid,code,socket.id,socket.data.pageId,socket.data.claim);
      connections.set(socket.id,{socket,sid,code,seatId});
      if(old)revoke(old,'此座位已在另一个页面打开，本页面不再自动连接。');
      broadcast(code);
      socket.on('sync',()=>{try{limits.check(`sync:${socket.id}`,30,10_000);service.isCurrent(sid,code,socket.id);socket.emit('room',service.view(sid,code));}catch(e){socket.emit('notice',{error:error(e).error});}});
      socket.on('command',(input:unknown,callback?: (ack:CommandAck)=>void)=>{
        const reply=typeof callback==='function'?callback:()=>{};
        try{
          limits.check(`command:${socket.id}`,120,10_000);
          if((input as {roomCode?:unknown})?.roomCode!==code)throw new RoomError('不能操作其他房间。','FORBIDDEN',403);
          const ack=service.execute(sid,socket.id,input);reply(ack);broadcast(code);
        }catch(e){const p=error(e);reply({ok:false,error:p.error,code:p.code});try{socket.emit('room',service.view(sid,code));}catch{revoke(socket.id,p.error);}}
      });
      socket.on('disconnect',()=>{connections.delete(socket.id);service.disconnect(code,seatId,socket.id);broadcast(code);});
    }catch(e){socket.emit('revoked',{reason:error(e).error});socket.disconnect(true);}
  });
  const timer=setInterval(()=>{try{for(const code of service.tick())broadcast(code);}catch{console.error('Room maintenance failed; will retry on next interval.');}},options.tickMs??1000);timer.unref();
  return {server,io,service,async close(){clearInterval(timer);await new Promise<void>(resolve=>io.close(()=>resolve()));service.close();}};
}
