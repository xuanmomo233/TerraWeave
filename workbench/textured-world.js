import * as THREE from 'three';
import {awaitTextures} from './model-terrain.js';
import {updateAnimatedTexture} from './texture-animation.js';

export function createTextureAtlas(materials){
  const maps=[...new Set([...materials].map(m=>m.map).filter(Boolean))],tileSize=Math.max(16,...maps.map(m=>m.image.width)),cell=tileSize+4,dimension=2**Math.ceil(Math.log2(Math.ceil(Math.sqrt(maps.length+1))*cell)),canvas=document.createElement('canvas');canvas.width=canvas.height=dimension;const c=canvas.getContext('2d');c.imageSmoothingEnabled=false;c.fillStyle='#ffffff';c.fillRect(2,2,tileSize,tileSize);const rects=new Map(),animated=[];
  const columns=Math.floor(dimension/cell);
  function draw(map,x,y){c.clearRect(x,y,tileSize,tileSize);c.drawImage(map.image,x,y,tileSize,tileSize);}
  maps.forEach((map,i)=>{
   const x=(i+1)%columns*cell+2,y=Math.floor((i+1)/columns)*cell+2;
   draw(map,x,y);rects.set(map,{x:x+.5,y:y+.5,w:tileSize-1,h:tileSize-1});
   if(map.userData.animation)animated.push({map,x,y,version:map.version});
  });
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.magFilter=THREE.NearestFilter;texture.minFilter=THREE.NearestFilter;texture.generateMipmaps=false;
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
  return {texture,canvas,rects,dimension,animate,white:{x:2.5,y:2.5,w:tileSize-1,h:tileSize-1}};
}

