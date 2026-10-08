#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const logs=resolve(root,'logs');mkdirSync(logs,{recursive:true});
const pidFile=resolve(logs,'dev.pid'), statusFile=resolve(logs,'dev.status.json'), logFile=resolve(logs,'dev.log');
const command=process.argv[2]??'start';
const oldPid=existsSync(pidFile)?Number(readFileSync(pidFile,'utf8')):null;
function owned(pid){try{return execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).includes(resolve(root,'scripts/server.mjs'));}catch{return false;}}
if(command==='status'){console.log(existsSync(statusFile)?readFileSync(statusFile,'utf8'):'尚未启动');console.log(`进程：${oldPid&&owned(oldPid)?'运行中':'未运行'}`);}
else if(command==='stop'){if(oldPid&&owned(oldPid)){process.kill(-oldPid,'SIGTERM');console.log('已请求停止本项目开发服务。');}else console.log('本项目服务未运行。');}
else if(command==='start'){
 if(oldPid&&owned(oldPid)){console.log('服务已在运行：http://127.0.0.1:5173');process.exit(0);}
 if(!existsSync(resolve(root,'node_modules/vite/bin/vite.js')))throw new Error('请先执行 pnpm install --frozen-lockfile');
 const exitFile=resolve(logs,'dev.exit');if(existsSync(exitFile))unlinkSync(exitFile);
 const fd=openSync(logFile,'w');
 const child=spawn(process.execPath,[resolve(root,'scripts/server.mjs')],{cwd:root,detached:true,stdio:['ignore',fd,fd],env:process.env});
 child.unref();writeFileSync(pidFile,String(child.pid));writeFileSync(statusFile,JSON.stringify({status:'starting',pid:child.pid,url:'http://127.0.0.1:5173',log:logFile,updated_at:new Date().toISOString()},null,2));
 console.log(`服务已启动，PID ${child.pid}\n地址 http://127.0.0.1:5173\n日志 ${logFile}\n状态 ${statusFile}`);
}else throw new Error('用法：node scripts/dev.mjs start|status|stop');
