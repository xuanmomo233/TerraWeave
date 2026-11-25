import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {constructionView,effectiveConstructionState,registerConstructionSource} from './construction-view.mjs';
import {projectConstructionSnapshot} from './render-context.mjs';

const air='minecraft:air',stone='minecraft:stone',brick='minecraft:bricks',wood='minecraft:oak_planks',glass='minecraft:glass';
const write=(root,parts,value)=>{
 const file=path.join(root,...parts);
 fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,JSON.stringify(value));
 return file;
};
const workspace=t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terraweave-construction-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return root;
};
const change=(x,before,after)=>({x,y:64,z:0,before,after});
const record=(n,draft_id,changes,metadata={})=>({
 id:'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),draft_id,order:n,
 world_uuid:'world',kind:'apply',batches:[{changes}],...metadata
});
const saveRecord=(root,r,directory=['authoring','writer-state'])=>write(root,[...directory,r.id+'.json'],r);
const plans=(hidden=[],layer=true)=>({objects:['a','b'].map(id=>({id,layer_id:id,visible:!hidden.includes(id)})),
 layers:[{id:'a',visible:true},{id:'b',visible:layer}]});

test('hide restores the next visible construction or the original block and protects external edits',()=>{
 const history=[stone,wood,'a',brick,'b',wood];
 assert.equal(effectiveConstructionState(wood,history,new Set(['b'])),brick);
 assert.equal(effectiveConstructionState(wood,history,new Set(['a','b'])),stone);
 assert.equal(effectiveConstructionState(glass,history,new Set(['a','b'])),glass);
 assert.equal(effectiveConstructionState(undefined,history,new Set(['a','b'])),undefined);
});

test('the construction view classifies legacy receipts, respects a hidden layer, and updates tile neighbors',t=>{
 const root=workspace(t);
 const a=record(1,'legacy',[change(31,stone,brick),change(32,air,brick),change(33,air,brick)]);
 const b=record(2,'newer',[change(31,brick,wood),change(32,brick,air),change(34,air,wood)],{plan_id:'b'});
 saveRecord(root,a);saveRecord(root,b);
 write(root,['authoring','construction.json'],{parts:{square:{draft_id:'legacy',plan_id:'a'}}});
 assert.equal(constructionView(root,'world',plans()),null);
 assert.equal(constructionView(root,'other',plans(['a'])),null);
 const hidden=constructionView(root,'world',plans([],false));
 assert.equal(hidden.block(31,64,0,wood),brick);
 assert.equal(hidden.block(32,64,0,air),brick);
 assert.equal(hidden.block(34,64,0,wood),air);
 assert.equal(hidden.block(34,64,0,glass),glass);
 assert.equal(hidden.tileKey(-1,0),'');
 assert.notEqual(hidden.tileKey(0,-1),'');
 assert.notEqual(hidden.tileKey(1,-1),'');
 assert.notEqual(hidden.mapTileKey(0,0,0),'');
 assert.equal(hidden.mapTileKey(-1,0,0),'');
 assert.notEqual(hidden.mapTileKey(0,0,10),'');
 const raw={bounds:[32,64,0,34,64,0],blocks:{'32,64,0':air,'33,64,0':brick,'34,64,0':wood},context_blocks:{'31,64,0':wood}};
 const projected=projectConstructionSnapshot(raw,hidden);
 assert.equal(projected.blocks['32,64,0'],brick);
 assert.equal(projected.context_blocks['31,64,0'],brick);
 assert.equal(raw.context_blocks['31,64,0'],wood);
 const both=constructionView(root,'world',plans(['a','b']));
 assert.equal(both.block(31,64,0,wood),stone);
 assert.equal(both.block(32,64,0,air),air);
 assert.equal(both.block(33,64,0,brick),air);
});

