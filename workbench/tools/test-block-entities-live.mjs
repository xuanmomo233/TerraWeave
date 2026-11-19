import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {SERVER,serverRequest,serverStatus,stopServer} from './test-server.mjs';
import {bridgeTransport,worldWriter} from './world-writer.mjs';

assert.equal(serverStatus().running,false,'Run this live acceptance with the original test server stopped');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'terraweave-live-entities-'));
const logfile=fs.openSync(path.join(scratch,'paper.log'),'a');
const javaSettings=spawnSync('java.exe',['-XshowSettings:properties','-version'],{encoding:'utf8',windowsHide:true});
const javaHome=/^\s*java\.home = (.+?)\s*$/m.exec(javaSettings.stderr??'')?.[1];
if(javaSettings.status!==0||!javaHome)throw Error('Cannot resolve the Java runtime for the original test server');
const java=path.join(javaHome,'bin','java.exe');
const child=spawn(java,['-Dfile.encoding=UTF-8','-Dstdout.encoding=UTF-8','-Dstderr.encoding=UTF-8',
 '-Xms512M','-Xmx2G','-jar','paper-1.20.1-196.jar','--nogui'],
 {cwd:SERVER,stdio:['pipe',logfile,logfile],windowsHide:true});
fs.closeSync(logfile);
await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
const exited=new Promise(resolve=>child.once('exit',resolve));
const positions=[];
let seedSent=false;
const air='minecraft:air';
function consoleCommand(command){
 if(child.exitCode!==null)throw Error('Original Paper fixture has already stopped');
 child.stdin.write(command+'\n');
}
async function waitFor(check,description,timeout=45000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){
  if(child.exitCode!==null)throw Error('Paper stopped during '+description+' · '+scratch);
  const value=await check();
  if(value)return value;
  await wait(300);
 }
 throw Error(description+' did not complete · '+scratch);
}
const readEntities=async()=>(await serverRequest('read_block_entities',{positions})).entities;
try{
 const server=await waitFor(()=>{
  const current=serverStatus();
  return current.running&&current.identity.pid===child.pid?current.identity:null;
 },'start the original Paper fixture',90000);
 assert.equal(server.block_entity_payload,1);
 for(let y=316;y>=312&&!positions.length;y--){
  const candidates=[[40,y,10],[42,y,10],[44,y,10]];
  const data=await serverRequest('read_blocks',{positions:candidates});
  if(candidates.every(p=>data.blocks[p.join()]===air))positions.push(...candidates);
 }
 assert.equal(positions.length,3,'Expected three unused generated fixture cells');
 const [chest,barrel,banner]=positions;
 seedSent=true;
 consoleCommand('setblock '+chest.join(' ')+' chest[facing=north,type=single,waterlogged=false]{CustomName:\'{"text":"TerraWeave Chest"}\',Items:[{Slot:3b,id:"minecraft:diamond",Count:7b}]}');
 consoleCommand('setblock '+barrel.join(' ')+' barrel[facing=up,open=false]{Items:[{Slot:9b,id:"minecraft:book",Count:4b}]}');
 consoleCommand('setblock '+banner.join(' ')+' white_banner[rotation=0]{Patterns:[{Pattern:"cr",Color:14},{Pattern:"bo",Color:11}]}');
 const baseline=await waitFor(async()=>{
  const data=await readEntities();
  return positions.every(p=>data[p.join()]?.payload?.codec)?data:null;
 },'place the chest, barrel and banner');
 assert.match(baseline[chest.join()].payload.snbt,/minecraft:diamond/);
 assert.match(baseline[barrel.join()].payload.snbt,/minecraft:book/);
 assert.match(baseline[banner.join()].payload.snbt,/Patterns/);
 await serverRequest('save');
 const writer=worldWriter({directory:path.join(scratch,'ledger'),send:bridgeTransport(path.join(SERVER,'plugins','WorkbenchLive'))});
 const design={schema:1,world_uuid:server.world_uuid,minecraft:server.minecraft,draft_id:randomUUID(),draft_revision:1,
  label:'容器和旗帜撤销验收',base:Object.fromEntries(positions.map(p=>[p.join(),baseline[p.join()].state])),
  changes:Object.fromEntries(positions.map(p=>[p.join(),'minecraft:stone'])),previously_applied:{}};
 const applied=await writer.apply(design);
 assert.equal(applied.complete,true,applied.error);
 assert.equal(applied.changed,3);
 for(const p of positions)assert.equal((await readEntities())[p.join()].state,'minecraft:stone');
 const undo=await writer.reverse(applied.operation_id,'undo');
 assert.equal(undo.complete,true,undo.error);
 assert.equal(undo.changed,3);
 assert.deepEqual(await readEntities(),baseline);
 const redo=await writer.reverse(applied.operation_id,'redo');
 assert.equal(redo.complete,true,redo.error);
 assert.equal(redo.changed,3);
 const secondUndo=await writer.reverse(applied.operation_id,'undo');
 assert.equal(secondUndo.changed,3,secondUndo.error);
 assert.deepEqual(await readEntities(),baseline);
 const sample=path.join(scratch,'undo-preview');
 const savedWorld=path.join(SERVER,server.world);
 fs.mkdirSync(path.join(sample,'region'),{recursive:true});
 fs.copyFileSync(path.join(savedWorld,'level.dat'),path.join(sample,'level.dat'));
 const regionFiles=new Set(positions.map(([x,,z])=>'r.'+Math.floor(x/512)+'.'+Math.floor(z/512)+'.mca'));
 for(const file of regionFiles)fs.copyFileSync(path.join(savedWorld,'region',file),path.join(sample,'region',file));
 // A later server edit changes NBT but leaves the same BlockData.
 consoleCommand('data merge block '+chest.join(' ')+' {Items:[{Slot:0b,id:"minecraft:gold_ingot",Count:1b}]}');
 const external=await waitFor(async()=>{
  const data=await readEntities();
  return /minecraft:gold_ingot/.test(data[chest.join()]?.payload?.snbt)?data:null;
 },'observe a later container edit');
 const conflictingRedo=await writer.reverse(applied.operation_id,'redo');
 assert.equal(conflictingRedo.changed,2,conflictingRedo.error);
 assert.equal(conflictingRedo.conflict_count,1);
 assert.deepEqual((await readEntities())[chest.join()],external[chest.join()]);
 console.log(JSON.stringify({passed:true,positions,applied,undo,redo,secondUndo,conflictingRedo,log:scratch,offline_sample:sample}));
}finally{
 try{
  if(serverStatus().identity?.pid===child.pid&&serverStatus().running){
   try{
    if(seedSent){
     const latest=await readEntities();
     const cleanup=await serverRequest('apply_blocks',{physics:false,blocks:positions.map(([x,y,z])=>{
      const entry=latest[[x,y,z].join()];
      return {x,y,z,before:entry.state,before_entity:entry.payload,state:air,after_entity:null};
     })});
     assert.equal(cleanup.conflicts.length,0,'Fixture cleanup encountered a conflict');
     assert.ok(positions.every(p=>cleanup.changes.some(c=>[c.x,c.y,c.z].join()===p.join()&&c.after===air)||latest[p.join()].state===air));
     assert.ok(Object.values(await readEntities()).every(e=>e.state===air&&e.payload===null));
     console.log(JSON.stringify({fixture_restored:true,positions}));
    }
   }finally{await stopServer();}
  }else if(child.exitCode===null)consoleCommand('stop');
 }finally{
  child.stdin.end();
  if(child.exitCode===null)await exited;
 }
}
