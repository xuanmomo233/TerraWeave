import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const SERVER=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../test-server');
const ROOT=path.join(SERVER,'plugins/WorkbenchLive');
const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{return null;}};
export const serverStatus=()=>{const h=read(path.join(ROOT,'heartbeat.json'));return {running:!!h&&Date.now()-h.at_ms<10000,server:SERVER,...(h?{identity:h}:{})};};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function stopServer(){
 const before=serverStatus();if(!before.running)return {...before,stopped:true};
 const result=await serverRequest('stop');
 for(let i=0;i<120;i++){
  let alive=true;try{process.kill(before.identity.pid,0);}catch{alive=false;}
  if(!alive){const record=path.join(ROOT,'process.json');if(read(record)?.pid===before.identity.pid)fs.unlinkSync(record);return {...result,stopped:true};}
  await sleep(250);
 }
 throw Error('Test server acknowledged stop but has not exited yet');
}
export async function startServer(){
 let status=serverStatus();if(status.running)return {...status,reused:true};
 fs.mkdirSync(ROOT,{recursive:true});
 const previous=read(path.join(ROOT,'process.json'));
 let alive=false;if(previous?.pid){try{process.kill(previous.pid,0);alive=true;}catch{}}
 if(!alive){
  const log=fs.openSync(path.join(ROOT,'process.log'),'a');
  const child=spawn('java.exe',['-Dfile.encoding=UTF-8','-Dstdout.encoding=UTF-8','-Dstderr.encoding=UTF-8','-Xms512M','-Xmx2G','-jar','paper-1.20.1-196.jar','--nogui'],{cwd:SERVER,stdio:['ignore',log,log],windowsHide:true,detached:true});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  fs.closeSync(log);child.unref();fs.writeFileSync(path.join(ROOT,'process.json'),JSON.stringify({pid:child.pid,started:new Date().toISOString()}));
 }
 for(let i=0;i<120;i++){await sleep(500);status=serverStatus();if(status.running)return {...status,reused:alive};}
 throw Error('Test server did not become ready; inspect '+path.join(ROOT,'process.log'));
}
export async function serverRequest(action,args={}){
 const status=serverStatus();if(!status.running)throw Error('Start the persistent test server first');
 const id=randomUUID(),requests=path.join(ROOT,'requests'),responses=path.join(ROOT,'responses');
 fs.mkdirSync(requests,{recursive:true});fs.mkdirSync(responses,{recursive:true});
 const target=path.join(requests,id+'.json'),pending=target+'.pending';
 fs.writeFileSync(pending,JSON.stringify({action,world_uuid:status.identity.world_uuid,...args}),{flag:'wx'});fs.renameSync(pending,target);
 const response=path.join(responses,id+'.json');
 for(let i=0;i<600;i++){if(fs.existsSync(response)){const r=read(response);fs.unlinkSync(response);if(!r?.ok)throw Error(r?.error??'Invalid server response');return r.result;}await sleep(100);}
 throw Error('Server operation timed out; query status before repeating a mutation. Request '+id);
}
