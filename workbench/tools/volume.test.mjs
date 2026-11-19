import assert from 'node:assert/strict';
import {test} from 'node:test';
import {greedyVolume,sectionIndices} from './world-volume.mjs';
import {sceneTileSelection,volumeGeometry} from '../volume-geometry.js';
import {documentKey} from '../editor-state.js';
import {buildState,materialSettings} from '../model-terrain.js';
import {decodeSurfaceChunk} from './world-surface.mjs';

function fixture(dims){const sx=dims[0]+2,sy=sx*(dims[2]+2),cells=new Uint32Array(sy*(dims[1]+2));return {cells,put(x,y,z,color=0x778899){cells[(y+1)*sy+(z+1)*sx+x+1]=color;}};}
test('volumetric greedy faces preserve hollow interiors and exposed undersides',()=>{
 const dims=[3,3,3],f=fixture(dims);for(let x=0;x<3;x++)for(let y=0;y<3;y++)for(let z=0;z<3;z++)if(x!==1||y!==1||z!==1)f.put(x,y,z);
 const faces=greedyVolume(f.cells,dims);assert.equal(faces.length,12);assert.equal(faces.reduce((n,q)=>n+q[4]*q[5],0),60);
 const roof=fixture([3,8,3]);for(let x=0;x<3;x++)for(let z=0;z<3;z++)roof.put(x,6,z);const floating=greedyVolume(roof.cells,[3,8,3],[-20,-64,-20]);assert.equal(floating.length,6);assert.ok(floating.some(q=>q[0]===2&&q[1]===-58));assert.ok(floating.some(q=>q[0]===3&&q[1]===-57));
});
test('volume halo removes shared faces and never emits an exterior neighbor as local geometry',()=>{
 const f=fixture([1,1,1]);f.put(0,0,0);f.put(-1,0,0);const faces=greedyVolume(f.cells,[1,1,1]);assert.equal(faces.length,5);assert.ok(!faces.some(q=>q[0]===0));const empty=fixture([1,1,1]);empty.put(-1,0,0);assert.deepEqual(greedyVolume(empty.cells,[1,1,1]),[]);
});
test('packed block palette indices decode across 32-bit boundaries',()=>{
 const palette=Array.from({length:17},(_,i)=>({Name:'test:'+i})),data=Array.from({length:Math.ceil(4096/12)},(_,n)=>{let value=0n;for(let i=0;i<12;i++)value|=BigInt((n*12+i)%17)<<BigInt(i*5);return value;});
 const ids=sectionIndices({block_states:{palette,data}});for(let i=0;i<4096;i++)assert.equal(ids[i],i%17);
});
test('scene LOD covers all occupied chunks without overlapping tile interiors',()=>{
 const occupied_chunks=[];for(let x=-24;x<24;x++)for(let z=-24;z<24;z++)occupied_chunks.push([x,z,32,80]);const info={occupied_chunks},tiles=sceneTileSelection(info,[0,300,0]);assert.ok(tiles.length<=96);
 const b=t=>{const s=64*2**t.level;return[t.x*s,t.z*s,(t.x+1)*s,(t.z+1)*s];};for(const [x,z]of occupied_chunks)assert.equal(tiles.filter(t=>{const a=b(t);return x*16>=a[0]&&x*16<a[2]&&z*16>=a[1]&&z*16<a[3];}).length,1);
 for(let i=0;i<tiles.length;i++)for(let j=i+1;j<tiles.length;j++){const a=b(tiles[i]),c=b(tiles[j]);assert.ok(a[2]<=c[0]||c[2]<=a[0]||a[3]<=c[1]||c[3]<=a[1]);}
 const distant=sceneTileSelection(info,[0,20000,0]);assert.ok(Math.max(...distant.map(t=>t.level))>Math.max(...tiles.map(t=>t.level)));
});
test('world-coordinate volume faces render relative to the scene origin with matching normals',()=>{
 const g=volumeGeometry({quads:[[3,200,-10,30,8,4,0x8899aa]]},[30,190,-10]);assert.equal(g.getAttribute('position').count,6);assert.equal(g.getAttribute('position').getY(0),10);assert.equal(g.getAttribute('normal').getY(0),1);g.dispose();assert.notEqual(documentKey({panorama:true,transient:true}),documentKey({transient:true}));
});
test('barriers stay invisible in scenery and use the imported icon only in helper mode',async()=>{
 assert.deepEqual(await buildState('minecraft:barrier'),[]);const requested=[],parts=await buildState('minecraft:barrier',{showInvisible:true,makeMaterial:(texture,id)=>{requested.push([texture,id]);return {};}});assert.deepEqual(requested,[['item/barrier','barrier']]);assert.equal(parts[0].geometry.getAttribute('position').count,4);assert.equal(materialSettings('barrier').transparent,true);parts[0].geometry.dispose();
 const heights=Array.from({length:37},()=>{let value=0n;for(let i=0;i<7;i++)value|=75n<<BigInt(i*9);return value;}),blocks=Array(256).fill(0n);for(let i=10*256;i<11*256;i++)blocks[Math.floor(i/16)]|=1n<<BigInt(i%16*4);
 const chunk=decodeSurfaceChunk({DataVersion:3465,Status:'minecraft:full',Heightmaps:{WORLD_SURFACE:heights},sections:[{Y:0,block_states:{palette:[{Name:'minecraft:stone'},{Name:'minecraft:barrier'}],data:blocks}}]});assert.equal(chunk.surface(2,3).state,'minecraft:barrier');assert.deepEqual(chunk.surface(2,3,true),{y:9,state:'minecraft:stone'});
});
