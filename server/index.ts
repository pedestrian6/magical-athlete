import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createOnlineServer } from './http';
const host=process.env.HOST??'127.0.0.1',port=Number(process.env.PORT??3000);
const data=resolve(process.env.DATA_DIR??'var/online');
const statusFile=resolve(process.env.SERVER_STATUS_FILE??`${data}/status.json`);
mkdirSync(dirname(statusFile),{recursive:true,mode:0o700});
const app=createOnlineServer({database:resolve(data,'rooms.sqlite'),origin:process.env.PUBLIC_ORIGIN??`http://127.0.0.1:${port}`,staticDir:process.env.STATIC_DIR??'dist',trustedProxyIps:(process.env.TRUSTED_PROXY_IPS??'').split(',').filter(Boolean)});
const startedAt=new Date().toISOString();
let lastStats=app.service.stats();
function status(state:string){
try{lastStats=app.service.stats();}catch{ /* service already closed */ }
writeFileSync(statusFile+'.tmp',JSON.stringify({status:state,pid:process.pid,startedAt,updated_at:new Date().toISOString(),...lastStats,memory:process.memoryUsage()},null,2),{mode:0o600});renameSync(statusFile+'.tmp',statusFile);}
app.server.listen(port,host,()=>{status('running');console.log(`Magical Athlete server listening on ${host}:${port}`);});
const timer=setInterval(()=>status('running'),30_000);timer.unref();
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{if(stopping)return;stopping=true;clearInterval(timer);status('stopping');void app.close().then(()=>{status('stopped');process.exit(0);});});
