import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {mapToScreen,screenToMap,validatePlan,planBounds} from './planning-core.mjs';
import {planningService} from './planning-service.mjs';
import {decodeSurfaceChunk,parseNbt} from './world-surface.mjs';
import {MapViewport} from '../map-viewport.js';

test('returning from 3D resumes missing surface tiles and reuses each unaffected bitmap',async()=>{
 let release;
 const gate=new Promise(resolve=>{release=resolve;}),reads=[],draws=[];
 const viewport=new MapViewport({getContext:()=>({})},async(name,args)=>{
  reads.push(args);await gate;return {revision:args.world_revision,projection:args.visibility_key};
 },{},true);
 viewport.image=data=>({...data});viewport.draw=()=>draws.push(true);viewport.resize=()=>false;
 viewport.view={x:128,z:32,scale:.5,rotation:0};viewport.width=512;viewport.height=64;
 const terrain={world_uuid:'map',revision:'save',bounds:[0,0,255,63],visibility_revision:'',visibility_map_tiles:{}};
 viewport.setTerrain(terrain);
 assert.equal(reads.length,2);
 viewport.setActive(false);
 const hiddenDraws=draws.length;
 release();await new Promise(setImmediate);
 assert.equal(reads.length,2);assert.equal(draws.length,hiddenDraws);
 viewport.setActive(true);await viewport.settle();
 assert.equal(reads.length,4);assert.ok(reads.every(t=>t.world_revision==='save'));
 const original=new Map(viewport.tiles);
 viewport.setActive(false);
 viewport.setTerrain({...terrain,visibility_revision:'hidden',visibility_map_tiles:{'0:2,0':'hidden'}},false);
 viewport.setActive(true);await viewport.settle();
 assert.equal(reads.length,5);assert.equal(reads.at(-1).x,2);
 for(const t of viewport.visibleKeys().filter(t=>t.x!==2))assert.equal(viewport.tiles.get(t.key),original.get(t.key));
 viewport.setTerrain(terrain);await viewport.settle();assert.equal(reads.length,5);
});

test('capturing a visible map tile shares an in-flight read and its decoded image',async t=>{
 let reads=0,decoded=0,release;
 const gate=new Promise(resolve=>{release=resolve;});
 const canvas=()=>({getContext:()=>new Proxy({},{get:()=>()=>{}}),toDataURL:()=>'data:image/png;base64,'});
 const previous=globalThis.document;
 globalThis.document={createElement:canvas};
 t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
 const viewport=new MapViewport(canvas(),async()=>{reads++;await gate;return {bounds:[0,0,64,64],revision:'tile'};},{},true);
 viewport.draw=()=>{};viewport.image=()=>({decoded:++decoded});
 viewport.width=viewport.height=64;viewport.view={x:32,z:32,scale:.5,rotation:0};
 const info={revision:'save',bounds:[0,0,63,63],visibility_revision:'',visibility_map_tiles:{}};
 viewport.setTerrain(info);
 const capture=viewport.capture({view:viewport.view,width:64,height:64},info,{revision:1,layers:[],objects:[]});
 assert.equal(reads,1);
 release();
 const result=await capture;
 assert.equal(reads,1);assert.equal(decoded,1);
 assert.deepEqual(result.tile_revisions,[{x:0,z:0,level:0,revision:'tile'}]);
});

