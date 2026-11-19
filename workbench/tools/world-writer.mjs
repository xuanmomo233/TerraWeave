import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

const sha=value=>createHash('sha256').update(value).digest('hex');
const idFor=value=>{
 const h=sha(value).slice(0,32);
 return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');
};
const validId=id=>typeof id==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function optional(file){try{return read(file);}catch(error){if(error.code!=='ENOENT')throw error;return null;}}
function durable(file,value){
 const temp=file+'.pending-'+randomUUID(),fd=fs.openSync(temp,'wx');
 try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(temp,file);
}
function coordinate(key){
 const p=key.split(',').map(Number);
 if(p.length!==3||p.join(',')!==key||p.some(n=>!Number.isSafeInteger(n))||
  Math.abs(p[0])>30000000||Math.abs(p[2])>30000000||p[1]<-64||p[1]>319)throw Error('无效的方块坐标 '+key);
 return p;
}
const stateOk=s=>typeof s==='string'&&/^minecraft:[a-z0-9_]+(?:\[[a-z0-9_=-]+(?:,[a-z0-9_=-]+)*\])?$/.test(s)&&s.length<=512;
function packet(value){
 const plain=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
 if(!plain(value)||value.schema!==1||!validId(value.world_uuid)||!validId(value.draft_id)||
  !Number.isSafeInteger(value.draft_revision)||value.draft_revision<1||
  !plain(value.base)||!plain(value.changes)||!plain(value.previously_applied))throw Error('无效的织境工坊方案文件');
 for(const table of [value.base,value.changes,value.previously_applied])for(const [key,state] of Object.entries(table)){
  coordinate(key);
  if(!stateOk(state)||!Object.hasOwn(value.base,key))throw Error('缺少原始方块状态 '+key);
 }
 return value;
}
const keyOf=b=>[b.x,b.y,b.z].join(',');
const changesIn=record=>record.batches.flatMap(b=>b.changes);
function batchEnds(edits){
 const ends=[];
 let start=0,bytes=0;
 for(let i=0;i<edits.length;i++){
  const size=Buffer.byteLength(JSON.stringify(edits[i]))+1;
  if(i-start>=16384||bytes+size>3_900_000){ends.push(i);start=i;bytes=0;}
  bytes+=size;
 }
 if(edits.length)ends.push(edits.length);
 return ends;
}
function summary(record){
 const batches=record.batches;
 return {operation_id:record.id,world_uuid:record.world_uuid,draft_id:record.draft_id,draft_revision:record.draft_revision,
  kind:record.kind,complete:record.complete,batches_committed:batches.length,batches_total:record.batch_ends.length,
  changed:batches.reduce((n,b)=>n+b.changed,0),already:batches.reduce((n,b)=>n+b.already,0),
  conflict_count:batches.reduce((n,b)=>n+b.conflicts.length,0),conflicts:batches.flatMap(b=>b.conflicts.slice(0,128)).slice(0,128),
  undoable:batches.every(b=>b.undoable===true),error:record.error};
}
export function bridgeTransport(directory,{timeout=90_000}={}){
 const root=path.resolve(directory),requests=path.join(root,'requests'),receipts=path.join(root,'receipts');
 return async (id,request)=>{
  const done=path.join(receipts,id+'.json'),existing=optional(done);
  const expected=sha(JSON.stringify(request));
  const check=response=>{
   if(response.request_hash!==expected)throw Error('批次回执与请求内容不一致');
   if(!response.ok)throw Object.assign(Error(response.error??'插件拒绝写入'),{definitive:true});
   return response.result;
  };
  if(existing)return check(existing);
  const heartbeat=optional(path.join(root,'heartbeat.json'));
  if(!heartbeat||Date.now()-heartbeat.at_ms>10_000)throw Error('请先通过独立流程启动目标服和配套插件');
  if(heartbeat.world_uuid!==request.world_uuid)throw Error('写入目标与方案世界 UUID 不一致');
  fs.mkdirSync(requests,{recursive:true});
  const incoming=path.join(requests,id+'.json'),processing=incoming+'.processing';
  if(!fs.existsSync(incoming)&&!fs.existsSync(processing)){
   const stage=incoming+'.pending-'+randomUUID();
   fs.writeFileSync(stage,JSON.stringify(request),{flag:'wx'});
   fs.renameSync(stage,incoming);
  }
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
   const response=optional(done);
   if(response)return check(response);
   await sleep(100);
  }
  throw Error('等待插件回执超时。用同一个操作标识可继续写入。');
 };
}

