import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {worldWriter} from './world-writer.mjs';
import {normalizeBlockState} from './block-states.mjs';

test('offline block registry fills defaults and rejects invalid properties',()=>{
 assert.equal(normalizeBlockState('oak_log'),'minecraft:oak_log[axis=y]');
 assert.equal(normalizeBlockState('minecraft:oak_log[axis=z]'),'minecraft:oak_log[axis=z]');
 assert.throws(()=>normalizeBlockState('oak_log[axis=up]'),/属性/);
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
