import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {tabViewService} from './tab-view-service.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terraweave-tab-view-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let revision='stable';
 const writes=[];
 const load=tabViewService({
  folder:()=>root,stamp:()=>revision,
  atomic:(file,value)=>fs.writeFileSync(file,JSON.stringify(value),{flag:'wx'}),
  read:file=>JSON.parse(fs.readFileSync(file,'utf8')),
  prepare:async ({kind})=>({kind:'display',region:{id:kind},snapshot:{blocks:{}}}),
  commit:view=>{writes.push(view.region.id);return {region_id:view.region.id};}
 });
 return {load,writes,setRevision:next=>{revision=next;}};
}

test('tab preparation leaves the active document alone until the foreground commits',async t=>{
 const {load,writes}=fixture(t);
 const first=await load('prepare_tab_view',{kind:'first'});
 const next=await load('prepare_tab_view',{kind:'next'});
 assert.deepEqual(writes,[]);
 assert.deepEqual(await load('commit_tab_view',{ticket:next.ticket}),{region_id:'next'});
 assert.deepEqual(await load('commit_tab_view',{ticket:next.ticket}),{stale:true});
 assert.deepEqual(writes,['next']);
 assert.notEqual(first.ticket,next.ticket);
});

test('a prefetched tab cannot be registered after the project revision changes',async t=>{
 const {load,writes,setRevision}=fixture(t);
 const prepared=await load('prepare_tab_view',{kind:'first'});
 setRevision('changed');
 assert.deepEqual(await load('commit_tab_view',{ticket:prepared.ticket}),{stale:true});
 assert.deepEqual(writes,[]);
});
