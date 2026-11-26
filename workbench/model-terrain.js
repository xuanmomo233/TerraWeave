import {invoke} from '@tauri-apps/api/core';
import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {fluidGeometry} from './fluid-geometry.js';
import {aquaticPlant} from './tools/fluid-shape.mjs';
import {signFaceText,specialModel} from './special-models.js';
import {baselineMinecraft,supportedMinecraft} from './minecraft-version.js';
import {dyes} from './tools/block-entity-appearance.mjs';
import {partitionVariants,selectVariants,variantChoices} from './tools/model-variants.mjs';
import {modelProperties} from './tools/block-state-catalog.mjs';
import {setTextureImage} from './texture-animation.js';
export {selectVariants} from './tools/model-variants.mjs';
const cache=new Map(),mats=new Map(),maps=new Map(),loader=new THREE.TextureLoader();
async function json(url,minecraft=baselineMinecraft){const key=minecraft+'|'+url;if(!cache.has(key))cache.set(key,invoke('read_asset',{name:url.replace('/assets/',''),minecraft}).then(JSON.parse));return cache.get(key)}
async function model(id,read=json,seen=new Set()){
 if(seen.has(id)||seen.size>30)throw Error('Model parent cycle '+id);seen.add(id);
 const m=await read('/assets/minecraft/models/'+id.replace('minecraft:','')+'.json');
 if(m.parent){const p=await model(m.parent,read,seen);return {...p,...m,textures:{...p.textures,...m.textures},elements:m.elements||p.elements}}return m;
}
function modelTexture(reference,textures){
 let value=reference,forceTranslucent=false;
 const visited=new Set();
 for(;;){
  if(value&&typeof value==='object'){
   forceTranslucent||=value.force_translucent===true;
   value=value.sprite;
  }
  if(typeof value!=='string'||!value)throw Error('Unresolved texture '+reference);
  // Most references use #. Some vanilla models also name a declared texture directly.
  if(!value.startsWith('#')&&!Object.hasOwn(textures??{},value)){
   return {sprite:value.replace(/^minecraft:/,''),forceTranslucent};
  }
  const key=value.replace(/^#/,'');
  if(visited.has(key))throw Error('Texture reference cycle '+value);
  visited.add(key);
  value=textures?.[key];
 }
}
export function materialSettings(id,tint=false,forceTranslucent=false){
 if(Number.isInteger(tint)&&!forceTranslucent)return {color:tint,alphaTest:.1};
 if(tint&&id==='lily_pad')return {color:0x208030,alphaTest:.1};
 if(id==='water')return {transparent:true,opacity:.72,depthWrite:false,side:THREE.DoubleSide,color:0x3f76e4};
 if(id==='lava')return {color:0xffffff,emissive:0xffffff,emissiveIntensity:.7};
 if(id==='end_portal'||id==='end_gateway')return {color:0xffffff,emissive:0xffffff,emissiveIntensity:.35,side:THREE.DoubleSide};
 if(id==='bubble_column')return {color:0xffffff,alphaTest:.1,side:THREE.DoubleSide};
 if(tint&&/_banner$/.test(id))return {color:dyes[id.replace(/(?:_wall)?_banner$/,'')]??0xf9fffe};
 if(id==='barrier'||id==='structure_void')return {alphaTest:.1,transparent:true,depthWrite:false,side:THREE.DoubleSide,color:0xffffff};
 const blend=forceTranslucent||/^(?:.*_stained_glass(?:_pane)?|tinted_glass|ice|frosted_ice|slime_block|honey_block|nether_portal)$/.test(id);
 const color=Number.isInteger(tint)?tint:tint?(/water_cauldron/.test(id)?0x3f76e4:/birch/.test(id)?0x80a755:/spruce/.test(id)?0x619961:0x91bd59):0xffffff;
 return {alphaTest:blend?.01:.1,transparent:blend,depthWrite:!blend,side:THREE.FrontSide,color};
}
function texture(t,minecraft){
 const key=minecraft+'|'+t;
 if(maps.has(key))return maps.get(key);
 const map=new THREE.Texture();
 map.userData.source=t;
 map.magFilter=THREE.NearestFilter;map.minFilter=THREE.NearestMipmapLinearFilter;map.colorSpace=THREE.SRGBColorSpace;map.generateMipmaps=true;
 map.userData.ready=invoke('read_asset',{name:'minecraft/textures/'+t+'.png',minecraft,includeAnimation:true}).then(result=>{
  // The browser QA adapter also accepts static data URLs.
  const asset=result.startsWith('data:')?{url:result}:JSON.parse(result);
  return new Promise((resolve,reject)=>loader.load(asset.url,loaded=>{
   try{setTextureImage(map,loaded.image,asset.animation);resolve();}catch(error){reject(error);}finally{loaded.dispose();}
  },undefined,reject));
 }).catch(error=>{map.userData.loadError=t+': '+String(error);});
 maps.set(key,map);
 return map;
}
function material(t,id,tint,minecraft=baselineMinecraft,forceTranslucent=false,lightEmission=0){
 const key=minecraft+'|'+t+'|'+id+'|'+tint+'|'+forceTranslucent+'|'+lightEmission;
 if(mats.has(key))return mats.get(key);
 const map=texture(t,minecraft),invisible=id==='barrier'||id==='structure_void';
 const unlit=lightEmission===15;
 const Material=invisible||unlit?THREE.MeshBasicMaterial:THREE.MeshLambertMaterial;
 const mat=new Material({map,...materialSettings(id,tint,forceTranslucent)});
 if(id==='lava')mat.emissiveMap=map;
 if(lightEmission){
  // Vanilla emissive masks can share a plane with the lit base model.
  mat.polygonOffset=true;
  mat.polygonOffsetFactor=-1;
  mat.polygonOffsetUnits=-1;
  if(!unlit){
   mat.emissive.copy(mat.color);
   mat.emissiveIntensity=lightEmission/15;
   mat.emissiveMap=map;
  }
 }
 if(invisible){mat.customProgramCacheKey=()=> 'invisible-block-billboard';mat.onBeforeCompile=shader=>{shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>','vec4 glyphCenter=vec4(0.5,0.5,0.5,1.0);\n#ifdef USE_INSTANCING\nglyphCenter=instanceMatrix*glyphCenter;\n#endif\nvec4 mvPosition=modelViewMatrix*glyphCenter;mvPosition.xy+=position.xy-vec2(0.5);gl_Position=projectionMatrix*mvPosition;');};}if(id==='water')mat.userData.water=true;mats.set(key,mat);return mat;
}
export async function awaitTextures(materials){const maps=[...new Set(materials.flat().map(m=>m?.map).filter(Boolean))];await Promise.all(maps.map(m=>m.userData.ready));const errors=maps.map(m=>m.userData.loadError).filter(Boolean);if(errors.length)throw Error('材质尚未就绪：'+errors.join('; '));}
export function parseState(s){const m=/^minecraft:([a-z0-9_]+)(?:\[([^\]]+)\])?$/.exec(s);if(!m)throw Error('Invalid state '+s);return {id:m[1],props:Object.fromEntries((m[2]||'').split(',').filter(Boolean).map(x=>x.split('=')))}}
function modelState(state,minecraft=baselineMinecraft){
 const {id,props}=parseState(state);
 return {id,props:modelProperties('minecraft:'+id,props,minecraft)};
}
const choiceCache=new Map();
export async function chooseVariantGroups(state,items,position,minecraft=baselineMinecraft){
 if(items.length===0)return [{items}];
 const key=minecraft+'|'+state;
 if(!choiceCache.has(key)){
  const {id,props}=modelState(state,minecraft);
  choiceCache.set(key,json('/assets/minecraft/blockstates/'+id+'.json',minecraft)
   .then(blockstate=>variantChoices(blockstate,props)).catch(()=>[]));
 }
 return partitionVariants(await choiceCache.get(key),items,position);
}
const opaqueCache=new Map();
export function opaqueModel(state,minecraft=baselineMinecraft){const key=minecraft+"|"+state,read=url=>json(url,minecraft);if(!opaqueCache.has(key))opaqueCache.set(key,(async()=>{try{const {id,props}=modelState(state,minecraft);if(/glass|leaves|ice|slime|honey|spawner|barrier|light|water|lava|powder_snow/.test(id))return false;const bs=await read('/assets/minecraft/blockstates/'+id+'.json');if(bs.multipart)return false;const choices=variantChoices(bs,props)[0];return (await Promise.all(choices.map(v=>model(v.model,read)))).every(m=>m.elements?.some(e=>!e.rotation&&e.from.every(n=>n===0)&&e.to.every(n=>n===16)&&Object.keys(e.faces).length===6));}catch{return false;}})());return opaqueCache.get(key);}
const faceAxes={south:[[1,0,0],[0,1,0]],north:[[-1,0,0],[0,1,0]],east:[[0,0,-1],[0,1,0]],west:[[0,0,1],[0,1,0]],up:[[1,0,0],[0,0,-1]],down:[[1,0,0],[0,0,1]]};
function lockFaceUV(uv,face,variant){
 const [u,v]=faceAxes[face].map(axis=>new THREE.Vector3(...axis));
 const rotate=axis=>axis.applyAxisAngle(new THREE.Vector3(1,0,0),-(variant.x??0)*Math.PI/180)
  .applyAxisAngle(new THREE.Vector3(0,1,0),-(variant.y??0)*Math.PI/180);
 rotate(u);rotate(v);
 const normal=u.clone().cross(v);
 const [worldU,worldV]=Object.values(faceAxes).map(pair=>pair.map(axis=>new THREE.Vector3(...axis)))
  .find(([a,b])=>a.clone().cross(b).dot(normal)>.999);
 const align=(a,b)=>Math.round(a.dot(b));
 return uv.map(([x,y])=>[.5+(x-.5)*align(u,worldU)+(y-.5)*align(v,worldU),.5+(x-.5)*align(u,worldV)+(y-.5)*align(v,worldV)]);
}
export function modelFaceTint(id,props,index){
 if(index===undefined||index<0)return false;
 const packed=(r,g,b)=>((r|0)<<16)|((g|0)<<8)|(b|0);
 if(id==='redstone_wire'){
  const power=Number(props.power??0)/15;
  return packed((power?power*.6+.4:.3)*255,Math.max(0,power*power*.7-.5)*255,Math.max(0,power*power*.6-.7)*255);
 }
 if(/^(?:melon|pumpkin)_stem$/.test(id)){
  const age=Number(props.age??0);return packed(age*32,255-age*8,age*4);
 }
 if(/^attached_(?:melon|pumpkin)_stem$/.test(id))return 0xe0c71c;
 if(id==='leaf_litter')return 0x5c3c32; // Vanilla's dry foliage color without biome context.
 return /^(grass_block|grass|short_grass|tall_grass|fern|large_fern|potted_fern|vine|bamboo|bamboo_sapling|pink_petals|sugar_cane|water_cauldron|lily_pad|.*_leaves)$/.test(id);
}
export const invisibleMarkerMaterial=()=>material('item/barrier','barrier',false);
function applyElementRotation(geometry,rotation){
 const origin=rotation.origin.map(value=>value/16);
 const axes=['x','y','z'];
 let degrees;
 if(rotation.axis!==undefined){
  if(!axes.includes(rotation.axis)||!Number.isFinite(rotation.angle))throw Error('Invalid element rotation axis or angle');
  degrees=axes.map(axis=>axis===rotation.axis?rotation.angle:0);
 }else{
  degrees=axes.map(axis=>rotation[axis]??0);
  if(!axes.some(axis=>Object.hasOwn(rotation,axis))||!degrees.every(Number.isFinite))throw Error('Invalid element Euler rotation');
 }
 const radians=degrees.map(value=>value*Math.PI/180);
 // Vanilla's Euler cuboid codec applies X, then Y, then Z around the supplied origin.
 const matrix=new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...radians,'ZYX'));
 if(rotation.rescale){
  const scale=new THREE.Vector3(...axes.map((_,index)=>{
   const column=matrix.elements.slice(index*4,index*4+3);
   return 1/Math.max(...column.map(Math.abs));
  }));
  matrix.scale(scale);
 }
 geometry.translate(...origin.map(value=>-value)).applyMatrix4(matrix).translate(...origin);
}
export async function buildState(s,options={}){
 const {id,props}=modelState(s,options.minecraft);
 const read=options.readJson??(url=>json(url,options.minecraft));
 const mkmat=options.makeMaterial??((sprite,block,tint,forceTranslucent,lightEmission)=>
  material(sprite,block,tint,options.minecraft,forceTranslucent,lightEmission));
 if(['barrier','structure_void','light'].includes(id)){if(!options.showInvisible||id==='light')return [];return [{geometry:new THREE.PlaneGeometry(.86,.86).translate(.5,.5,.5),material:mkmat('item/'+id,id,false)}];}
 if(id==='water'||id==='lava'){
  const mask=options.fluidMask??options.occlusionMask??0;
  if(mask===63)return [];
  const level=Number(props.level??0),height=level>=8?8/9:Math.max(1/9,(8-level)/9);
  const geometry=fluidGeometry(options.fluidCorners??[height,height,height,height],mask);
  return [{geometry,material:mkmat('block/'+id+(level>0?'_flow':'_still'),id,false)}];
 }
 if(id==='bubble_column'){
  const water=await buildState('minecraft:water[level=0]',options);
  const bubbles=[[.32,.24,.36],[.58,.68,.63],[.71,.42,.38]].flatMap(([x,y,z])=>[0,Math.PI/2].map(angle=>
   new THREE.PlaneGeometry(.13,.13).rotateY(angle).translate(x,y,z)));
  return [...water,{geometry:mergeGeometries(bubbles),material:mkmat('particle/bubble','bubble_column',false)}];
 }
 if(id==='moving_piston'){
  const appearance=options.blockEntity,moved=appearance?.state;
  const target=moved&&!/^minecraft:moving_piston(?:\[|$)/.test(moved)?moved:
   `minecraft:piston_head[facing=${props.facing},short=false,type=${props.type}]`;
  const motion=(appearance?.extending?-1:1)*(1-(appearance?.progress??1));
  const delta={east:[1,0,0],west:[-1,0,0],up:[0,1,0],down:[0,-1,0],south:[0,0,1],north:[0,0,-1]}[props.facing]??[0,0,0];
  const parts=await buildState(target,{...options,variantIndices:undefined,blockEntity:undefined,occlusionMask:0});
  for(const part of parts)part.geometry.translate(...delta.map(v=>v*motion));
  return parts;
 }
 if(id==='pitcher_crop'&&props.half==='upper'&&Number(props.age)<3)return [];
 const water=aquaticPlant(id)||props.waterlogged==='true'
  ?await buildState('minecraft:water[level=0]',{...options,fluidMask:options.fluidMask??0}):[];
 const entity=specialModel(id,props,mkmat,options.blockEntity,options.minecraft);if(entity)return [...entity,...water];
 if(/^(?:glow_)?item_frame$/.test(id))props.map??='false';
 const bs=await read('/assets/minecraft/blockstates/'+id+'.json'),variants=selectVariants(bs,props,options.variantIndices),byTex=new Map();
 const signAppearance=id.endsWith('_sign')&&options.blockEntity,signParts=[];
 for(const v of variants){
 if(/^(?:minecraft:)?block\/air$/.test(v.model))continue;
 const m=await model(v.model,read);if(!m.elements?.length)throw Error('模型需要特殊渲染: '+s);
 for(const e of m.elements){const [x,y,z]=e.from.map(n=>n/16),[X,Y,Z]=e.to.map(n=>n/16);
 const lightEmission=Number.isInteger(e.light_emission)?Math.min(15,Math.max(0,e.light_emission)):0;
 const vertices={south:[[x,y,Z],[X,y,Z],[X,Y,Z],[x,Y,Z]],north:[[X,y,z],[x,y,z],[x,Y,z],[X,Y,z]],east:[[X,y,Z],[X,y,z],[X,Y,z],[X,Y,Z]],west:[[x,y,z],[x,y,Z],[x,Y,Z],[x,Y,z]],up:[[x,Y,Z],[X,Y,Z],[X,Y,z],[x,Y,z]],down:[[x,y,z],[X,y,z],[X,y,Z],[x,y,Z]]};
 const defaultUV={up:[x,z,X,Z],down:[x,1-Z,X,1-z],north:[1-X,1-Y,1-x,1-y],south:[x,1-Y,X,1-y],west:[z,1-Y,Z,1-y],east:[1-Z,1-Y,1-z,1-y]};
 for(const [face,f]of Object.entries(e.faces)){
 if(f.cullface&&options.occlusionMask){const directions={east:[1,0,0],west:[-1,0,0],up:[0,1,0],down:[0,-1,0],south:[0,0,1],north:[0,0,-1]},normal=new THREE.Vector3(...directions[f.cullface]).applyEuler(new THREE.Euler(-(v.x??0)*Math.PI/180,-(v.y??0)*Math.PI/180,0,'YXZ')),axis=normal.toArray().map(n=>Math.round(n)),index=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].findIndex(d=>d.every((n,i)=>n===axis[i]));if(index>=0&&options.occlusionMask&(1<<index))continue;}
 const a=vertices[face];if(!a)throw Error('Unknown face '+face);const uv=f.uv||defaultUV[face].map(n=>n*16);
 let u=[[uv[0]/16,1-uv[3]/16],[uv[2]/16,1-uv[3]/16],[uv[2]/16,1-uv[1]/16],[uv[0]/16,1-uv[1]/16]];
 for(let i=0;i<(f.rotation||0)/90;i++)u.unshift(u.pop());
 if(v.uvlock&&(v.x||v.y))u=lockFaceUV(u,face,v);
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(a.flat(),3));g.setAttribute('uv',new THREE.Float32BufferAttribute(u.flat(),2));g.setIndex([0,1,2,0,2,3]);
 if(e.rotation)applyElementRotation(g,e.rotation);
 g.translate(-.5,-.5,-.5);g.rotateX(-(v.x||0)*Math.PI/180);g.rotateY(-(v.y||0)*Math.PI/180);g.translate(.5,.5,.5);g.computeVertexNormals();
 if(signAppearance){
  const textPart=signFaceText(id,signAppearance,e,face,g);
  if(textPart)signParts.push(textPart);
 }
 const {sprite,forceTranslucent}=modelTexture(f.texture,m.textures),tint=modelFaceTint(id,props,f.tintindex);
 const key=sprite+'|'+tint+'|'+forceTranslucent+'|'+lightEmission;
 if(!byTex.has(key))byTex.set(key,{sprite,tint,forceTranslucent,lightEmission,geometries:[]});
 byTex.get(key).geometries.push(g);
 }} }
 const modelParts=[...byTex.values()].map(({sprite,tint,forceTranslucent,lightEmission,geometries})=>({
  geometry:mergeGeometries(geometries),material:mkmat(sprite,id,tint,forceTranslucent,lightEmission)
 }));
 return [...modelParts,...signParts,...water];
}
export function validate(d){if(d.schema!==1||!supportedMinecraft(d.minecraft)||!Array.isArray(d.bounds)||d.bounds.length!==6)throw Error('需要受支持的 Minecraft Java / schema 1 的地图数据');const b=d.bounds;if(!b.every(Number.isSafeInteger))throw Error('无效边界');const n=(b[3]-b[0]+1)*(b[4]-b[1]+1)*(b[5]-b[2]+1);if(n<1||n>100000||Object.keys(d.blocks||{}).length!==n)throw Error('区域必须完整，且不超过100000个位置');for(const [key,s]of Object.entries(d.blocks)){const xyz=key.split(',').map(Number);if(xyz.length!==3||xyz.some((v,i)=>!Number.isSafeInteger(v)||v<b[i]||v>b[i+3])||xyz.join(',')!==key)throw Error('无效坐标 '+key);parseState(s)}return d;}