export function worldWriter({directory,send}){
 fs.mkdirSync(directory,{recursive:true});
 const file=id=>{if(!validId(id))throw Error('无效的操作标识');return path.join(directory,id+'.json');};
 const load=id=>optional(file(id));
 const all=()=>fs.readdirSync(directory).filter(n=>validId(n.slice(0,-5))&&n.endsWith('.json'))
  .map(n=>read(path.join(directory,n))).sort((a,b)=>a.order-b.order);
 let queue=Promise.resolve();
 const serialized=fn=>{
  const task=queue.then(fn);
  queue=task.catch(()=>{});
  return task;
 };
 // The catalog lock covers both planning and sending so two MCP processes
 // cannot assign competing histories to the same world.
 async function locked(fn){
  const lock=path.join(directory,'writer.lock');
  const intent=lock+'.'+process.pid+'-'+randomUUID();
  fs.writeFileSync(intent,JSON.stringify({pid:process.pid}),{flag:'wx'});
  try{
   try{fs.linkSync(intent,lock);}catch(error){
    if(error.code!=='EEXIST')throw error;
    const owner=optional(lock);
    let gone=false;
    if(Number.isSafeInteger(owner?.pid))try{process.kill(owner.pid,0);}catch(e){gone=e.code==='ESRCH';}
    if(!gone)throw Error('另一个写入 MCP 正在提交批次');
    try{fs.unlinkSync(lock);}catch(e){if(e.code!=='ENOENT')throw e;}
    fs.linkSync(intent,lock);
   }
   try{return await fn();}finally{fs.unlinkSync(lock);}
  }finally{fs.unlinkSync(intent);}
 }
 async function resume(record){
  if(record.complete)return summary(record);
  record.error=undefined;
  try{
   for(let index=record.batches.length;index<record.batch_ends.length;index++){
    const request={action:'apply_blocks',world_uuid:record.world_uuid,physics:false,durable:true,blocks:record.edits.slice(record.batch_ends[index-1]??0,record.batch_ends[index])};
    const receipt=await send(idFor(record.id+'/'+index),request);
    if(receipt.world_uuid!==record.world_uuid||!Array.isArray(receipt.changes)||!Array.isArray(receipt.conflicts))throw Error('插件返回了无效的写入回执');
    record.batches.push(receipt);
    durable(file(record.id),record);
   }
   record.complete=true;
  }catch(error){record.error=error.message;record.rejected=error.definitive===true;}
  durable(file(record.id),record);
  return summary(record);
 }
 function ready(operations,id,world){
  const pending=operations.find(r=>!r.complete&&r.id!==id&&r.world_uuid===world);
  if(pending)throw Error('请先续接该世界的待完成操作 '+pending.id);
 }
 return {
  apply(value,operationId){
   return serialized(()=>locked(async()=>{
    const design=packet(value),digest=sha(JSON.stringify(design)),id=operationId??idFor(digest);
    const existing=load(id);
    if(existing){
     if(existing.digest!==digest)throw Error('该操作标识已经绑定另一份方案');
     return resume(existing);
    }
    const operations=all(),previous=operations.filter(r=>r.draft_id===design.draft_id&&r.world_uuid===design.world_uuid);
    ready(operations,id,design.world_uuid);
    if(previous.some(r=>r.draft_revision>design.draft_revision))throw Error('存在更新的已提交方案修订');
    const applied={...design.previously_applied};
    for(const r of previous)for(const change of changesIn(r)){
     const key=keyOf(change);
     if(change.after===design.base[key])delete applied[key];else applied[key]=change.after;
    }
    const edits=[...new Set([...Object.keys(design.changes),...Object.keys(applied)])].sort().map(key=>{
     const [x,y,z]=coordinate(key),before=applied[key]??design.base[key],state=design.changes[key]??design.base[key];
     if(!stateOk(state)||!stateOk(before))throw Error('方案没有保留先前写入位置的原始方块 '+key);
     return {x,y,z,before,state};
    });
    const record={id,digest,order:operations.length,kind:'apply',world_uuid:design.world_uuid,draft_id:design.draft_id,
     draft_revision:design.draft_revision,label:design.label,edits,batch_ends:batchEnds(edits),batches:[],complete:false};
    durable(file(id),record);
    return resume(record);
   }));
  },
  reverse(id,direction){
   return serialized(()=>locked(async()=>{
    const original=load(id);
    if(!original||original.kind!=='apply')throw Error('未找到方案写入操作');
    const operations=all(),history=operations.filter(r=>r.parent===id),pending=history.find(r=>!r.complete);
    if(pending){
     if(pending.kind!==direction)throw Error('请先续接 '+pending.id);
     return resume(pending);
    }
    const last=history.at(-1);
    const source=direction==='undo'?(last?.kind==='redo'?last:original):last;
    if(last?.kind===direction)return summary(last);
    if(direction==='redo'&&last?.kind!=='undo')throw Error('没有可以重做的写入');
    if(!source)throw Error('没有可以重做的写入');
    if(source.batches.some(b=>!b.undoable))throw Error('该次写入含有需要专用恢复的方块实体');
    const next=idFor(id+'/'+direction+'/'+history.length);
    if(!original.complete&&original.rejected&&direction==='undo'){
     original.complete=true;
     original.aborted=true;
     durable(file(original.id),original);
     const index=operations.findIndex(op=>op.id===original.id);
     operations[index]=original;
    }
    ready(operations,next,original.world_uuid);
    const edits=changesIn(source).map(c=>({x:c.x,y:c.y,z:c.z,before:c.after,state:c.before}));
    const record={id:next,parent:id,order:operations.length,kind:direction,world_uuid:original.world_uuid,
     draft_id:original.draft_id,draft_revision:original.draft_revision,label:original.label,edits,batch_ends:batchEnds(edits),batches:[],complete:false};
    durable(file(next),record);
    return resume(record);
   }));
  },
  status(id){const r=load(id);if(!r)throw Error('未找到写入操作');return summary(r);},
  history:()=>all().map(summary).reverse()
 };
}