test('map rotation and zoom preserve exact world positions in both directions',()=>{
 for(const rotation of [0,37,90,180,285])for(const scale of [.25,4,100]){const view={x:12000,z:-7000,scale,rotation},p=[12743.5,-9122.25],screen=mapToScreen(p,view,1300,760),actual=screenToMap(screen,view,1300,760);assert.ok(Math.abs(actual[0]-p[0])<1e-7);assert.ok(Math.abs(actual[1]-p[1])<1e-7);}
});
test('planning areas are map-scale polygons rather than limited voxel capture boxes',()=>{
 const p=validatePlan({type:'area',name:'城镇与山谷',notes:'主街连接港口',points:[[-5000,-5000],[5000,-5000],[5000,5000],[-5000,5000]],color:'#5599ee',width:5});assert.deepEqual(planBounds(p),[-5000,-5000,5000,5000]);
});
test('hide retains planning data, delete removes it, and undo restores geometry and layer state',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terraweave-planning-'));
 try{const service=planningService(root,()=>[],()=> 'test-world');let state=service.execute('save_plan',{name:'主城区',type:'area',points:[[0,0],[3000,0],[3000,2000],[0,2000]]});const id=state.selected_id;
  state=service.execute('save_plan',{plan_id:id,visible:false,notes:'预留广场'});assert.equal(state.objects.length,1);assert.equal(state.objects[0].visible,false);
  state=service.execute('delete_plan',{plan_id:id});assert.equal(state.objects.length,0);state=service.execute('undo_plan',{});assert.equal(state.objects[0].name,'主城区');assert.equal(state.objects[0].visible,false);assert.equal(state.objects[0].notes,'预留广场');
  state=service.execute('save_plan',{type:'route',name:'主街',points:[[0,0],[1000,500],[2500,1000]],layer_id:'roads',width:8});assert.equal(state.objects.length,2);state=service.execute('update_layer',{layer_id:'roads',visible:false});assert.equal(state.layers.find(l=>l.id==='roads').visible,false);assert.equal(state.objects.length,2);
  state=service.execute('save_plan',{plan_id:id,min_y:-12,max_y:64});
  assert.deepEqual([state.objects[0].min_y,state.objects[0].max_y],[-12,64]);
  assert.throws(()=>service.execute('save_plan',{plan_id:id,min_y:65,max_y:64}));
  state=service.execute('save_plan',{plan_id:id,min_y:null,max_y:null});
  assert.equal(state.objects[0].min_y,undefined);
  assert.equal(state.objects[0].max_y,undefined);
  const again=planningService(root,()=>[],()=> 'test-world').read();assert.equal(again.revision,state.revision);
 }finally{if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith('terraweave-planning-'))throw Error('Unexpected test cleanup path');fs.rmSync(root,{recursive:true,force:true});}
});
test('surface decoding distinguishes known void, unsupported data and missing sections',()=>{
 const packed=value=>Array.from({length:37},()=>{let n=0n;for(let i=0;i<7;i++)n|=BigInt(value)<<BigInt(i*9);return n;});
 const chunk={DataVersion:3465,Status:'minecraft:full',Heightmaps:{WORLD_SURFACE:packed(75)},sections:[{Y:0,block_states:{palette:[{Name:'minecraft:stone'}]}}]};
 assert.deepEqual(decodeSurfaceChunk(chunk).surface(4,8),{y:10,state:'minecraft:stone'});assert.equal(decodeSurfaceChunk({...chunk,sections:[]}).surface(4,8),null);
 assert.equal(decodeSurfaceChunk({...chunk,Heightmaps:{WORLD_SURFACE:packed(0)}}).surface(4,8).empty,true);assert.throws(()=>decodeSurfaceChunk({...chunk,DataVersion:1}));assert.throws(()=>parseNbt(Buffer.from([10,0])));
});

test('temporary layer cleanup cannot resurrect test objects and preserves unrelated planning undo',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terraweave-planning-'));
 try{const s=planningService(root,()=>[],()=> 'test-world');let state=s.execute('save_plan',{type:'marker',name:'原有地点',points:[[3,4]]});const original=state.selected_id;
  state=s.execute('create_layer',{name:'临时验收'});const layer=state.layers.at(-1).id;
  s.execute('save_plan',{type:'area',layer_id:layer,name:'测试区域',points:[[0,0],[2000,0],[0,2000]]});
  s.execute('save_plan',{plan_id:original,notes:'应当保留的用户改动'});
  state=s.execute('delete_layer',{layer_id:layer,forget_history:true});assert.equal(state.undo_count,2);
  state=s.execute('undo_plan',{});assert.equal(state.objects[0].notes,'');assert.equal(state.layers.some(l=>l.id===layer),false);assert.equal(state.objects.length,1);
  state=s.execute('redo_plan',{});assert.equal(state.objects[0].notes,'应当保留的用户改动');
  const revision=state.revision;state=s.execute('save_plan',{plan_id:original,notes:'应当保留的用户改动'});assert.equal(state.revision,revision);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
