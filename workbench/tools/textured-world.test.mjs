import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as THREE from 'three';
import {TexturedWorld} from '../textured-world.js';
import {buildState,materialSettings} from '../model-terrain.js';

test('lily pads keep their tinted, cutout surface instead of a missing-model cube',async()=>{
 const face={texture:'#leaf',tintindex:0};
 const assets={
  '/assets/minecraft/blockstates/lily_pad.json':{variants:{'':{model:'minecraft:block/lily_pad'}}},
  '/assets/minecraft/models/block/lily_pad.json':{textures:{leaf:'minecraft:block/lily_pad'},
   elements:[{from:[0,.25,0],to:[16,.25,16],faces:{up:face,down:face}}]},
 };
 const parts=await buildState('minecraft:lily_pad',{
  readJson:async name=>assets[name],
  makeMaterial:(texture,id,tint)=>({texture,...materialSettings(id,tint)}),
 });
 assert.equal(parts.length,1);
 const [{geometry,material}]=parts;
 geometry.computeBoundingBox();
 assert.equal(geometry.boundingBox.min.y,.25/16);
 assert.equal(geometry.boundingBox.max.y,.25/16);
 assert.equal(geometry.index.count,12);
 assert.deepEqual(material,{texture:'block/lily_pad',color:0x208030,alphaTest:.1});
 geometry.dispose();
});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const info=revision=>({revision,occupied_chunks:[[0,0,0,15]],helper_chunks:[]});
const tile={x:0,z:0,groups:[{state:'minecraft:stone',mask:0,fluid_mask:0,positions:[0]}]};
class Harness extends TexturedWorld{
 constructor(call,material=new THREE.MeshBasicMaterial()){super(new THREE.Scene(),call,async()=>[{geometry:new THREE.BoxGeometry(),material}]);this.createdAtlases=[];this.createdGroups=[];}
 createAtlas(){const texture=new THREE.Texture(),atlas={texture};this.createdAtlases.push(atlas);return atlas;}
 bake(data,origin,resources){const group=new THREE.Group();group.userData={tile:data,origin};const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());group.add(mesh);this.createdGroups.push(group);(resources?.lookups??this.lookups).set('0,0',new Map([[0,'minecraft:stone']]));return group;}
}
test('cancel while textures load cannot create an orphan atlas or resurrect cleared geometry',async()=>{
 const gate=deferred(),waiting=deferred(),texture=new THREE.Texture();Object.defineProperty(texture.userData,'ready',{get(){waiting.resolve();return gate.promise;}});const world=new Harness(async()=>tile,new THREE.MeshBasicMaterial({map:texture}));await world.initialize(info('a'));world.enabled=true;const loading=world.update(0,0,10,[0,0,0],null);await waiting.promise;world.clear();world.enabled=false;gate.resolve();await loading;assert.equal(world.createdAtlases.length,0);assert.equal(world.atlas,null);assert.equal(world.meshes.size,0);assert.equal(world.lookups.size,0);
});
test('world revisions release old tile caches and late reads cannot repopulate stale revisions',async()=>{
 const gate=deferred(),world=new Harness(async args=>args),call=async(name,args)=>args.world_revision==='a'?gate.promise:tile;world.call=call;await world.initialize(info('a'));const pending=world.tile({key:'0,0',x:0,z:0});await world.initialize(info('b'));await world.tile({key:'0,0',x:0,z:0});gate.resolve(tile);await pending;assert.equal(world.cache.size,1);assert.deepEqual([...world.cache.keys()],['b:0,0']);
});
test('failed refresh retains the last complete scene and releases replacement resources',async()=>{
 let fail=false;const world=new Harness(async()=>{if(fail)throw Error('read failed');return tile;});await world.initialize(info('a'));world.enabled=true;await world.update(0,0,10,[0,0,0],null);const atlas=world.atlas,mesh=world.meshes.get('0,0');fail=true;await world.initialize(info('b'));await assert.rejects(world.update(0,0,10,[0,0,0],null),/read failed/);assert.equal(world.atlas,atlas);assert.equal(world.meshes.get('0,0'),mesh);assert.equal(world.scene.children.length,1);world.clear();
});
test('cancel during baking disposes staged GPU resources and leaves no stale lookups',async()=>{
 const baked=deferred(),world=new Harness(async()=>tile),originalBake=world.bake;world.bake=function(...args){const group=originalBake.apply(this,args);baked.resolve();return group;};await world.initialize(info('a'));world.enabled=true;const loading=world.update(0,0,10,[0,0,0],null);await baked.promise;let atlasDisposed=0,geometryDisposed=0;world.createdAtlases[0].texture.addEventListener('dispose',()=>atlasDisposed++);world.createdGroups[0].children[0].geometry.addEventListener('dispose',()=>geometryDisposed++);world.clear();world.enabled=false;await loading;assert.equal(atlasDisposed,1);assert.equal(geometryDisposed,1);assert.equal(world.atlas,null);assert.equal(world.scene.children.length,0);assert.equal(world.lookups.size,0);
});
test('concurrent scene initialization shares one read and tile cache stays bounded',async()=>{
 const gate=deferred();let reads=0;const world=new Harness(async name=>{if(name==='world_scene_info'){reads++;return gate.promise;}return tile;});const first=world.initialize(),second=world.initialize();assert.equal(reads,1);gate.resolve(info('shared'));await Promise.all([first,second]);for(let x=0;x<220;x++)await world.tile({x,z:0,key:x+',0'});assert.equal(world.cache.size,192);
});
test('late initial metadata cannot replace a newer explicitly supplied world revision',async()=>{
 const gate=deferred(),world=new Harness(async()=>gate.promise),initial=world.initialize();await world.initialize(info('newer'));gate.resolve(info('older'));await initial;assert.equal(world.info.revision,'newer');
});
test('a large world keeps the camera neighborhood and caps resident tile count',async()=>{
 const world=new Harness(async()=>tile);
 await world.initialize({revision:'large',bounds:[0,-64,0,23999,319,16],
  occupied_chunks:Array.from({length:1500},(_,x)=>[x,0,-64,240]),helper_chunks:[]});
 const start=world.wanted([0,80,0],[16,60,0],null,[0,0,0]);
 const end=world.wanted([23980,80,0],[23968,60,0],null,[0,0,0]);
 assert.equal(start.length,64);assert.equal(end.length,64);
 assert.ok(start.some(t=>t.x===0));assert.ok(end.some(t=>t.x===749));
 assert.equal(start.some(t=>t.x===749),false);
});
test('initial preview only reads the nearest requested tiles even when the target is far away',async()=>{
 const calls=[];
 const world=new Harness(async(name,{x,z})=>{calls.push([x,z]);return {...tile,x,z};});
 await world.initialize({revision:'preview',occupied_chunks:[[250,0],[8,0],[4,0],[0,0],[2,0]],helper_chunks:[]});
 world.enabled=true;
 await world.update(4000,16,4000,[0,0,0],null,[4,80,16],undefined,null,10000,2);
 assert.deepEqual(calls,[[0,0],[1,0]]);
 assert.equal(world.meshes.size,2);
});
