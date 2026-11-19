import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as THREE from 'three';
import {contextPositions,draftContext} from './render-context.mjs';
import {makeIndex,cellsInChunk,patchLocalIndex} from '../chunk-index.js';
import {snapshotDelta,applySnapshotDelta,affectedChunkColumns} from '../snapshot-delta.js';
import {ChunkRenderer} from '../chunk-renderer.js';
import {snapshotBytes} from './project-store.mjs';
import {TexturedWorld} from '../textured-world.js';
import {buildState} from '../model-terrain.js';
test('a conduit supplies shaded geometry and keeps its water geometry when submerged',async()=>{
 const options={makeMaterial:(name,id)=>{const material=new THREE.MeshLambertMaterial();material.name=name;material.userData.water=id==='water';return material;}};
 const [conduit]=await buildState('minecraft:conduit[waterlogged=false]',options);
 conduit.geometry.computeBoundingBox();
 assert.equal(conduit.material.name,'block/conduit');
 assert.ok(!conduit.material.wireframe);
 assert.deepEqual(conduit.geometry.boundingBox.getSize(new THREE.Vector3()).toArray(),[.375,.375,.375]);
 const wet=await buildState('minecraft:conduit[waterlogged=true]',options);
 assert.ok(wet.some(part=>part.material.userData.water));
 assert.ok(wet.some(part=>part.material.name==='block/conduit'));
});
const water='minecraft:water[level=0]',grass='minecraft:grass_block[snowy=false]',air='minecraft:air';
test('draft delta preserves exact snapshot identity including removed cells and changed halo',()=>{
 const before={uuid:'test',world:'world',minecraft:'1.20.1',bounds:[0,59,0,1,60,1],
  blocks:{'0,59,0':air,'1,59,0':grass},context_blocks:{'-1,59,0':water}};
 const after={...before,blocks:{'0,59,0':grass,'1,60,1':water},context_blocks:{'-1,59,0':air}};
 const delta=snapshotDelta(before,after);
 assert.equal(snapshotBytes(applySnapshotDelta(before,delta)),snapshotBytes(after));
 assert.equal(before.blocks['1,59,0'],grass);
 assert.equal(snapshotDelta(before,{...after,bounds:[1,59,0,2,60,1]}),null);
});
test('partial meshing matches full face and fluid geometry inputs across a diagonal chunk border',async()=>{
 const bounds=[0,59,0,47,60,47],blocks={};
 for(let z=14;z<=17;z++)for(let x=14;x<=17;x++)blocks[`${x},59,${z}`]=water;
 blocks['40,59,40']=grass;
 const before={uuid:'test',world:'world',minecraft:'1.20.1',bounds,blocks},after={...before,blocks:{...blocks,'16,60,16':water}};
 const dirty=affectedChunkColumns(snapshotDelta(before,after));
 assert.deepEqual([...dirty].sort(),['0,0','0,1','1,0','1,1']);
 const opaqueStates=new Set([grass]),oldIndex=makeIndex(before,1,{cull:true,opaqueStates}),full=makeIndex(after,1,{cull:true,opaqueStates});
 const patched=patchLocalIndex(oldIndex,after,dirty,opaqueStates);
 const row=index=>index.chunks.flatMap(c=>cellsInChunk(c,60,59)).sort((a,b)=>a.k.localeCompare(b.k));
 assert.deepEqual(row(patched),row(full));
 assert.notDeepEqual(row(patched).find(c=>c.k==='15,59,15').fluid_corners,row(oldIndex).find(c=>c.k==='15,59,15').fluid_corners);
 const geometry=new THREE.BoxGeometry(),material=new THREE.MeshBasicMaterial();
 const renderer=new ChunkRenderer(new THREE.Scene(),()=>[{geometry,material}],[0,59,0]);
 try{
  renderer.reset(oldIndex,60,59);
  await renderer.update(24,24,100);
  const retained=renderer.loaded.get('0:0:2,2'),replaced=renderer.loaded.get('0:0:0,0');
  renderer.index=patched;
  const update=await renderer.update(24,24,100,36,{dirty,prepare(){
   assert.equal(renderer.loaded.get('0:0:0,0'),replaced);
  }});
  assert.deepEqual(update,{rebuilt_chunks:4,retained_chunks:1});
  assert.equal(renderer.loaded.get('0:0:2,2'),retained);
  assert.notEqual(renderer.loaded.get('0:0:0,0'),replaced);
 }finally{renderer.reset({chunks:[]},60,59);geometry.dispose();material.dispose();}
});
test('live window halo gives water edges the same height and hidden faces as the full world',()=>{
 const bounds=[0,58,0,3,60,3],blocks={},context={};for(let y=58;y<=60;y++)for(let z=0;z<4;z++)for(let x=0;x<4;x++)blocks[[x,y,z]]=y<=59?water:air;for(const p of contextPositions(bounds))context[p.join(',')]=p[1]<=59?water:air;
 const index=makeIndex({bounds,blocks,context_blocks:context},1,{cull:true}),cells=index.chunks.flatMap(c=>cellsInChunk(c,60,58)).filter(c=>c.p[1]===59);assert.ok(cells.length);for(const cell of cells){assert.ok(cell.fluid_corners.every(h=>Math.abs(h-8/9)<.0001));assert.equal(cell.fluid_mask,59);}
});
test('grass at a preview boundary does not acquire artificial vertical walls',()=>{
 const bounds=[0,59,0,0,59,0],context={};for(const p of contextPositions(bounds))context[p.join(',')]=p[1]<=59?grass:air;const index=makeIndex({bounds,blocks:{'0,59,0':grass},context_blocks:context},1,{cull:true,opaqueStates:new Set([grass])}),cell=cellsInChunk(index.chunks[0],59,59)[0];assert.equal(cell.mask,59);
});
test('context is bounded to legal coordinates and participates in immutable snapshot identity',()=>{
 const positions=contextPositions([0,-64,0,47,-1,47]);assert.ok(positions.every(p=>p[1]>=-64&&p[1]<=319));assert.equal(new Set(positions.map(p=>p.join(','))).size,positions.length);const base={minecraft:'1.20.1',world:'world',uuid:'test',bounds:[0,59,0,0,59,0],blocks:{'0,59,0':water}},a={...base,context_blocks:{'-1,59,0':water}},b={...base,context_blocks:{'-1,59,0':air}};assert.notEqual(snapshotBytes(a),snapshotBytes(b));assert.equal(snapshotBytes(a),snapshotBytes({...a,captured_at:'later'}));assert.deepEqual(draftContext(a.context_blocks,{'-1,59,0':water},{'-1,59,0':grass},true),{'-1,59,0':grass});
});
test('overhanging geometry is excluded by its owning block rather than cut through its visible shape',()=>{
 const world=new TexturedWorld(new THREE.Scene(),()=>{},()=>{}),state='minecraft:test',source=new THREE.BoxGeometry(2,1,1).translate(.5,.5,.5),material=new THREE.MeshLambertMaterial();world.prepared.set(JSON.stringify([state,0,0,undefined]),[{geometry:source,material}]);world.atlas={texture:new THREE.Texture(),rects:new Map(),white:{x:0,y:0,w:1,h:1},dimension:16};const encoded=(59+64)*1024+31,tile={x:-1,z:0,bounds:[-32,-64,0,0,320,32],groups:[{state,mask:0,fluid_mask:0,positions:[encoded]}]},group=world.bake(tile,[-32,-64,0]),mesh=group.children[0],p=mesh.geometry.getAttribute('position'),owners=mesh.geometry.getAttribute('blockOrigin');assert.ok(Array.from(p.array).some((n,i)=>i%3===0&&n>32));for(let i=0;i<owners.count;i++)assert.equal(owners.getX(i),31);const shader={uniforms:{},vertexShader:'#include <worldpos_vertex>',fragmentShader:'#include <dithering_fragment>'};mesh.material.onBeforeCompile(shader);assert.ok(shader.fragmentShader.includes('lessThan(owner,previewMax)'));assert.ok(!shader.fragmentShader.includes('vPreviewPosition'));world.dispose(group);for(const m of world.materials.values())m.dispose();world.atlas.texture.dispose();source.dispose();material.dispose();
});
