import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as THREE from 'three';
import {TexturedWorld} from '../textured-world.js';
import {OfflineIrisView} from '../offline-iris-view.js';
import {chooseRenderCapacity,DEFAULT_RENDER_CAPACITY} from '../render-capacity.js';
import {buildState,materialSettings,modelFaceTint} from '../model-terrain.js';
import {textureAnimation,textureFrame} from '../texture-animation.js';
import {blockEntityAppearance} from './block-entity-appearance.mjs';

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

test('an omitted axis uses the saved version default without losing explicit axes',async()=>{
 const face={texture:'#surface',cullface:'up'};
 const assets={
  '/assets/minecraft/blockstates/deepslate.json':{variants:{
   'axis=y':{model:'minecraft:block/default_axis'},
   'axis=x':{model:'minecraft:block/explicit_axis'},
  }},
  '/assets/minecraft/models/block/default_axis.json':{textures:{surface:'block/top'},elements:[{from:[0,0,0],to:[16,16,16],faces:{up:face}}]},
  '/assets/minecraft/models/block/explicit_axis.json':{textures:{surface:'block/side'},elements:[{from:[0,0,0],to:[16,16,16],faces:{up:face}}]},
 };
 const options={readJson:async name=>assets[name],makeMaterial:texture=>({texture})};
 for(const [state,texture] of [['deepslate','block/top'],['deepslate[axis=x]','block/side']]){
  const [{material,geometry}]=await buildState('minecraft:'+state,options);
  assert.equal(material.texture,texture);
  geometry.dispose();
 }
});

test('animation honors frame rectangles, listed order, duration and interpolation',()=>{
 const animation=textureAnimation(32,16,{width:16,height:16,frametime:4,frames:[1,{index:0,time:2}],interpolate:true});
 assert.equal(animation.columns,2);
 assert.deepEqual(textureFrame(animation,0),{index:1,next:0,mix:0});
 assert.deepEqual(textureFrame(animation,100),{index:1,next:0,mix:.5});
 assert.deepEqual(textureFrame(animation,200),{index:0,next:1,mix:0});
 assert.deepEqual(textureFrame(animation,300),{index:1,next:0,mix:0});
 assert.equal(textureAnimation(17,32,{width:16,height:16}),null);
 assert.equal(textureAnimation(16,32,null),null);
});

test('redstone and stems use state-dependent tint, while neutral tinted faces retain their textures',()=>{
 assert.equal(modelFaceTint('redstone_wire',{power:'0'},0),0x4c0000);
 assert.equal(modelFaceTint('redstone_wire',{power:'15'},0),0xff3200);
 assert.equal(modelFaceTint('pumpkin_stem',{age:'7'},0),0xe0c71c);
 assert.equal(modelFaceTint('attached_melon_stem',{},0),0xe0c71c);
 assert.ok(modelFaceTint('pink_petals',{},0));
 assert.equal(modelFaceTint('stonecutter',{},0),false);
});