const MAX_RESIDENT_TILES=64;
const MAX_RESIDENT_VERTICES=5_200_000;
const helper=s=>/^minecraft:(barrier|structure_void|light)(\[|$)/.test(s);
export const modelGroupKey=(g,minecraft)=>JSON.stringify([minecraft,g.state,g.mask,g.fluid_mask,g.fluid_corners,g.block_entity,g.variantIndices]);
const keyFor=modelGroupKey;
export class TexturedWorld{
 constructor(scene,call,parts,progress=()=>{},chooseVariants){this.scene=scene;this.call=call;this.parts=parts;this.progress=progress;this.chooseVariants=chooseVariants;this.meshes=new Map();this.cache=new Map();this.prepared=new Map();this.lookups=new Map();this.enabled=false;this.showInvisible=false;this.info=null;this.signature='';this.generation=0;this.loading=null;this.atlas=null;this.materials=new Map();this.markerMaterial=new THREE.PointsMaterial({size:1.1,transparent:true,alphaTest:.1,depthWrite:false});this.uniforms={active:{value:false},min:{value:new THREE.Vector3()},max:{value:new THREE.Vector3()}};}
 async initialize(info){const generation=this.generation;if(!info){if(!this.infoRequest)this.infoRequest=this.call('world_scene_info',{preview:true}).finally(()=>this.infoRequest=null);info=await this.infoRequest;if(generation!==this.generation&&this.info)return this.info;}if(this.info?.revision!==info.revision){this.generation++;this.cache.clear();this.signature='';}else if(this.info?.preview_index&&!info.preview_index)this.generation++;this.info=info;this.tiles=this.indexTiles(info);return this.info;}
 setShowInvisible(value,map){this.showInvisible=value;if(map&&this.markerMaterial.map!==map){this.markerMaterial.map=map;this.markerMaterial.needsUpdate=true;}for(const group of this.meshes.values())for(const child of group.children)if(child.isPoints)child.visible=value;}
 dispose(group){for(const child of group.children)child.geometry.dispose();}
 clear(){this.generation++;for(const group of this.meshes.values()){this.scene.remove(group);this.dispose(group);}this.meshes.clear();this.lookups.clear();for(const mat of this.materials.values())mat.dispose();this.materials.clear();this.atlas?.texture.dispose();this.atlas=null;this.signature='';this.loadedVertices=0;this.omittedTiles=0;}
 rebase(origin,bounds){this.origin=[...origin];this.cutBounds=bounds;for(const group of this.meshes.values())group.position.set(...group.userData.origin.map((n,i)=>n-origin[i]));this.uniforms.active.value=!!bounds;if(bounds){this.uniforms.min.value.set(...bounds.slice(0,3).map((n,i)=>n-origin[i]));this.uniforms.max.value.set(...bounds.slice(3).map((n,i)=>n+1-origin[i]));}}
 indexTiles(info){
  const result=new Map(),world=info.bounds??[-64,-64,-64,63,319,63];
  for(const [cx,cz,y0,y1] of [...info.occupied_chunks,...(info.helper_chunks??[])]){
   const x=Math.floor(cx/2),z=Math.floor(cz/2),key=x+','+z,old=result.get(key);
   result.set(key,{x,z,key,min_y:Math.min(old?.min_y??Infinity,y0??world[1]),max_y:Math.max(old?.max_y??-Infinity,y1??world[4])});
  }
  return [...result.values()];
 }
 wanted(eye,target,frustum,origin,limit=MAX_RESIDENT_TILES){
  const tiles=this.tiles??this.indexTiles(this.info);
  this.totalTiles=tiles.length;
  const ranked=tiles.map(tile=>{
   const x=tile.x*32,z=tile.z*32;
   const distance=(p)=>Math.hypot(Math.max(0,x-p[0],p[0]-x-32),Math.max(0,z-p[2],p[2]-z-32));
   const near=distance(eye);
   // Keep off-screen nearby terrain for the light's shadow map.
   if(near<=128)return {tile,score:near};
   const visible=frustum?.intersectsBox(new THREE.Box3(
    new THREE.Vector3(x-origin[0],tile.min_y-origin[1],z-origin[2]),
    new THREE.Vector3(x+32-origin[0],tile.max_y+1-origin[1],z+32-origin[2])));
   return {tile,score:(visible?1000:100000)+Math.min(near,distance(target))};
  });
  return ranked.sort((a,b)=>a.score-b.score||a.tile.x-b.tile.x||a.tile.z-b.tile.z).slice(0,limit).map(entry=>entry.tile);
 }
 vertexCount(tile){
  return tile.groups.reduce((sum,g)=>sum+g.positions.length*(this.prepared.get(keyFor(g,tile.minecraft))??[])
   .reduce((count,part)=>count+(part.geometry.index?.count??part.geometry.getAttribute('position').count),0),0);
 }
 async tile(t){const revision=this.info.revision,key=revision+':'+t.key;if(this.cache.has(key)){const data=this.cache.get(key);this.cache.delete(key);this.cache.set(key,data);return data;}const data=await this.call('world_model_tile',{x:t.x,z:t.z,world_revision:revision});if(this.info?.revision===revision){this.cache.set(key,data);while(this.cache.size>192)this.cache.delete(this.cache.keys().next().value);}return data;}
 async prepare(data,current=()=>true){
  const groups=[],position=n=>[n%32+data.bounds[0],Math.floor(n/1024)-64,Math.floor(n/32)%32+data.bounds[2]];
  for(const g of data.groups){
   if(!current())return;
   if(helper(g.state)){groups.push(g);continue;}
   const choices=this.chooseVariants?await this.chooseVariants(g.state,g.positions,position,data.minecraft):[{items:g.positions}];
   for(const {indices,items} of choices){
    if(!current())return;
    const chosen=indices?{...g,positions:items,variantIndices:indices}:g,key=keyFor(chosen,data.minecraft);
    if(!this.prepared.has(key))this.prepared.set(key,await this.parts(g.state,{minecraft:data.minecraft,occlusionMask:g.mask,fluidMask:g.fluid_mask,fluidCorners:g.fluid_corners,blockEntity:g.block_entity,variantIndices:indices}));
    groups.push(chosen);
   }
  }
  return {...data,groups};
 }
 createAtlas(data){
  const materials=new Set();for(const tile of data)for(const group of tile.groups)for(const part of this.prepared.get(keyFor(group,tile.minecraft))??[])materials.add(part.material);
  return createTextureAtlas(materials);
 }
 style(material){return JSON.stringify([material.transparent??false,material.opacity??1,material.side??0,material.wireframe??false,material.emissiveIntensity??0,material.emissive?.getHex()??0,material.alphaTest??.1,material.depthWrite??true]);}
 atlasMaterial(source,resources=this){const key=this.style(source);if(!resources.materials.has(key)){const m=new THREE.MeshLambertMaterial({map:resources.atlas.texture,vertexColors:true,alphaTest:source.alphaTest??.1,transparent:source.transparent??false,opacity:source.opacity??1,depthWrite:source.depthWrite??true,side:source.side??THREE.FrontSide,wireframe:source.wireframe??false});if(source.emissive?.getHex()){m.emissive.copy(source.emissive);m.emissiveIntensity=source.emissiveIntensity;m.emissiveMap=resources.atlas.texture;}m.onBeforeCompile=shader=>{Object.assign(shader.uniforms,{previewCut:this.uniforms.active,previewMin:this.uniforms.min,previewMax:this.uniforms.max});shader.vertexShader='attribute vec3 blockOrigin;varying vec3 vPreviewOwner;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <worldpos_vertex>','#include <worldpos_vertex>\nvPreviewOwner=(modelMatrix*vec4(blockOrigin,1.0)).xyz;');shader.fragmentShader='varying vec3 vPreviewOwner;uniform bool previewCut;uniform vec3 previewMin;uniform vec3 previewMax;\n'+shader.fragmentShader;shader.fragmentShader=shader.fragmentShader.replace('#include <dithering_fragment>','vec3 owner=floor(vPreviewOwner+vec3(0.5));if(previewCut&&all(greaterThanEqual(owner,previewMin))&&all(lessThan(owner,previewMax)))discard;\n#include <dithering_fragment>');};resources.materials.set(key,m);}return resources.materials.get(key);}
 bake(tile,origin,resources=this){const atlas=resources.atlas;
  const buckets=new Map(),lookup=new Map(),markers=[];for(const g of tile.groups){for(const p of g.positions)lookup.set(p,g.state);if(helper(g.state)){if(g.state==='minecraft:barrier')for(const p of g.positions)markers.push(p%32+tile.bounds[0]+.5-origin[0],Math.floor(p/1024)-63.5-origin[1],Math.floor(p/32)%32+tile.bounds[2]+.5-origin[2]);continue;}
   for(const part of this.prepared.get(keyFor(g,tile.minecraft))??[]){const key=this.style(part.material),geometry=part.geometry;if(!buckets.has(key))buckets.set(key,{source:part.material,items:[],count:0});const bucket=buckets.get(key),count=geometry.index?.count??geometry.getAttribute('position').count;bucket.items.push({g,part,count});bucket.count+=count*g.positions.length;}
  }
  resources.lookups.set(tile.x+','+tile.z,lookup);const group=new THREE.Group();group.userData={origin:[...origin],tile};
  for(const bucket of buckets.values()){const positions=new Float32Array(bucket.count*3),normals=new Float32Array(bucket.count*3),uvs=new Float32Array(bucket.count*2),colors=new Float32Array(bucket.count*3),blockOrigins=new Float32Array(bucket.count*3),owners=new Uint32Array(bucket.count/3);let cursor=0;
   for(const {g,part,count}of bucket.items){const geometry=part.geometry,p=geometry.getAttribute('position'),n=geometry.getAttribute('normal'),uv=geometry.getAttribute('uv'),rect=atlas.rects.get(part.material.map)??atlas.white,tint=part.material.color??new THREE.Color(0xffffff),placeholder=part.placeholder?.5:0;
    for(const encoded of g.positions){const x=encoded%32+tile.bounds[0]-origin[0]+placeholder,y=Math.floor(encoded/1024)-64-origin[1]+placeholder,z=Math.floor(encoded/32)%32+tile.bounds[2]-origin[2]+placeholder;
     for(let v=0;v<count;v++){const i=geometry.index?.getX(v)??v,j=cursor*3,k=cursor*2;if(cursor%3===0)owners[cursor/3]=encoded;positions[j]=p.getX(i)+x;positions[j+1]=p.getY(i)+y;positions[j+2]=p.getZ(i)+z;blockOrigins[j]=x-placeholder;blockOrigins[j+1]=y-placeholder;blockOrigins[j+2]=z-placeholder;normals[j]=n?.getX(i)??0;normals[j+1]=n?.getY(i)??1;normals[j+2]=n?.getZ(i)??0;uvs[k]=(rect.x+(uv?.getX(i)??0)*rect.w)/atlas.dimension;uvs[k+1]=1-(rect.y+(1-(uv?.getY(i)??0))*rect.h)/atlas.dimension;colors[j]=tint.r;colors[j+1]=tint.g;colors[j+2]=tint.b;cursor++;}
    }
   }
   const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('blockOrigin',new THREE.BufferAttribute(blockOrigins,3));geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3));geometry.setAttribute('uv',new THREE.BufferAttribute(uvs,2));geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));geometry.computeBoundingSphere();geometry.computeBoundingBox();const mesh=new THREE.Mesh(geometry,this.atlasMaterial(bucket.source,resources));mesh.userData={owners,tile};group.add(mesh);
  }
  if(markers.length){const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(markers,3));const points=new THREE.Points(geometry,this.markerMaterial);points.visible=this.showInvisible;group.add(points);}return group;
 }
 async update(x,z,distance,origin,bounds,eye=[x,0,z],_scale,frustum,budget=MAX_RESIDENT_VERTICES,tileLimit=MAX_RESIDENT_TILES){
  if(!this.enabled)return;
  if(!this.info)await this.initialize();
  if(!this.enabled)return;
  this.rebase(origin,bounds);
  const wanted=this.wanted(eye,[x,0,z],frustum,origin,tileLimit);
  const signature=[this.info.revision,budget,...wanted.map(t=>t.key).sort()].join(':');
  if(this.loading&&this.loadingSignature===signature)return this.loading;
  if(this.signature===signature&&!this.loading)return;
  const generation=++this.generation,current=()=>generation===this.generation&&this.enabled;
  const next=new Map(),data=Array(wanted.length),resources={atlas:null,materials:new Map(),lookups:new Map()};
  let cursor=0,finished=0,committed=false;
  this.loadingSignature=signature;
  this.progress(0,wanted.length*2);
  const load=async()=>{
   while(cursor<wanted.length&&current()){
    const index=cursor++,tile=await this.tile(wanted[index]);
    if(!current())return;
    const prepared=await this.prepare(tile,current);
    if(!current())return;
    data[index]=prepared??tile;
    this.progress(++finished,wanted.length*2);
   }
  };
  const task=(async()=>{
   try{
    const results=await Promise.allSettled([load(),load(),load(),load()]);
    if(!current())return;
    const failed=results.find(r=>r.status==='rejected');
    if(failed)throw failed.reason;
    let vertices=0;
    const selected=data.filter(tile=>{
     const count=this.vertexCount(tile);
     if(vertices+count>budget)return false;
     vertices+=count;return true;
    });
    const keys=new Set(selected.flatMap(tile=>tile.groups.filter(g=>!helper(g.state)).map(group=>keyFor(group,tile.minecraft))));
    const materials=[...keys].flatMap(key=>(this.prepared.get(key)??[]).map(p=>p.material));
    await awaitTextures(materials);
    if(!current())return;
    resources.atlas=this.createAtlas(selected);
    for(const tile of selected){
     if(!current())return;
     next.set(tile.x+','+tile.z,this.bake(tile,origin,resources));
     this.progress(++finished,wanted.length*2);
     await new Promise(r=>setTimeout(r,0));
    }
    if(!current())return;
    for(const group of this.meshes.values()){this.scene.remove(group);this.dispose(group);}
    for(const mat of this.materials.values())mat.dispose();
    this.atlas?.texture.dispose();
    Object.assign(this,{atlas:resources.atlas,materials:resources.materials,lookups:resources.lookups,meshes:next,
     signature,loadedVertices:vertices,omittedTiles:(this.totalTiles??wanted.length)-selected.length});
    for(const group of next.values())this.scene.add(group);
    this.rebase(this.origin??origin,this.cutBounds);
    committed=true;
    this.progress(wanted.length*2,wanted.length*2);
   }catch(error){
    if(current()){this.progress(0,0);throw error;}
   }finally{
    if(!committed){
     for(const group of next.values())this.dispose(group);
     for(const mat of resources.materials.values())mat.dispose();
     resources.atlas?.texture.dispose();
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
 hitBlock(hit){const encoded=hit.object.userData.owners[hit.faceIndex],b=hit.object.userData.tile.bounds,coordinate=[encoded%32+b[0],Math.floor(encoded/1024)-64,Math.floor(encoded/32)%32+b[2]];return {coordinate,state:this.stateAt(...coordinate),appearance:hit.object.userData.tile.block_entities?.[coordinate.join()],normal:hit.face.normal.toArray()};}
 evidence(geometry=true){const tiles=[...this.meshes.values()].map(g=>g.userData.tile);if(!geometry)return {tiles};const keys=new Set(tiles.flatMap(t=>t.groups.filter(g=>!helper(g.state)).map(group=>keyFor(group,t.minecraft)))),models={};for(const key of keys)models[key]=(this.prepared.get(key)??[]).map(p=>({position:Array.from(p.geometry.getAttribute('position').array),normal:Array.from(p.geometry.getAttribute('normal')?.array??[]),uv:Array.from(p.geometry.getAttribute('uv')?.array??[]),index:p.geometry.index?Array.from(p.geometry.index.array):undefined,color:p.material.color?.getHex(),style:this.style(p.material),atlas_rect:this.atlas.rects.get(p.material.map)??this.atlas.white}));return {world_revision:this.info.revision,tiles,models,atlas_png:this.atlas.canvas.toDataURL('image/png'),representation:'minecraft_block_models',source:'saved_anvil_exact_models'};}
}