test('a linked writer remains the source of ownership across apply, undo, and redo',t=>{
 const root=workspace(t),directory=path.join(root,'local-writer');
 const design={world_uuid:'world',draft_id:'d',plan_id:'a'};
 write(root,['drafts','d.json'],design);
 const exported=write(root,['exports','d.json'],design);
 const a=record(1,'d',[change(0,stone,brick)],{plan_id:'a'});
 saveRecord(root,a,['local-writer']);
 registerConstructionSource(exported,design,directory);
 assert.equal(constructionView(root,'world',plans(['a'])).block(0,64,0,brick),stone);
 saveRecord(root,record(2,'d',[change(0,brick,stone)],{kind:'undo',parent:a.id,plan_id:'a'}),['local-writer']);
 assert.equal(constructionView(root,'world',plans(['a'])),null);
 saveRecord(root,record(3,'d',[change(0,stone,brick)],{kind:'redo',parent:a.id,plan_id:'a'}),['local-writer']);
 assert.equal(constructionView(root,'world',plans(['a'])).block(0,64,0,brick),stone);
});

test('generated terrain follows its plan across the map, meshes and local views',t=>{
 const root=workspace(t),revision='a'.repeat(64),deep='minecraft:deepslate',ground='minecraft:deepslate[axis=y]';
 const palette=[air,deep,stone],bytes=Buffer.alloc(384*1024*4);
 const store=(x,y,state,owner,previous=0,previousOwner=0)=>
  bytes.writeUInt32LE(state|owner<<8|previous<<16|previousOwner<<24,((y+64)*1024+x)*4);
 store(0,64,1,1);
 store(1,64,2,2,1,1);
 store(2,64,1,1);
 store(3,64,1,1);
 store(4,65,0,2,1,1);
 write(root,['authoring','generated-construction.json'],{schema:1,world_uuid:'world',revision,plans:[null,'a','b'],
  palette,tiles:{'0,0':[1,2]},restores:{'0,0':[4]}});
 const folder=path.join(root,'authoring','generated-construction',revision);
 fs.mkdirSync(folder,{recursive:true});
 fs.writeFileSync(path.join(folder,'0,0.gz'),gzipSync(bytes));
 saveRecord(root,record(1,'tower',[change(2,ground,brick)],{plan_id:'c'}));
 const hideTerrain=constructionView(root,'world',plans(['a']));
 assert.equal(hideTerrain.block(0,64,0,ground),air);
 assert.equal(hideTerrain.block(1,64,0,stone),stone);
 assert.equal(hideTerrain.block(2,64,0,brick),brick);
 assert.equal(hideTerrain.block(3,64,0,glass),glass);
 assert.equal(hideTerrain.block(3,64,0,'minecraft:deepslate[axis=x]'),'minecraft:deepslate[axis=x]');
 assert.ok(hideTerrain.column(0,0));
 assert.ok(hideTerrain.mapTileKey(0,0,1));
 assert.ok(hideTerrain.tileKey(-1,-1));
 const hidePath=constructionView(root,'world',plans(['b']));
 assert.equal(hidePath.block(1,64,0,stone),deep);
 assert.equal(hidePath.block(4,65,0,air),deep);
 assert.deepEqual(hidePath.generated.restoreSections(0,0),[4]);
 const both=constructionView(root,'world',plans(['a','b']));
 assert.equal(both.block(1,64,0,stone),air);
 assert.equal(both.block(4,65,0,air),air);
 const raw={bounds:[0,64,0,2,64,0],blocks:{'0,64,0':ground,'1,64,0':stone,'2,64,0':brick},context_blocks:{'3,64,0':glass}};
 assert.deepEqual(projectConstructionSnapshot(raw,both).blocks,{'0,64,0':air,'1,64,0':air,'2,64,0':brick});
 assert.equal(raw.blocks['0,64,0'],ground);
 const cells=new Uint32Array(4096);
 cells.set([1,2,3,4]);
 both.generated.section(0,0,4,cells,[air,ground,stone,brick,glass],state=>palette.indexOf(state),new Set([2]));
 assert.deepEqual(Array.from(cells.slice(0,4)),[0,0,3,4]);
});