test('placed pot sherds and moving-piston state survive Anvil appearance decoding',()=>{
 assert.deepEqual(blockEntityAppearance({id:'minecraft:decorated_pot',sherds:['minecraft:brick','minecraft:angler_pottery_sherd']}),
  {kind:'decorated_pot',sherds:[null,'angler']});
 assert.deepEqual(blockEntityAppearance({id:'minecraft:piston',blockState:{Name:'minecraft:oak_log',Properties:{axis:'x'}},progress:.5,extending:1}),
  {kind:'moving_piston',state:'minecraft:oak_log[axis=x]',progress:.5,extending:true});
});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const info=revision=>({revision,occupied_chunks:[[0,0,0,15]],helper_chunks:[]});
const tile={x:0,z:0,groups:[{state:'minecraft:stone',mask:0,fluid_mask:0,positions:[0]}]};
test('render capacity uses independent CPU and GPU limits and a conservative fallback',()=>{
 const profile=(ram,free,vram,unified=false)=>chooseRenderCapacity({system_total_mib:ram,system_available_mib:free,dedicated_mib:vram,unified});
 assert.equal(chooseRenderCapacity(),DEFAULT_RENDER_CAPACITY);
 assert.deepEqual(profile(8192,4096,null),DEFAULT_RENDER_CAPACITY);
 const tightGpu=profile(64*1024,28*1024,1024),tightRam=profile(8192,3072,24*1024);
 assert.ok(tightGpu.cpuTiles>tightRam.cpuTiles);
 assert.ok(tightGpu.maxVertices<tightRam.maxVertices);
 const powerful=profile(32*1024,16*1024,8192),shared=profile(32*1024,16*1024,8192,true);
 assert.ok(profile(16*1024,6*1024,null,null).maxVertices>DEFAULT_RENDER_CAPACITY.maxVertices);
 for(const key of Object.keys(DEFAULT_RENDER_CAPACITY))assert.ok(powerful[key]>DEFAULT_RENDER_CAPACITY[key],key);
 assert.ok(shared.maxVertices<powerful.maxVertices);
 for(const reserved of [256,8192]){
  const unknown=profile(32*1024,16*1024,reserved,null);
  assert.equal(unknown.cpuTiles,powerful.cpuTiles);
  assert.equal(unknown.maxVertices,DEFAULT_RENDER_CAPACITY.maxVertices);
 }
 assert.deepEqual(profile(512*1024,256*1024,96*1024),powerful);
 const scarce=profile(32*1024,1024,24*1024);
 assert.ok(scarce.cpuTiles<powerful.cpuTiles&&scarce.maxVertices<tightRam.maxVertices);
 const recovering={system_total_mib:32*1024,system_available_mib:1600,dedicated_mib:24*1024,unified:false};
 assert.deepEqual(chooseRenderCapacity(recovering,scarce),scarce);
 assert.deepEqual(chooseRenderCapacity({...recovering,system_available_mib:2048},scarce),DEFAULT_RENDER_CAPACITY);
 assert.equal(chooseRenderCapacity({},powerful),powerful);
});
class Harness extends TexturedWorld{
 constructor(call,material=new THREE.MeshBasicMaterial()){super(new THREE.Scene(),call,async()=>[{geometry:new THREE.BoxGeometry(),material}]);this.createdAtlases=[];this.createdGroups=[];}
 createAtlas(materials){const texture=new THREE.Texture(),rects=new Map(materials.filter(m=>m.map).map(m=>[m.map,{}])),atlas={texture,rects};this.createdAtlases.push(atlas);return atlas;}
 bake(data,origin,resources){const group=new THREE.Group();group.userData={tile:data,origin};const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());group.add(mesh);this.createdGroups.push(group);(resources?.lookups??this.lookups).set(data.x+','+data.z,new Map([[0,'minecraft:stone']]));return group;}
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

test('switches share compatible in-flight tile reads and a failed read can be retried',async()=>{
 const gate=deferred(),reads=[];
 const world=new Harness(async(name,args)=>{
  reads.push(args.visibility_key);
  return reads.length===1?gate.promise:{...tile,revision:args.visibility_key};
 });
 const t={key:'0,0',x:0,z:0},base={...info('a'),visibility_revision:'',visibility_tiles:{}};
 await world.initialize(base);
 const before=world.tile(t),otherView=world.tile(t);
 assert.deepEqual(reads,['']);
 await world.initialize({...base,visibility_revision:'hidden',visibility_tiles:{'0,0':'hidden'}});
 assert.equal((await world.tile(t)).revision,'hidden');
 gate.reject(Error('superseded read'));
 await Promise.all([assert.rejects(before,/superseded/),assert.rejects(otherView,/superseded/)]);
 await world.initialize(base);
 assert.equal((await world.tile(t)).revision,'');
 assert.deepEqual(reads,['','hidden','']);
});

test('restoring the visible scene during a pending hide releases progress immediately',async()=>{
 const gate=deferred(),started=deferred(),progress=[];
 const world=new Harness(async(name,args)=>{
  if(args.visibility_key){started.resolve();return gate.promise;}
  return tile;
 });
 const base={...info('palace'),visibility_revision:'',visibility_tiles:{}};
 const update=()=>world.update(0,0,1,[0,0,0],null);
 await world.initialize(base);world.enabled=true;await update();
 const original=world.meshes.get('0,0');
 world.progress=(done,total)=>progress.push([done,total]);
 await world.initialize({...base,visibility_revision:'hidden',visibility_tiles:{'0,0':'hidden'}});
 const pending=update();await started.promise;
 await world.initialize(base);
 assert.deepEqual(progress.at(-1),[0,0]);
 assert.equal(world.loading,null);
 assert.equal(world.allTilesResident,true);
 await update();
 gate.resolve({...tile,revision:'hidden'});await pending;
 assert.equal(world.meshes.get('0,0'),original);
 assert.deepEqual(progress.at(-1),[0,0]);
 assert.equal(world.bakedTiles,1);world.clear();
});

