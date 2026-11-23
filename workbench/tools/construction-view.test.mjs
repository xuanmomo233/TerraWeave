import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {test} from 'node:test';
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
