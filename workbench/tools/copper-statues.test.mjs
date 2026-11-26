import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildState} from '../model-terrain.js';

test('copper statues select the entity skin and pose for every facing, stage and wax state',async()=>{
 const makeMaterial=texture=>({texture});
 const readJson=async path=>{assert.fail('Statue preview needs the entity skin rather than '+path);};
 const facingAxis={north:[0,-1],east:[1,0],south:[0,1],west:[-1,0]};
 const center=(positions,part,axis)=>{
  const get=axis===0?'getX':'getZ';
  // A cuboid contributes 24 vertices, with each corner represented equally.
  let sum=0;
  for(let i=part*24;i<(part+1)*24;i++)sum+=positions[get](i);
  return sum/24;
 };
 for(const [minecraft,legacySkin] of [['1.21.9',true],['26.3',false]])
 for(const stage of ['','exposed','weathered','oxidized'])for(const waxed of ['', 'waxed_']){
  const poseShapes=new Set();
  for(const pose of ['standing','sitting','running','star'])for(const [facing,[x,z]] of Object.entries(facingAxis)){
   const block=waxed+(stage?stage+'_':'')+'copper_golem_statue';
   for(const waterlogged of [false,true]){
    const parts=await buildState(`minecraft:${block}[copper_golem_pose=${pose},facing=${facing},waterlogged=${waterlogged}]`,
     {minecraft,makeMaterial,readJson});
    const [{geometry,material},fluid]=parts;
    assert.equal(parts.length,waterlogged?2:1);
    if(waterlogged)assert.equal(fluid.material.texture,'block/water_still');
    const skin=stage?(legacySkin?stage+'_copper_golem':'copper_golem_'+stage):'copper_golem';
    assert.equal(material.texture,'entity/copper_golem/'+skin);
    geometry.computeBoundingBox();
    assert.ok(Math.abs(geometry.boundingBox.min.y)<1e-6);
    const vertices=geometry.getAttribute('position'),uv=geometry.getAttribute('uv');
    assert.ok(vertices.array.every(Number.isFinite));
    assert.ok(uv.array.every(n=>n>=0&&n<=1));
    const dx=center(vertices,2,0)-center(vertices,1,0),dz=center(vertices,2,2)-center(vertices,1,2);
    assert.ok(dx*x+dz*z>.29,`The ${pose} statue looks the wrong way when facing ${facing}`);
    if(facing==='north'&&!waterlogged)poseShapes.add(vertices.array.join(','));
    for(const part of parts)part.geometry.dispose();
   }
  }
  assert.equal(poseShapes.size,4);
 }
});
