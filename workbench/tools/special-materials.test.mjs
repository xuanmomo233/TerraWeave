import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as THREE from 'three';
import {buildState} from '../model-terrain.js';
import {specialModel} from '../special-models.js';

const makeMaterial=sprite=>({sprite});
function sprites(id,props,minecraft){
 const parts=specialModel(id,props,makeMaterial,undefined,minecraft);
 for(const part of parts)part.geometry.dispose();
 return parts.map(part=>part.material.sprite);
}

test('portal and banner sprite paths follow the resource layout from 26.1',()=>{
 for(const [version,portal,banner] of [
  ['1.20.1','entity/end_portal','entity/banner_base'],
  ['1.21.11','entity/end_portal','entity/banner_base'],
  ['26.1','entity/end_portal/end_portal','entity/banner/banner_base'],
  ['26.3','entity/end_portal/end_portal','entity/banner/banner_base']
 ]){
  assert.deepEqual(sprites('end_portal',{},version),[portal]);
  assert.deepEqual(sprites('end_gateway',{},version),[portal]);
  assert.equal(sprites('red_wall_banner',{facing:'north'},version)[0],banner);
 }
});

test('aged and waxed copper chests use the right sprite and join their double chest halves',()=>{
 for(const waxed of ['', 'waxed_'])for(const weather of ['', 'exposed', 'weathered', 'oxidized']){
  const id=waxed+(weather?weather+'_':'')+'copper_chest';
  const sprite='entity/chest/copper'+(weather?'_'+weather:'');
  for(const type of ['single','left','right']){
   const [part]=specialModel(id,{type,facing:'north'},makeMaterial,undefined,'1.21.9');
   assert.equal(part.material.sprite,sprite+(type==='single'?'':'_'+type));
   part.geometry.computeBoundingBox();
   const {min,max}=part.geometry.boundingBox;
   assert.equal(min.x,type==='right'?0:1/16);
   assert.equal(max.x,type==='left'?1:15/16);
   part.geometry.dispose();
  }
 }
});

test('baked bed models use the block sprites while older beds retain the entity sprite',async()=>{
 assert.equal(sprites('red_bed',{part:'head',facing:'north'},'26.1.2')[0],'entity/bed/red');
 for(const [id,minecraft] of [['red_bed','26.2'],['red_bed','26.3'],['straw_bed','26.3']]){
  const sprite='block/'+id+'_fixture';
  const model='minecraft:block/'+id+'_head';
  const files={
   ['/assets/minecraft/blockstates/'+id+'.json']:{variants:{'facing=north,part=head':{model}}},
   ['/assets/minecraft/models/block/'+id+'_head.json']:{textures:{all:'minecraft:'+sprite},
    elements:[{from:[0,0,0],to:[16,8,16],faces:{up:{texture:'#all'}}}]}
  };
  const parts=await buildState('minecraft:'+id+'[facing=north,part=head]',{
   minecraft,readJson:async url=>files[url],makeMaterial
  });
  assert.deepEqual(parts.map(part=>part.material.sprite),[sprite]);
  for(const part of parts)part.geometry.dispose();
 }
});

test('baked sign models retain their original sprite and transform text with both board faces',async()=>{
 assert.equal(sprites('oak_hanging_sign',{rotation:'3'},'26.1.2')[0],'block/oak_planks');
 const saved=globalThis.document;
 globalThis.document={createElement:()=>({getContext:()=>({fillText(){}})})};
 try{
  const id='oak_hanging_sign';
  const files={
   ['/assets/minecraft/blockstates/'+id+'.json']:{variants:{'':{model:'minecraft:block/sign_fixture',y:90}}},
   '/assets/minecraft/models/block/sign_fixture.json':{
    textures:{all:'minecraft:block/oak_hanging_sign'},
    elements:[{from:[1,0,7],to:[15,10,9],rotation:{origin:[8,0,8],x:180,y:-67.5,z:-180},
     faces:{south:{texture:'#all'},north:{texture:'#all'}}}]
   }
  };
  const side=(lines,color)=>({lines,color,glowing:false});
  const [model,front,back]=await buildState('minecraft:'+id,{
   minecraft:'26.3',readJson:async url=>files[url],makeMaterial,
   blockEntity:{front:side(['front zyx'],0),back:side(['back zyx'],1)}
  });
  assert.equal(model.material.sprite,'block/oak_hanging_sign');
  const position=(part,i)=>new THREE.Vector3().fromBufferAttribute(part.geometry.getAttribute('position'),i);
  const normal=(part,i)=>new THREE.Vector3().fromBufferAttribute(part.geometry.getAttribute('normal'),i);
  const expected=new THREE.Vector3(1/16,0,9/16).subScalar(.5);
  expected.y+=.5;
  expected.applyEuler(new THREE.Euler(Math.PI,-67.5*Math.PI/180,-Math.PI,'ZYX'));
  expected.x+=.5;expected.z+=.5;
  expected.subScalar(.5).applyAxisAngle(new THREE.Vector3(0,1,0),-Math.PI/2).addScalar(.5);
  assert.ok(position(model,0).distanceTo(expected)<1e-6);
  for(const [text,offset] of [[front,0],[back,4]]){
   assert.deepEqual([...text.geometry.getAttribute('uv').array],[0,0,1,0,1,1,0,1]);
   const perpendicular=normal(model,offset);
   assert.ok(normal(text,0).distanceTo(perpendicular)<1e-6);
   assert.ok(Math.abs(position(text,0).sub(position(model,offset)).dot(perpendicular)-.001)<1e-6);
  }
  for(const part of [model,front,back])part.geometry.dispose();
 }finally{
  if(saved===undefined)delete globalThis.document;else globalThis.document=saved;
 }
});
