import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {bridgeTransport,worldWriter} from './world-writer.mjs';
import {normalizeBlockState} from './block-states.mjs';

test('offline block registry fills defaults and rejects invalid properties',()=>{
 assert.equal(normalizeBlockState('oak_log'),'minecraft:oak_log[axis=y]');
 assert.equal(normalizeBlockState('minecraft:oak_log[axis=z]'),'minecraft:oak_log[axis=z]');
 assert.throws(()=>normalizeBlockState('oak_log[axis=up]'),/属性/);
});
test('sign undo and redo carry entity payloads and the original target version',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terraweave-sign-undo-'));
 t.after(()=>fs.rmSync(root,{recursive:true}));
 const world_uuid='d371b040-fab1-477b-ba1d-0183fdc9950e',draft_id='ade4300c-8654-41cd-aaaa-de4cf56ccbce';
 const sign='minecraft:oak_sign[rotation=0,waterlogged=false]',air='minecraft:air';
 const original={front:['入口','','',''],back:['','请关门','',''],waxed:true};
 const requests=[];
 const writer=worldWriter({directory:root,send:async(_id,request)=>{
  requests.push(request);
  const cell=request.blocks[0];
  const before_sign=requests.length===1?original:cell.before_sign;
  const after_sign=requests.length===1?null:cell.after_sign;
  return {world_uuid,minecraft:'26.2',changed:1,already:0,conflicts:[],undoable:true,
   changes:[{...cell,after:cell.state,before_sign,after_sign}]};
 }});
 const applied=await writer.apply({schema:1,world_uuid,draft_id,draft_revision:1,minecraft:'26.2',
  base:{'0,64,0':sign},changes:{'0,64,0':air},previously_applied:{}});
 assert.equal((await writer.reverse(applied.operation_id,'undo')).complete,true);
 assert.equal((await writer.reverse(applied.operation_id,'redo')).complete,true);
 assert.ok(requests.every(request=>request.minecraft==='26.2'));
 assert.deepEqual(requests[1].blocks[0],{x:0,y:64,z:0,before:air,state:sign,before_sign:null,after_sign:original});
 assert.deepEqual(requests[2].blocks[0],{x:0,y:64,z:0,before:sign,state:air,before_sign:original,after_sign:null});
});
test('an old bridge cannot silently discard sign undo data',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terraweave-old-bridge-'));
 t.after(()=>fs.rmSync(root,{recursive:true}));
 const world_uuid='d371b040-fab1-477b-ba1d-0183fdc9950e';
 fs.writeFileSync(path.join(root,'heartbeat.json'),JSON.stringify({world_uuid,minecraft:'1.20.1',at_ms:Date.now()}));
 const send=bridgeTransport(root);
 await assert.rejects(send('x',{world_uuid,minecraft:'1.20.1',blocks:[
  {x:0,y:60,z:0,before:'minecraft:air',state:'minecraft:oak_sign',after_sign:{waxed:true}}
 ]}),/需要升级/);
 assert.equal(fs.existsSync(path.join(root,'requests')),false);
});
test('committed batches survive failure and a new writer process can undo the whole write',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terraweave-writer-'));
 const air='minecraft:air',stone='minecraft:stone';
 const uuid='d371b040-fab1-477b-ba1d-0183fdc9950e';
 const base=Object.fromEntries(Array.from({length:16385},(_,x)=>[x+',59,10',air]));
 const changes=Object.fromEntries(Object.keys(base).map(key=>[key,stone]));
 const world=new Map(Object.entries(base)),receipts=new Map();
 let responses=0;
 const send=async(id,request)=>{
  const existing=receipts.get(id);
  if(existing)return existing;
  const applied=[],conflicts=[];
  let already=0;
  for(const cell of request.blocks){
   const key=[cell.x,cell.y,cell.z].join(',');
   const current=world.get(key);
   if(current===cell.state){already++;continue;}
   if(current!==cell.before){conflicts.push({coordinate:key});continue;}
   world.set(key,cell.state);
   applied.push({...cell,after:cell.state});
  }
  const receipt={changed:applied.length,changes:applied,already,conflicts,world_uuid:uuid,undoable:true};
  receipts.set(id,receipt);
  if(++responses===2)throw Error('第二批回执丢失');
  return receipt;
 };
 try{
  const design={schema:1,world_uuid:uuid,draft_id:'ade4300c-8654-41cd-aaaa-de4cf56ccbce',draft_revision:1,base,changes,previously_applied:{}};
  const writer=worldWriter({directory:root,send}),partial=await writer.apply(design);
  assert.equal(partial.complete,false);assert.equal(partial.changed,16384);
  const restarted=worldWriter({directory:root,send});
  assert.equal(restarted.status(partial.operation_id).batches_committed,1);
  const done=await restarted.apply(design,partial.operation_id);
  assert.equal(done.complete,true);assert.equal(done.changed,16385);assert.equal(responses,2);
  const undo=await restarted.reverse(done.operation_id,'undo');
  assert.equal(undo.changed,16385);
  assert.equal([...world.values()].every(state=>state===air),true);
  const redo=await restarted.reverse(done.operation_id,'redo');
  assert.equal(redo.changed,16385);
 }finally{
  const resolved=fs.realpathSync(root);
  assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('terraweave-writer-'));
  for(const file of fs.readdirSync(resolved))fs.unlinkSync(path.join(resolved,file));
  fs.rmdirSync(resolved);
 }
});
