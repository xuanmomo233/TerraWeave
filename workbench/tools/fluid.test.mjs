import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fluidGeometry} from '../fluid-geometry.js';
import {fluidCornerHeights} from './fluid-shape.mjs';
import {fullCubeOccluder} from './world-models.mjs';
test('continuous water shares corner heights and only exposes the outer surface',()=>{
 const read=(x,y,z)=>y===59?'minecraft:water[level=0]':'minecraft:air',corners=fluidCornerHeights(0,59,0,'water',read,()=>false),adjacent=fluidCornerHeights(1,59,0,'water',read,()=>false);assert.equal(corners[1],adjacent[0]);assert.equal(corners[2],adjacent[3]);assert.ok(corners.every(h=>Math.abs(h-8/9)<.0001));const surface=fluidGeometry(corners,63^(1<<2));assert.equal(surface.getAttribute('position').count,6);assert.ok([...surface.getAttribute('normal').array].every((n,i)=>Math.abs(n-(i%3===1?1:0))<1e-6));surface.dispose();
});
test('stacked water fills the upper boundary and flowing water has seamless shared corners',()=>{
 const stacked=(x,y,z)=>y===59||y===60?'minecraft:water[level=0]':'minecraft:air';assert.deepEqual(fluidCornerHeights(0,59,0,'water',stacked,()=>false),[1,1,1,1]);
 const flowing=(x,y,z)=>y===59?'minecraft:water[level='+(x<1?0:3)+']':'minecraft:air',a=fluidCornerHeights(0,59,0,'water',flowing,()=>false),b=fluidCornerHeights(1,59,0,'water',flowing,()=>false);assert.equal(a[1],b[0]);assert.equal(a[2],b[3]);
});
test('occlusion uses complete opaque model cubes and preserves partial or transparent blocks',()=>{
 assert.equal(fullCubeOccluder('minecraft:deepslate'),true);
 assert.equal(fullCubeOccluder('minecraft:deepslate[axis=x]'),true);
 assert.equal(fullCubeOccluder('minecraft:stone'),true);assert.equal(fullCubeOccluder('minecraft:grass_block[snowy=false]'),true);assert.equal(fullCubeOccluder('minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]'),false);assert.equal(fullCubeOccluder('minecraft:oak_leaves[distance=1,persistent=false,waterlogged=false]'),false);assert.equal(fullCubeOccluder('minecraft:barrier'),false);
});
