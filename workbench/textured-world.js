import * as THREE from 'three';
import {awaitTextures} from './model-terrain.js';
import {updateAnimatedTexture} from './texture-animation.js';
import {DEFAULT_RENDER_CAPACITY} from './render-capacity.js';
import {compactBlockLookup,compactModelBytes,compactWorldMesh,coordinateOf,indexCount,vertexCount} from './compact-world-mesh.js';

export function createTextureAtlas(materials,previous){
  const maps=[...new Set([...materials].map(m=>m.map).filter(Boolean))];
  const tileSize=2**Math.ceil(Math.log2(Math.max(16,...maps.map(m=>Math.max(m.image.width,m.image.height)))));
  const slots=new Map(),used=new Set([0]);
  for(const map of maps){
   const slot=previous?.rects.get(map)?.slot;
   if(slot!==undefined){slots.set(map,slot);used.add(slot);}
  }
  const capacity=Math.max(maps.length+1,...[...used].map(slot=>slot+1));
  const columns=2**Math.ceil(Math.log2(Math.sqrt(capacity))),dimension=columns*tileSize;
  const canvas=document.createElement('canvas');canvas.width=canvas.height=dimension;
  const c=canvas.getContext('2d');c.imageSmoothingEnabled=false;c.fillStyle='#ffffff';c.fillRect(0,0,tileSize,tileSize);
  const rects=new Map(),animated=[];
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  texture.magFilter=THREE.NearestFilter;texture.minFilter=THREE.NearestMipmapLinearFilter;texture.generateMipmaps=true;
  function draw(map,x,y){c.clearRect(x,y,tileSize,tileSize);c.drawImage(map.image,x,y,tileSize,tileSize);}
  let nextSlot=1;
  function extend(sourceMaps){
   const missing=[...new Set(sourceMaps.filter(map=>map&&!rects.has(map)))];
   if(rects.size+missing.length>=columns*columns||missing.some(map=>Math.max(map.image.width,map.image.height)>tileSize))return false;
   for(const map of missing){
    while(used.has(nextSlot))nextSlot++;
    const slot=slots.get(map)??nextSlot,x=slot%columns*tileSize,y=Math.floor(slot/columns)*tileSize;
    used.add(slot);
    draw(map,x,y);rects.set(map,{slot,x:x+.5,y:y+.5,w:tileSize-1,h:tileSize-1});
    if(map.userData.animation)animated.push({map,x,y,version:map.version});
   }
   if(missing.length)texture.needsUpdate=true;
   return true;
  }
  extend(maps);
  function animate(now){
   let changed=false;
   for(const entry of animated){
    updateAnimatedTexture(entry.map,now);
    if(entry.version===entry.map.version)continue;
    draw(entry.map,entry.x,entry.y);entry.version=entry.map.version;changed=true;
   }
   if(changed)texture.needsUpdate=true;
   return changed;
  }
  return {texture,canvas,rects,dimension,tileSize,animate,extend,white:{slot:0,x:.5,y:.5,w:tileSize-1,h:tileSize-1}};
}

function atlasMipSampling(shader,atlas){
 Object.assign(shader.uniforms,{atlasDimension:{value:atlas.dimension},atlasTileSize:{value:atlas.tileSize},atlasLastTileMip:{value:Math.log2(atlas.tileSize)}});
 // Keep source UVs and a stable texture slot in the mesh, including across atlas repacks.
 shader.vertexShader='attribute float atlasSlot; uniform float atlasDimension; uniform float atlasTileSize;\n'+shader.vertexShader;
 shader.vertexShader=shader.vertexShader.replace('#include <uv_vertex>',`#include <uv_vertex>
 float columns = atlasDimension / atlasTileSize;
 vec2 cell = vec2(mod(atlasSlot,columns),floor(atlasSlot/columns)) * atlasTileSize;
 vec2 texel = cell + vec2(0.5) + vec2(uv.x,1.0-uv.y) * (atlasTileSize-1.0);
 vMapUv = vec2(texel.x/atlasDimension,1.0-texel.y/atlasDimension);
 #ifdef USE_EMISSIVEMAP
 vEmissiveMapUv = vMapUv;
 #endif`);
 // Power-of-two cells stay independent down to one texel per material.
 shader.fragmentShader=`
uniform float atlasDimension;
uniform float atlasLastTileMip;
vec4 sampleAtlas(sampler2D image, vec2 uv) {
 float footprint = max(length(dFdx(uv)), length(dFdy(uv))) * atlasDimension;
 float mip = min(log2(max(footprint, 1.0)), atlasLastTileMip);
 return textureLod(image, uv, mip);
}
`+shader.fragmentShader;
 shader.fragmentShader=shader.fragmentShader
  .replace('#include <map_fragment>',THREE.ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )','sampleAtlas( map, vMapUv )'))
  .replace('#include <emissivemap_fragment>',THREE.ShaderChunk.emissivemap_fragment.replace('texture2D( emissiveMap, vEmissiveMapUv )','sampleAtlas( emissiveMap, vEmissiveMapUv )'));
}