test('model preparation and revisiting vertex-budget candidates reuse cached work',async()=>{
 const gate=deferred(),started=deferred();
 let variants=0,parts=0;
 const world=new Harness(async(name,{x,z})=>({...tile,x,z}));
 world.chooseVariants=async(state,items)=>{variants++;return [{items}];};
 world.parts=async()=>{
  parts++;started.resolve();await gate.promise;
  return [{geometry:new THREE.BoxGeometry(),material:new THREE.MeshBasicMaterial()}];
 };
 const left={intersectsBox:box=>box.min.x===0},right={intersectsBox:box=>box.min.x===32};
 const update=frustum=>world.update(0,0,1,[0,0,0],null,[0,0,0],undefined,frustum,17);
 await world.initialize({revision:'same',occupied_chunks:[[0,0],[2,0]]});world.enabled=true;
 const first=update(left);await started.promise;gate.resolve();await first;
 await update(right);await update(left);
 assert.deepEqual([...world.meshes.keys()],['0,0']);
 assert.equal(variants,2);assert.equal(parts,1);assert.equal(world.bakedTiles,3);
 world.clear();
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
test('live capacity changes trim CPU data and reselect meshes under both vertex and tile budgets',async()=>{
 const world=new Harness(async(name,{x,z})=>({...tile,x,z}));
 await world.initialize({revision:'capacity',occupied_chunks:Array.from({length:12},(_,x)=>[2*x,0])});
 const update=()=>world.update(0,0,0,[0,0,0],null,[0,0,0],undefined,null,1e8,10000);
 world.enabled=true;await update();
 const first=world.meshes.get('0,0');assert.equal(world.allTilesResident,true);
 const smaller={cpuTiles:6,residentTiles:4,streamTiles:3,initialTiles:2,maxVertices:51};
 assert.equal(world.setCapacity(smaller),true);assert.equal(world.setCapacity({...smaller}),false);
 assert.equal(world.cache.size,6);assert.equal(world.allTilesResident,false);
 await update();
 assert.equal(world.meshes.size,3);assert.equal(world.loadedVertices,108);
 assert.equal(world.meshes.get('0,0'),first);
 assert.equal(world.setCapacity(DEFAULT_RENDER_CAPACITY),true);
 await update();assert.equal(world.allTilesResident,true);
 world.enabled=false;world.setCapacity(smaller);
 assert.equal(world.meshes.size,0);assert.equal(world.loadedVertices,0);assert.ok(world.cache.size<=6);
 world.clear();
});
test('a palace-sized background stays resident in a local editing window when the camera moves and turns',async()=>{
 let reads=0;
 const world=new Harness(async(name,{x,z})=>{reads++;return {...tile,x,z};});
 await world.initialize({revision:'palace',occupied_chunks:Array.from({length:130},(_,x)=>[x*2,0])});
 world.enabled=true;
 const origin=[0,0,0],cut=[0,0,0,16,16,16];
 await world.update(0,0,0,origin,cut);
 const meshes=world.meshes,atlas=world.atlas;
 await world.update(4100,0,0,origin,cut,[4100,100,0],undefined,{intersectsBox:box=>box.min.x>=4000});
 assert.equal(world.allTilesResident,true);
 assert.equal(world.meshes,meshes);
 assert.equal(world.atlas,atlas);
 assert.equal(world.createdGroups.length,130);
 assert.equal(reads,130);
 world.clear();
});
test('turning to a newly visible area keeps off-screen meshes when they still fit the budget',async()=>{
 const reads=[];
 const world=new Harness(async(name,{x,z})=>{reads.push(x);return {...tile,x,z};});
 await world.initialize({revision:'large',occupied_chunks:Array.from({length:420},(_,x)=>[x*2,0])});
 world.enabled=true;
 const origin=[0,0,0],eye=[0,80,0],first={intersectsBox:box=>box.min.x===0},turned={intersectsBox:box=>box.min.x===3200};
 await world.update(0,0,0,origin,null,eye,undefined,first);
 assert.equal(world.meshes.size,64);
 const seen=world.meshes.get('0,0'),atlas=world.atlas;
 await world.update(3200,0,0,origin,null,eye,undefined,turned);
 const revealed=world.meshes.get('100,0');
 assert.ok(revealed);
 assert.equal(world.meshes.size,65);
 await world.update(0,0,0,origin,null,eye,undefined,first);
 assert.equal(world.meshes.get('0,0'),seen);
 assert.equal(world.meshes.get('100,0'),revealed);
 assert.equal(world.atlas,atlas);
 assert.equal(world.bakedTiles,65);
 assert.equal(reads.length,65);
 world.clear();
});
test('a preview index cannot be mistaken for a complete scene with different tiles',async()=>{
 const world=new Harness(async(name,{x,z})=>({...tile,x,z}));
 await world.initialize({...info('same-revision'),preview_index:true});
 world.enabled=true;
 await world.update(0,0,0,[0,0,0],null);
 await world.initialize({revision:'same-revision',occupied_chunks:[[2,0]]});
 assert.equal(world.allTilesResident,false);
 await world.update(0,0,0,[0,0,0],null);
 assert.equal(world.allTilesResident,true);
 assert.deepEqual([...world.meshes.keys()],['1,0']);
 world.clear();
});
test('streaming prioritizes visible tiles and retains shared meshes and their block lookups',async()=>{
 const calls=[];
 const world=new Harness(async(name,{x,z})=>{calls.push(x);return {...tile,x,z};});
 await world.initialize({revision:'streamed',occupied_chunks:[[0,0],[2,0],[20,0]]});
 world.enabled=true;
 const origin=[0,0,0],first={intersectsBox:box=>box.min.x<64},turned={intersectsBox:box=>box.min.x>=32};
 await world.update(0,0,0,origin,null,[0,80,0],undefined,first,10000,2);
 const atlas=world.atlas,retained=world.meshes.get('1,0'),lookup=world.lookups.get('1,0');
 await world.update(320,0,0,origin,null,[0,80,0],undefined,turned,10000,2);
 assert.deepEqual([...world.meshes.keys()].sort(),['1,0','10,0']);
 assert.deepEqual(calls,[0,1,10]);
 assert.equal(world.createdGroups.length,3);
 assert.equal(world.atlas,atlas);
 assert.equal(world.meshes.get('1,0'),retained);
 assert.equal(world.lookups.get('1,0'),lookup);
 assert.equal(world.stateAt(32,-64,0),'minecraft:stone');
 world.clear();
});
test('a vertex-limited scene can swap the visible tile without a change in candidate membership',async()=>{
 const world=new Harness(async(name,{x,z})=>({...tile,x,z}));
 await world.initialize({revision:'limited',occupied_chunks:[[0,0],[2,0]]});
 world.enabled=true;
 const origin=[0,0,0],left={intersectsBox:box=>box.min.x<32},right={intersectsBox:box=>box.min.x>=32};
 await world.update(0,0,0,origin,null,[0,80,0],undefined,left,17);
 assert.deepEqual([...world.meshes.keys()],['0,0']);
 const candidateKey=world.signature;
 assert.equal(world.coverageKey,'0,0');
 await world.update(0,0,0,origin,null,[0,80,0],undefined,right,17);
 assert.deepEqual([...world.meshes.keys()],['1,0']);
 assert.equal(world.signature,candidateKey);
 assert.equal(world.coverageKey,'1,0');
 assert.equal(world.loadedVertices,36);
 assert.equal(world.omittedTiles,1);
 world.clear();
});

test('complete captures retain all visible tiles even when only one fits in memory at a time',async()=>{
 const world=new Harness(async(name,{x,z})=>({...tile,x,z}));
 world.setCapacity({...DEFAULT_RENDER_CAPACITY,maxVertices:17});
 await world.initialize({revision:'capture',occupied_chunks:[[0,0],[2,0],[4,0],[6,0]]});
 const origin=[0,0,0],frustum={intersectsBox:box=>box.min.x<96};
 const entries=await world.prepareCapture(origin,[frustum]);
 const drawn=[];
 for(const batch of world.captureBatches(entries)){
  assert.equal(batch.length,1);
  await world.withCaptureBatch(batch,origin,async()=>{
   await Promise.resolve();
   assert.equal(world.scene.children.length,1);
   drawn.push(...world.meshes.keys());
  });
  assert.equal(world.scene.children.length,0);
 }
 assert.deepEqual(drawn,['0,0','1,0','2,0']);
 world.clear();
});

test('Iris ignores a parked background and cannot present a late frame after switching documents',async t=>{
 const started=deferred(),finish=deferred(),requests=[],failed=[];
 const inputs={pack:{shadow_distance:8,sun_path_rotation:0},world:{world_uuid:'new',environment_revision:'day',day_time:0,chunks:[]}};
 const previous=globalThis.window;
 globalThis.window={__TAURI_INTERNALS__:{invoke:async(command,args)=>{
  if(command==='workbench_call'){requests.push(args);return inputs;}
  assert.equal(command,'iris_draw');assert.equal(args.frame.eye_in_water,0);
  started.resolve();return finish.promise;
 }}};
 t.after(()=>{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;});
 const iris=Object.assign(Object.create(OfflineIrisView.prototype),{shader:'sky.zip',canvas:{hidden:true},error:{},key:'local::day',
  say:error=>failed.push(error),atlas:{texture:{version:0},animate(){}},atlasVersion:0,start:0});
 const data={key:'local',region:{world_uuid:'new',environment_revision:'day'},camera:new THREE.PerspectiveCamera(),
  width:4,height:4,snapshot:{bounds:[0,0,0,15,15,15],blocks:{}},chunks:{meshes:()=>[{}]},
  lod:{enabled:false,coverageKey:'9,9',info:{revision:'old-world',environment_revision:'old-night'},stateAt:()=>assert.fail('Parked block lookup')}};
 iris.show(data);await started.promise;
 assert.equal(requests[0].args.environment_revision,'day');
 assert.equal(requests[0].args.revision,undefined);
 iris.setView(null);finish.resolve(new Uint8Array(64));await iris.pending;
 assert.equal(iris.canvas.hidden,true);assert.equal(iris.presented,null);assert.deepEqual(failed,[]);
});

test('a superseded shader failure cannot suppress a queued new view',async()=>{
 const gate=deferred(),shown=[],errors=[];
 const iris=Object.assign(Object.create(OfflineIrisView.prototype),{shader:'sky.zip',canvas:{hidden:false},error:{},say:text=>errors.push(text),
  draw:async(data,{current})=>{shown.push(data.key);if(data.key==='first')await gate.promise;assert.ok(current());}});
 const data={lod:{enabled:true,meshes:new Map([['0,0',{}]])},region:{panorama:true}};
 iris.show({...data,key:'first'});const first=iris.pending;
 iris.show({...data,key:'second'});gate.reject(Error('Old request'));await first;await iris.pending;
 assert.deepEqual(shown,['first','second']);assert.deepEqual(errors,[]);
});
test('changing construction visibility only replaces affected model tiles',async()=>{
 const reads=[];
 const world=new Harness(async(name,{x,z,visibility_key})=>{reads.push([x,visibility_key]);return {...tile,x,z};});
 const metadata={revision:'construction',occupied_chunks:[[0,0],[2,0]],visibility_revision:'',visibility_tiles:{}};
 await world.initialize(metadata);
 world.enabled=true;
 await world.update(0,0,0,[0,0,0],null);
 const unaffected=world.meshes.get('1,0'),old=world.meshes.get('0,0');
 await world.initialize({...metadata,visibility_revision:'hidden',visibility_tiles:{'0,0':'changed'}});
 assert.equal(world.allTilesResident,false);
 await world.update(0,0,0,[0,0,0],null);
 assert.equal(world.meshes.get('1,0'),unaffected);
 assert.notEqual(world.meshes.get('0,0'),old);
 assert.deepEqual(reads,[[0,''],[1,''],[0,'changed']]);
 await world.initialize(metadata);
 await world.update(0,0,0,[0,0,0],null);
 assert.equal(world.meshes.get('1,0'),unaffected);
 assert.equal(reads.length,3);
 world.clear();
});

test('unchanged exposed faces retain their mesh, lookup and updated capture metadata',async()=>{
 const progress=[],reads=[];
 const world=new Harness(async(name,{x,z,visibility_key})=>{
  reads.push(x);
  return {...tile,x,z,revision:visibility_key||'base',render_hash:x===0?'roof-'+visibility_key:'unchanged'};
 });
 const base={revision:'palace',occupied_chunks:[[0,0],[2,0],[4,0]],visibility_revision:'',visibility_tiles:{}};
 const update=()=>world.update(0,0,1,[0,0,0],null);
 await world.initialize(base);world.enabled=true;await update();
 const shared=world.meshes.get('1,0'),lookup=world.lookups.get('1,0'),distant=world.meshes.get('2,0');
 world.progress=(done,total)=>progress.push([done,total]);
 await world.initialize({...base,visibility_revision:'hidden',visibility_tiles:{'0,0':'hidden','1,0':'border'}});
 await update();
 assert.equal(world.meshes.get('1,0'),shared);
 assert.equal(world.lookups.get('1,0'),lookup);
 assert.equal(shared.children[0].userData.tile.revision,'border');
 assert.equal(world.meshes.get('2,0'),distant);
 assert.deepEqual(reads,[0,1,2,0,1]);
 assert.deepEqual(world.lastUpdate,{candidates:2,reads:2,rebuilt:1,retained:2,atlas_replaced:false});
 assert.deepEqual(progress[0],[0,4]);
 await world.initialize(base);await update();
 assert.equal(world.lastUpdate.reads,0);
 assert.equal(world.lastUpdate.rebuilt,1);
 world.clear();
});
