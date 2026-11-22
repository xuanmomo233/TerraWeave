import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {projectStore,snapshotBytes} from './project-store.mjs';

function fixture(run){const root=fs.mkdtempSync(path.join(os.tmpdir(),'terraweave-store-'));try{return run(root,projectStore(root));}finally{const actual=fs.realpathSync(root);if(path.dirname(actual)!==fs.realpathSync(os.tmpdir())||!path.basename(actual).startsWith('terraweave-store-'))throw Error('Unexpected fixture path');fs.rmSync(actual,{recursive:true,force:true});}}
const snapshot=(state='minecraft:air',extra={})=>({schema:1,minecraft:'1.20.1',world:'world',uuid:'world-test',bounds:[0,0,0,0,0,0],blocks:{'0,0,0':state},...extra});
const record=(id,pins,extra={})=>({id,label:'客栈',bounds:[0,0,0,0,0,0],loaded_bounds:[0,0,0,0,0,0],world:'world',world_uuid:'world-test',source:'live_paper_main_thread',captured_at:'2026-11-17T00:00:00Z',...pins,...extra});
function write(root,group,id,value){fs.mkdirSync(path.join(root,group),{recursive:true});fs.writeFileSync(path.join(root,group,id+'.json'),JSON.stringify(value));}
test('canonical snapshot bytes are identical for ordered and unsorted negative coordinates',()=>{
 const blocks={'-2,-1,-3':'minecraft:air','1,-1,-3':'minecraft:water','-2,-1,0':'minecraft:stone','-2,0,-3':'minecraft:glass'};
 const context_blocks={'-3,-1,-4':'minecraft:air','-2,-1,-4':'minecraft:stone','-3,0,-4':'minecraft:water'};
 const source=snapshot('minecraft:air',{bounds:[-2,-1,-3,1,0,0],blocks,context_blocks});
 const reverse=data=>Object.fromEntries(Object.entries(data).reverse());
 assert.equal(snapshotBytes(source),snapshotBytes({...source,blocks:reverse(blocks),context_blocks:reverse(context_blocks)}));
 assert.deepEqual(Object.keys(JSON.parse(snapshotBytes(source)).blocks),Object.keys(blocks));
});