const BAKE_SLICE_MS=8;
// Charge compact buffers against the same byte allowance as the expanded mesh.
const EXPANDED_VERTEX_BYTES=58;
export const MAX_SCENE_VERTICES=DEFAULT_RENDER_CAPACITY.maxVertices;
const helper=s=>/^minecraft:(barrier|structure_void|light)(\[|$)/.test(s);
export const modelGroupKey=(g,minecraft)=>JSON.stringify([minecraft,g.state,g.mask,g.fluid_mask,g.fluid_corners,g.block_entity,g.variantIndices]);
const keyFor=modelGroupKey;
export class TexturedWorld{
 capacity=DEFAULT_RENDER_CAPACITY;
 loadedCost=0;
 coverageKey='';
 pendingTiles=new Map();
 pendingParts=new Map();
 preparedTiles=new WeakMap();
 constructor(scene,call,parts,progress=()=>{},chooseVariants){this.scene=scene;this.call=call;this.parts=parts;this.progress=progress;this.chooseVariants=chooseVariants;this.meshes=new Map();this.cache=new Map();this.prepared=new Map();this.lookups=new Map();this.enabled=false;this.showInvisible=false;this.info=null;this.signature='';this.generation=0;this.bakedTiles=0;this.tileReads=0;this.loading=null;this.atlas=null;this.materials=new Map();this.markerMaterial=new THREE.PointsMaterial({size:1.1,transparent:true,alphaTest:.1,depthWrite:false});this.uniforms={active:{value:false},min:{value:new THREE.Vector3()},max:{value:new THREE.Vector3()}};}
 async initialize(info){
  const generation=this.generation;
  if(!info){
   if(!this.infoRequest)this.infoRequest=this.call('world_scene_info',{preview:true}).finally(()=>this.infoRequest=null);
   info=await this.infoRequest;
   if(generation!==this.generation&&this.info)return this.info;
  }
  if(this.info?.revision!==info.revision){
   this.cancelUpdate();this.cache.clear();this.signature='';
  }else if(this.info?.visibility_revision!==info.visibility_revision||this.info?.preview_index&&!info.preview_index)this.cancelUpdate();
  this.info=info;this.tiles=this.indexTiles(info);this.completeResidency=undefined;return this.info;
 }
 cancelUpdate(){
  this.generation++;
  if(this.loading){this.loading=null;this.loadingSignature='';this.progress(0,0);}
 }
 setCapacity(capacity){
  const previous=this.capacity;
  if(Object.keys(DEFAULT_RENDER_CAPACITY).every(key=>previous[key]===capacity[key]))return false;
  this.capacity=capacity;
  this.trimTileCache();
  if(previous.residentTiles!==capacity.residentTiles||previous.streamTiles!==capacity.streamTiles||previous.maxVertices!==capacity.maxVertices){
   if(!this.enabled&&(this.meshes.size>capacity.residentTiles||this.loadedCost>capacity.maxVertices))this.clear();
   else this.cancelUpdate();
   this.capacityDirty=true;
  }
  return true;
 }
 trimTileCache(){while(this.cache.size>this.capacity.cpuTiles)this.cache.delete(this.cache.keys().next().value);}
 setShowInvisible(value,map){this.showInvisible=value;if(map&&this.markerMaterial.map!==map){this.markerMaterial.map=map;this.markerMaterial.needsUpdate=true;}for(const group of this.meshes.values())for(const child of group.children)if(child.isPoints)child.visible=value;}
 dispose(group){for(const child of group.children)child.geometry.dispose();}
 clear(){this.cancelUpdate();for(const group of this.meshes.values()){this.scene.remove(group);this.dispose(group);}this.meshes.clear();this.lookups.clear();for(const mat of this.materials.values())mat.dispose();this.materials.clear();this.atlas?.texture.dispose();this.atlas=null;this.signature='';this.coverageKey='';this.residentRevision=undefined;this.completeResidency=undefined;this.loadedVertices=0;this.loadedCost=0;this.omittedTiles=0;this.lastUpdate=undefined;}
 rebase(origin,bounds){this.origin=[...origin];this.cutBounds=bounds;for(const group of this.meshes.values())group.position.set(...group.userData.origin.map((n,i)=>n-origin[i]));this.uniforms.active.value=!!bounds;if(bounds){this.uniforms.min.value.set(...bounds.slice(0,3).map((n,i)=>n-origin[i]));this.uniforms.max.value.set(...bounds.slice(3).map((n,i)=>n+1-origin[i]));}}
 indexTiles(info){
  const result=new Map(),world=info.bounds??[-64,-64,-64,63,319,63];
  for(const [cx,cz,y0,y1] of [...info.occupied_chunks,...(info.helper_chunks??[])]){
   const x=Math.floor(cx/2),z=Math.floor(cz/2),key=x+','+z,old=result.get(key);
   result.set(key,{x,z,key,min_y:Math.min(old?.min_y??Infinity,y0??world[1]),max_y:Math.max(old?.max_y??-Infinity,y1??world[4])});
  }
  return [...result.values()];
 }
 get allTilesResident(){
  if(this.capacityDirty||!this.info||this.info.preview_index||this.residentRevision!==this.info.revision||this.meshes.size!==this.tiles.length)return false;
  return this.completeResidency??=this.tiles.every(tile=>this.hasCurrentTile(tile.key));
 }
 visibilityKey(key){return this.info?.visibility_tiles?.[key]??'';}
 hasCurrentTile(key){const group=this.meshes.get(key);return !!group&&(group.userData.visibility_key??'')===this.visibilityKey(key);}
 tileBox(tile,origin,box=new THREE.Box3()){
  const x=tile.x*32-origin[0],z=tile.z*32-origin[2];
  box.min.set(x,tile.min_y-origin[1],z);
  box.max.set(x+32,tile.max_y+1-origin[1],z+32);
  return box;
 }
 wanted(eye,target,frustum,origin,limit=this.capacity.streamTiles,keepResidents=false){
  limit=Math.min(limit,this.capacity.residentTiles);
  const box=new THREE.Box3();
  const ranked=this.tiles.map(tile=>{
   const x=tile.x*32,z=tile.z*32;
   const distance=(p)=>Math.hypot(Math.max(0,x-p[0],p[0]-x-32),Math.max(0,z-p[2],p[2]-z-32));
   const near=distance(eye);
   const visible=frustum?.intersectsBox(this.tileBox(tile,origin,box));
   const retained=this.residentRevision===this.info.revision&&this.meshes.has(tile.key);
   // Only newly visible tiles can displace residents. Nearby unseen tiles fill spare capacity.
   const priority=visible?0:keepResidents&&retained?1:near<=128?2:3;
   const score=(near<=128?near:Math.min(near,distance(target)))-(retained?16:0);
   return {tile,priority,score,retained};
  });
  ranked.sort((a,b)=>a.priority-b.priority||a.score-b.score||a.tile.x-b.tile.x||a.tile.z-b.tile.z);
  const wanted=ranked.slice(0,limit);
  if(keepResidents)wanted.push(...ranked.slice(limit).filter(entry=>entry.retained).slice(0,this.capacity.residentTiles-wanted.length));
  return wanted.map(entry=>entry.tile);
 }
 tileResources(tile){
  let vertices=0,bytes=0;
  const materials=new Set();
  for(const group of tile.groups){
   bytes+=group.positions.length*(group.state==='minecraft:barrier'?16:4);
   for(const part of this.prepared.get(keyFor(group,tile.minecraft))??[]){
    vertices+=group.positions.length*indexCount(part.geometry);
    bytes+=group.positions.length*compactModelBytes(part.geometry);
    materials.add(part.material);
   }
  }
  return {vertices,cost:Math.ceil(bytes/EXPANDED_VERTEX_BYTES),materials:[...materials]};
 }
 async tile(t,onRead){
  const {revision,visibility_revision}=this.info,visible=this.visibilityKey(t.key),key=revision+':'+t.key+(visible?':'+visible:'');
  if(this.cache.has(key)){const data=this.cache.get(key);this.cache.delete(key);this.cache.set(key,data);return data;}
  if(this.pendingTiles.has(key))return this.pendingTiles.get(key);
  onRead?.();
  this.tileReads++;
  const pending=this.call('world_model_tile',{x:t.x,z:t.z,world_revision:revision,...(visibility_revision!==undefined?{visibility_key:visible}:{})});
  this.pendingTiles.set(key,pending);
  try{
   const data=await pending;
   if(this.info?.revision===revision&&this.visibilityKey(t.key)===visible){
    this.cache.set(key,data);this.trimTileCache();
   }
   return data;
  }finally{
   this.pendingTiles.delete(key);
  }
 }
 async prepare(data,current=()=>true){
  const groups=[],position=n=>[n%32+data.bounds[0],Math.floor(n/1024)-64,Math.floor(n/32)%32+data.bounds[2]];
  for(const g of data.groups){
   if(!current())return;
   if(helper(g.state)){groups.push(g);continue;}
   const choices=this.chooseVariants?await this.chooseVariants(g.state,g.positions,position,data.minecraft):[{items:g.positions}];
   for(const {indices,items} of choices){
    if(!current())return;
    const chosen=indices?{...g,positions:items,variantIndices:indices}:g,key=keyFor(chosen,data.minecraft);
    if(!this.prepared.has(key)){
     let pending=this.pendingParts.get(key);
     if(!pending){
      pending=Promise.resolve(this.parts(g.state,{minecraft:data.minecraft,occlusionMask:g.mask,fluidMask:g.fluid_mask,fluidCorners:g.fluid_corners,blockEntity:g.block_entity,variantIndices:indices}))
       .then(parts=>this.prepared.set(key,parts)).finally(()=>this.pendingParts.delete(key));
      this.pendingParts.set(key,pending);
     }
     await pending;
    }
    groups.push(chosen);
   }
  }
  return {...data,groups};
 }
 async prepareTile(raw,current){
  let result=this.preparedTiles.get(raw);
  if(!result){
   const tile=await this.prepare(raw,current);
   if(!tile)return;
   result={tile,profile:this.tileResources(tile)};
   this.preparedTiles.set(raw,result);
  }
  return result;
 }
 async prepareCapture(origin,frusta){
  const box=new THREE.Box3();
  const candidates=this.tiles.filter(tile=>frusta.some(frustum=>frustum.intersectsBox(this.tileBox(tile,origin,box))));
  const entries=new Array(candidates.length);
  let cursor=0;
  const load=async()=>{
   while(cursor<candidates.length){
    const i=cursor++,tile=candidates[i];
    entries[i]=await this.prepareTile(await this.tile(tile));
   }
  };
  const completed=await Promise.allSettled([load(),load(),load(),load()]);
  const failed=completed.find(result=>result.status==='rejected');
  if(failed)throw failed.reason;
  const materials=[...new Set(entries.flatMap(({profile})=>profile.materials))];
  await awaitTextures(materials);
  this.atlas=this.createAtlas(materials);
  return entries;
 }
 *captureBatches(entries){
  let batch=[],cost=0;
  for(const entry of entries){
   if(batch.length&&(cost+entry.profile.cost>this.capacity.maxVertices||batch.length>=this.capacity.residentTiles)){
    yield batch;
    batch=[];cost=0;
   }
   // A single exact tile is indivisible here and must still be drawn.
   batch.push(entry);
   cost+=entry.profile.cost;
  }
  if(batch.length)yield batch;
 }
 async withCaptureBatch(batch,origin,draw,pass){
  const groups=[];
  try{
   for(const {tile} of batch){
    const group=this.bake(tile,origin,this,pass);
    groups.push(group);
    this.meshes.set(tile.x+','+tile.z,group);
    this.scene.add(group);
   }
   this.coverageKey=[...this.meshes.keys()].sort().join('|');
   return await draw(groups);
  }finally{
   for(const group of groups){this.scene.remove(group);this.dispose(group);}
   this.meshes.clear();
  }
 }
 createAtlas(materials,previous){return createTextureAtlas(materials,previous);}
 style(material){
  return JSON.stringify([material.transparent??false,material.opacity??1,material.side??0,material.wireframe??false,
   material.emissiveIntensity??0,material.emissive?.getHex()??0,material.alphaTest??.1,material.depthWrite??true,
   material.isMeshBasicMaterial??false,material.polygonOffset??false,material.polygonOffsetFactor??0,material.polygonOffsetUnits??0]);
 }
 atlasMaterial(source,resources=this){
  const key=this.style(source);
  if(resources.materials.has(key))return resources.materials.get(key);
  const atlas=resources.atlas;
  const Material=source.isMeshBasicMaterial?THREE.MeshBasicMaterial:THREE.MeshLambertMaterial;
  const m=new Material({map:atlas.texture,vertexColors:true,alphaTest:source.alphaTest??.1,
   transparent:source.transparent??false,opacity:source.opacity??1,depthWrite:source.depthWrite??true,
   side:source.side??THREE.FrontSide,wireframe:source.wireframe??false,polygonOffset:source.polygonOffset??false,
   polygonOffsetFactor:source.polygonOffsetFactor??0,polygonOffsetUnits:source.polygonOffsetUnits??0});
  if(source.emissive?.getHex()){m.emissive.copy(source.emissive);m.emissiveIntensity=source.emissiveIntensity;m.emissiveMap=atlas.texture;}
  m.onBeforeCompile=shader=>{
   Object.assign(shader.uniforms,{previewCut:this.uniforms.active,previewMin:this.uniforms.min,previewMax:this.uniforms.max});
   shader.vertexShader='attribute float blockOwner;varying vec3 vPreviewOwner;\n'+shader.vertexShader;
   shader.vertexShader=shader.vertexShader.replace('#include <worldpos_vertex>','#include <worldpos_vertex>\nvPreviewOwner=(modelMatrix*vec4(mod(blockOwner,32.0),floor(blockOwner/1024.0)-64.0,mod(floor(blockOwner/32.0),32.0),1.0)).xyz;');
   shader.fragmentShader='varying vec3 vPreviewOwner;uniform bool previewCut;uniform vec3 previewMin;uniform vec3 previewMax;\n'+shader.fragmentShader;
   shader.fragmentShader=shader.fragmentShader.replace('#include <dithering_fragment>','vec3 owner=floor(vPreviewOwner+vec3(0.5));if(previewCut&&all(greaterThanEqual(owner,previewMin))&&all(lessThan(owner,previewMax)))discard;\n#include <dithering_fragment>');
   atlasMipSampling(shader,atlas);
  };
  resources.materials.set(key,m);
  return m;
 }
 bake(tile,origin,resources=this,pass){
  const {atlas}=resources,buckets=new Map(),markers=[];
  for(const g of tile.groups){
   if(helper(g.state)){
    if(pass!=='opaque'&&g.state==='minecraft:barrier')for(const p of g.positions)markers.push(...coordinateOf(p).map(n=>n+.5));
    continue;
   }
   for(const part of this.prepared.get(keyFor(g,tile.minecraft))??[]){
    if(pass&&!!part.material.transparent!==(pass==='transparent'))continue;
    const key=this.style(part.material);
    if(!buckets.has(key))buckets.set(key,{source:part.material,items:[],vertices:0,indices:0});
    const bucket=buckets.get(key);
    bucket.items.push({g,part});
    bucket.vertices+=vertexCount(part.geometry)*g.positions.length;
    bucket.indices+=indexCount(part.geometry)*g.positions.length;
   }
  }
  const tileKey=tile.x+','+tile.z;
  if(pass!=='transparent'||!resources.lookups.has(tileKey))resources.lookups.set(tileKey,compactBlockLookup(tile.groups));
  const group=new THREE.Group(),tileOrigin=[tile.bounds[0],0,tile.bounds[2]];
  group.userData={origin:tileOrigin,tile};
  group.position.set(...tileOrigin.map((n,i)=>n-origin[i]));
  for(const bucket of buckets.values()){
   const mesh=compactWorldMesh(bucket,atlas,this.atlasMaterial(bucket.source,resources));
   mesh.userData={tile,atlasSource:bucket.source};
   group.add(mesh);
  }
  if(markers.length){
   const geometry=new THREE.BufferGeometry();
   geometry.setAttribute('position',new THREE.Float32BufferAttribute(markers,3));
   const points=new THREE.Points(geometry,this.markerMaterial);points.visible=this.showInvisible;group.add(points);
  }
  return group;
 }
 async update(x,z,distance,origin,bounds,eye=[x,0,z],_scale,frustum,budget=this.capacity.maxVertices,tileLimit,keepResidents=tileLimit===undefined){
  if(!this.enabled)return;
  if(!this.info)await this.initialize();
  if(!this.enabled)return;
  this.rebase(origin,bounds);
  const {revision,preview_index:preview}=this.info,totalTiles=this.tiles.length;
  budget=Math.min(budget,this.capacity.maxVertices);
  const stream=preview||totalTiles>this.capacity.residentTiles;
  const limit=tileLimit??(stream?this.capacity.streamTiles:this.capacity.residentTiles);
  const wanted=this.wanted(eye,[x,0,z],frustum,origin,limit,keepResidents),keys=wanted.map(t=>t.key);
  const signature=[revision,budget,...[...keys].sort().map(key=>key+'='+this.visibilityKey(key))].join(':'),order=keys.join(':');
  const sameSet=this.signature===signature;
  const box=new THREE.Box3();
  const reorder=sameSet&&this.budgetLimited&&frustum&&wanted.some(tile=>
   !this.hasCurrentTile(tile.key)&&frustum.intersectsBox(this.tileBox(tile,origin,box)));
  const loadingSignature=reorder?signature+'|'+order:signature;
  if(this.loading&&this.loadingGeneration===this.generation&&this.loadingSignature===loadingSignature)return this.loading;
  if(sameSet&&(!reorder||this.residentOrder===order)){
   if(this.loading)this.cancelUpdate();
   this.capacityDirty=false;
   return;
  }
  const generation=++this.generation,current=()=>generation===this.generation&&this.enabled;
  const sameWorld=this.residentRevision===revision;
  const entries=wanted.map(({key,x,z})=>{
   const resident=sameWorld?this.meshes.get(key):undefined;
   return {key,x,z,resident,dirty:!resident||!this.hasCurrentTile(key),tile:resident?.userData.tile,profile:resident?.userData.profile};
  });
  const dirty=entries.filter(entry=>entry.dirty);
  const oldAtlas=this.atlas,oldMaterials=new Map(this.materials);
  const next=new Map(),staged=[],resources={atlas:null,materials:new Map(),lookups:new Map()};
  let cursor=0,finished=0,reads=0,rebuilt=0,committed=false;
  const progress=()=>{if(dirty.length)this.progress(finished,dirty.length*2,sameWorld);};
  this.loadingSignature=loadingSignature;
  this.loadingGeneration=generation;
  progress();
  const load=async()=>{
   while(cursor<dirty.length&&current()){
    const entry=dirty[cursor++],raw=await this.tile(entry,()=>reads++);
    if(!current())return;
    if(raw.render_hash&&raw.render_hash===entry.tile?.render_hash){
     entry.tile={...raw,groups:entry.tile.groups};
    }else{
     entry.resident=undefined;
     const prepared=await this.prepareTile(raw,current);
     if(!current())return;
     Object.assign(entry,prepared);
    }
    finished++;progress();
   }
  };
  const task=(async()=>{
   try{
    const results=await Promise.allSettled([load(),load(),load(),load()]);
    if(!current())return;
    const failed=results.find(r=>r.status==='rejected');
    if(failed)throw failed.reason;
    let vertices=0,cost=0;
    const selected=entries.filter(({profile})=>{
     if(cost+profile.cost>budget)return false;
     cost+=profile.cost;vertices+=profile.vertices;return true;
    });
    const materials=[...new Set(selected.flatMap(entry=>entry.profile.materials))];
    await awaitTextures(materials);
    if(!current())return;
    const reuseAtlas=sameWorld&&oldAtlas&&
     (materials.every(m=>!m.map||oldAtlas.rects.has(m.map))||oldAtlas.extend?.(materials.map(m=>m.map)));
    resources.atlas=reuseAtlas?oldAtlas:this.createAtlas(materials,sameWorld?oldAtlas:undefined);
    if(reuseAtlas)resources.materials=new Map(oldMaterials);
    const rebind=[];
    let yieldAt=performance.now()+BAKE_SLICE_MS;
    for(const {tile,key,resident,profile,dirty:changed} of selected){
     if(!current())return;
     if(resident){
      resources.lookups.set(key,this.lookups.get(key));
      next.set(key,resident);
      if(!reuseAtlas)for(const mesh of resident.children){
       if(mesh.userData.atlasSource)rebind.push([mesh,this.atlasMaterial(mesh.userData.atlasSource,resources)]);
      }
     }else{
      const group=this.bake(tile,origin,resources);
      staged.push(group);
      group.userData.profile=profile;
      next.set(key,group);
      rebuilt++;
      if(performance.now()>=yieldAt){
       await (globalThis.scheduler?.yield?.()??new Promise(resolve=>setTimeout(resolve,0)));
       if(!current())return;
       yieldAt=performance.now()+BAKE_SLICE_MS;
      }
     }
     if(changed){finished++;progress();}
    }
    await Promise.resolve();
    if(!current())return;
    for(const [mesh,material] of rebind)mesh.material=material;
    for(const {key,tile,dirty:changed} of selected)if(changed){
     const group=next.get(key);
     group.userData.visibility_key=this.visibilityKey(key);
     group.userData.tile=tile;
     for(const mesh of group.children)if(mesh.isMesh)mesh.userData.tile=tile;
    }
    for(const [key,group] of this.meshes)if(next.get(key)!==group){this.scene.remove(group);this.dispose(group);}
    if(!reuseAtlas){
     for(const mat of oldMaterials.values())mat.dispose();
     oldAtlas?.texture.dispose();
    }
    for(const [key,group] of next)if(this.meshes.get(key)!==group)this.scene.add(group);
    Object.assign(this,{atlas:resources.atlas,materials:resources.materials,lookups:resources.lookups,meshes:next,
     signature,coverageKey:[...next.keys()].sort().join('|'),residentRevision:revision,residentOrder:order,capacityDirty:false,completeResidency:undefined,budgetLimited:selected.length<wanted.length,
     loadedVertices:vertices,loadedCost:cost,omittedTiles:totalTiles-selected.length,bakedTiles:this.bakedTiles+rebuilt,
     lastUpdate:{candidates:dirty.length,reads,rebuilt,retained:next.size-rebuilt,atlas_replaced:!!oldAtlas&&!reuseAtlas}});
    this.rebase(this.origin??origin,this.cutBounds);
    committed=true;
    this.progress(dirty.length*2,dirty.length*2,sameWorld);
   }catch(error){
    if(current()){this.progress(0,0);throw error;}
   }finally{
    if(!committed){
     for(const group of staged)this.dispose(group);
     for(const [key,mat] of resources.materials)if(resources.atlas!==oldAtlas||oldMaterials.get(key)!==mat)mat.dispose();
     if(resources.atlas!==oldAtlas)resources.atlas?.texture.dispose();
    }
   }
  })();
  this.loading=task;
  try{return await task;}
  finally{if(this.loading===task){this.loading=null;this.loadingSignature='';}}
 }
 stateAt(x,y,z){const key=Math.floor(x/32)+','+Math.floor(z/32),encoded=(y+64)*1024+((z%32+32)%32)*32+(x%32+32)%32;return this.lookups.get(key)?.get(encoded);}
 meshList(){return [...this.meshes.values()].flatMap(group=>group.children.filter(child=>child.isMesh));}
 animate(now){return this.enabled&&(this.atlas?.animate?.(now)??false);}
 hitBlock(hit){
  const tile=hit.object.userData.tile,encoded=hit.object.geometry.getAttribute('blockOwner').getX(hit.face.a);
  const [x,y,z]=coordinateOf(encoded),coordinate=[x+tile.bounds[0],y,z+tile.bounds[2]];
  return {coordinate,state:this.stateAt(...coordinate),appearance:tile.block_entities?.[coordinate.join()],normal:hit.face.normal.toArray()};
 }
 evidence(geometry=true,tiles=[...this.meshes.values()].map(g=>g.userData.tile)){if(!geometry)return {tiles};const keys=new Set(tiles.flatMap(t=>t.groups.filter(g=>!helper(g.state)).map(group=>keyFor(group,t.minecraft)))),models={};for(const key of keys)models[key]=(this.prepared.get(key)??[]).map(p=>({position:Array.from(p.geometry.getAttribute('position').array),normal:Array.from(p.geometry.getAttribute('normal')?.array??[]),uv:Array.from(p.geometry.getAttribute('uv')?.array??[]),index:p.geometry.index?Array.from(p.geometry.index.array):undefined,color:p.material.color?.getHex(),style:this.style(p.material),atlas_rect:this.atlas.rects.get(p.material.map)??this.atlas.white}));return {world_revision:this.info.revision,tiles,models,atlas_png:this.atlas.canvas.toDataURL('image/png'),representation:'minecraft_block_models',source:'saved_anvil_exact_models'};}
}