test('unchanged refreshes deduplicate volatile server metadata and keep a single logical region',()=>fixture((root,store)=>{
 const a=store.saveSnapshot(snapshot('minecraft:stone',{at_ms:1,pid:100})),b=store.saveSnapshot(snapshot('minecraft:stone',{at_ms:2,pid:200,source:'design_draft',draft_revision:4}));assert.deepEqual(a,b);
 const first=store.commit(record('first',a),undefined,true),second=store.commit(record('second',b),first.entity_id,true);
 assert.equal(first.id,second.id);assert.equal(store.listRegions().length,1);assert.equal(store.summary().files.snapshots.count,1);assert.equal(store.summary().files.regions.count,1);
 const bytes=fs.readFileSync(path.join(root,'snapshots',a.snapshot_id+'.json'));assert.equal(createHash('sha256').update(bytes).digest('hex'),a.snapshot_hash);
 const renamed=store.commit(record('renamed',a,{label:'石基客栈',notes:'保留门洞'}),first.entity_id);assert.equal(renamed.entity_id,first.entity_id);assert.equal(store.listRegions()[0].label,'石基客栈');assert.equal(store.summary().files.snapshots.count,1);
}));
test('legacy timestamp entries migrate into one region without losing image or draft references',()=>fixture((root,store)=>{
 const pins=store.saveSnapshot(snapshot());for(let i=0;i<20;i++)write(root,'regions','legacy-'+i,record('legacy-'+i,pins,{captured_at:'2026-11-17T00:00:'+String(i).padStart(2,'0')+'Z'}));
 write(root,'drafts','design',{base_region_id:'legacy-0'});fs.mkdirSync(path.join(root,'captures','saved-image'),{recursive:true});fs.writeFileSync(path.join(root,'captures','saved-image','capture.json'),JSON.stringify({region_id:'legacy-1'}));
 store.initialize();assert.equal(store.listRegions().length,1);const result=store.compact();assert.ok(result.removed_files>0);
 assert.ok(fs.existsSync(path.join(root,'regions','legacy-0.json')));assert.ok(fs.existsSync(path.join(root,'regions','legacy-1.json')));assert.equal(store.revisions('legacy-19').length,1);
}));
test('cache collection bounds working revisions while keeping manual checkpoints and exact old data',()=>fixture((root,store)=>{
 let entity,first;
 for(let i=0;i<25;i++){const pins=store.saveSnapshot(snapshot('minecraft:stone[state='+i+']'));const r=store.commit(record('r-'+i,pins),entity);entity=r.entity_id;if(i===0){first=r;store.checkpoint(r.id,'原始版本');}}
 store.compact();assert.equal(store.listRegions().length,1);assert.equal(store.summary().files.regions.count,2);assert.equal(store.summary().files.snapshots.count,2);
 assert.ok(fs.existsSync(path.join(root,'snapshots',first.snapshot_id+'.json')));assert.equal(store.checkpoint(first.id).region_id,first.id);assert.equal(store.summary().checkpoints,1);
}));
test('a malformed saved reference stops collection before any file is removed',()=>fixture((root,store)=>{
 const pins=store.saveSnapshot(snapshot());store.commit(record('head',pins));write(root,'snapshots','orphan',{keep:'until reference checks pass'});write(root,'drafts','broken',{base_region_id:'missing'});
 assert.throws(()=>store.compact());assert.ok(fs.existsSync(path.join(root,'snapshots','orphan.json')));
}));
test('explicit old-asset cleanup removes archived objects and keeps the latest active capture',()=>fixture((root,store)=>{
 const pins=store.saveSnapshot(snapshot()),active=store.commit(record('active',pins)),old=store.commit(record('retired',pins,{label:'测试区域'}));store.archive(old.entity_id,true);
 for(const [id,owner]of [['100-old',active],['200-new',active],['300-retired',old]]){const dir=path.join(root,'captures',id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'capture.json'),JSON.stringify({region_id:owner.id}));}
 const result=store.cleanupAssets(true,true);store.compact();assert.equal(result.removed_assets,2);assert.equal(store.listRegions(true).length,1);assert.ok(fs.existsSync(path.join(root,'captures','200-new')));assert.equal(fs.existsSync(path.join(root,'captures','100-old')),false);
}));

test('deleting selected capture groups releases only snapshots with no surviving reference',()=>fixture((root,store)=>{
 store.retention(1,0);
 const shared=store.savePreview(record('shared',store.saveSnapshot(snapshot('minecraft:stone')),{transient:true}));
 const unique=store.savePreview(record('unique',store.saveSnapshot(snapshot('minecraft:dirt')),{transient:true}));
 for(const [id,owner] of [['keep',shared],['remove-shared',shared],['remove-unique',unique]]){
  const dir=path.join(root,'captures',id);
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'capture.json'),JSON.stringify({region_id:owner.id}));
  fs.writeFileSync(path.join(dir,'view-0.png'),'fixture');
 }
 assert.throws(()=>store.deleteCaptures(['keep','../snapshots']),/无效的预览图片组/);
 assert.deepEqual(store.deleteCaptures(['remove-shared','remove-unique','remove-shared','missing']),{
  deleted_ids:['remove-shared','remove-unique'],failures:[]
 });
 store.compact();
 assert.deepEqual(fs.readdirSync(path.join(root,'captures')),['keep']);
 assert.ok(fs.existsSync(path.join(root,'captures','keep','view-0.png')));
 assert.deepEqual(fs.readdirSync(path.join(root,'snapshots')),[shared.snapshot_id+'.json']);
 assert.deepEqual(store.deleteCaptures(['remove-unique']),{deleted_ids:[],failures:[]});
}));
