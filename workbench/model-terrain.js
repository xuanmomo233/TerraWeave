import {invoke} from '@tauri-apps/api/core';
import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {fluidGeometry} from './fluid-geometry.js';
import {specialModel} from './special-models.js';
import {baselineMinecraft,supportedMinecraft} from './minecraft-version.js';
import {dyes} from './tools/block-entity-appearance.mjs';
const cache=new Map(), mats=new Map(), loader=new THREE.TextureLoader();
async function json(url,minecraft=baselineMinecraft){const key=minecraft+'|'+url;if(!cache.has(key))cache.set(key,invoke('read_asset',{name:url.replace('/assets/',''),minecraft}).then(JSON.parse));return cache.get(key)}
async function model(id,read=json,seen=new Set()){
 if(seen.has(id)||seen.size>30)throw Error('Model parent cycle '+id);seen.add(id);
 const m=await read('/assets/minecraft/models/'+id.replace('minecraft:','')+'.json');
 if(m.parent){const p=await model(m.parent,read,seen);return {...p,...m,textures:{...p.textures,...m.textures},elements:m.elements||p.elements}}return m;
}
function textureName(t,tex){for(let i=0;t?.startsWith('#')&&i<20;i++)t=tex[t.slice(1)];if(!t||t.startsWith('#'))throw Error('Unresolved texture '+t);return t.replace('minecraft:','')}
export function materialSettings(id,tint=false){
 if(Number.isInteger(tint))return {color:tint,alphaTest:.1};
 if(tint&&id==='lily_pad')return {color:0x208030,alphaTest:.1};
 if(id==='water')return {transparent:true,opacity:.72,depthWrite:false,side:THREE.DoubleSide,color:0x3f76e4};
 if(id==='lava')return {color:0xffffff,emissive:0xffffff,emissiveIntensity:.7};
 if(tint&&/_banner$/.test(id))return {color:dyes[id.replace(/(?:_wall)?_banner$/,'')]??0xf9fffe};
 if(id==='barrier'||id==='structure_void')return {alphaTest:.1,transparent:true,depthWrite:false,side:THREE.DoubleSide,color:0xffffff};
 const blend=/^(?:.*_stained_glass(?:_pane)?|tinted_glass|ice)$/.test(id);
 return {alphaTest:blend?.01:.1,transparent:blend,depthWrite:!blend,side:THREE.FrontSide,color:tint?(/water_cauldron/.test(id)?0x3f76e4:/birch/.test(id)?0x80a755:/spruce/.test(id)?0x619961:0x91bd59):0xffffff};
}
function material(t,id,tint,minecraft=baselineMinecraft){
 const key=minecraft+'|'+t+'|'+id+'|'+tint;if(mats.has(key))return mats.get(key);const map=new THREE.Texture();map.userData.source=t;
 map.userData.ready=invoke('read_asset',{name:'minecraft/textures/'+t+'.png',minecraft}).then(url=>new Promise((resolve,reject)=>loader.load(url,texture=>{map.image=texture.image;if(t.startsWith('block/')&&map.image.height>map.image.width){map.userData.frameHeight=map.image.width;map.repeat.y=map.image.width/map.image.height;map.offset.y=1-map.repeat.y;}map.needsUpdate=true;resolve();},undefined,reject))).catch(e=>map.userData.loadError=t+': '+String(e));
 map.magFilter=THREE.NearestFilter;map.minFilter=THREE.NearestFilter;map.colorSpace=THREE.SRGBColorSpace;const invisible=id==='barrier'||id==='structure_void',mat=new (invisible?THREE.MeshBasicMaterial:THREE.MeshLambertMaterial)({map,...materialSettings(id,tint)});if(id==='lava')mat.emissiveMap=map;
 if(invisible){mat.customProgramCacheKey=()=> 'invisible-block-billboard';mat.onBeforeCompile=shader=>{shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>','vec4 glyphCenter=vec4(0.5,0.5,0.5,1.0);\n#ifdef USE_INSTANCING\nglyphCenter=instanceMatrix*glyphCenter;\n#endif\nvec4 mvPosition=modelViewMatrix*glyphCenter;mvPosition.xy+=position.xy-vec2(0.5);gl_Position=projectionMatrix*mvPosition;');};}if(id==='water')mat.userData.water=true;mats.set(key,mat);return mat;
}
export async function awaitTextures(materials){const maps=[...new Set(materials.flat().map(m=>m?.map).filter(Boolean))];await Promise.all(maps.map(m=>m.userData.ready));const errors=maps.map(m=>m.userData.loadError).filter(Boolean);if(errors.length)throw Error('材质尚未就绪：'+errors.join('; '));}
export function parseState(s){const m=/^minecraft:([a-z0-9_]+)(?:\[([^\]]+)\])?$/.exec(s);if(!m)throw Error('Invalid state '+s);return {id:m[1],props:Object.fromEntries((m[2]||'').split(',').filter(Boolean).map(x=>x.split('=')))}}
export function matches(c,p){if(!c)return true;return Object.entries(c).every(([k,v])=>k==='OR'?v.some(x=>matches(x,p)):k==='AND'?v.every(x=>matches(x,p)):String(v).split('|').includes(p[k]));}
export function selectVariants(bs,p){
 const first=x=>Array.isArray(x)?x[0]:x;
 if(bs.multipart)return bs.multipart.filter(x=>matches(x.when,p)).map(x=>first(x.apply));
 const m=Object.entries(bs.variants||{}).find(([k])=>!k||k.split(',').every(x=>{const [a,b]=x.split('=');return b.split('|').includes(p[a])}));
 if(!m)throw Error('状态无对应模型');return [first(m[1])];
}
const opaqueCache=new Map();
export function opaqueModel(state,minecraft=baselineMinecraft){const key=minecraft+"|"+state,read=url=>json(url,minecraft);if(!opaqueCache.has(key))opaqueCache.set(key,(async()=>{try{const {id,props}=parseState(state);if(/glass|leaves|ice|slime|honey|spawner|barrier|light|water|lava|powder_snow/.test(id))return false;const bs=await read('/assets/minecraft/blockstates/'+id+'.json');if(bs.multipart)return false;const variant=selectVariants(bs,props)[0],m=await model(variant.model,read);return m.elements?.some(e=>!e.rotation&&e.from.every(n=>n===0)&&e.to.every(n=>n===16)&&Object.keys(e.faces).length===6)??false;}catch{return false;}})());return opaqueCache.get(key);}
const special=/^(water|lava|bubble_column|moving_piston|chest|trapped_chest|ender_chest|.*_bed|.*_banner|.*_sign|.*_hanging_sign|.*_head|.*_skull|.*shulker_box|end_portal|end_gateway)$/;
export const invisibleMarkerMaterial=()=>material('item/barrier','barrier',false);
export async function buildState(s,options={}){
 const {id,props}=parseState(s);
 const read=options.readJson??(url=>json(url,options.minecraft));
 const mkmat=options.makeMaterial??((...args)=>material(...args,options.minecraft));
 if(['barrier','structure_void','light'].includes(id)){if(!options.showInvisible||id==='light')return [];return [{geometry:new THREE.PlaneGeometry(.86,.86).translate(.5,.5,.5),material:mkmat('item/'+id,id,false)}];}
 if(id==='water'||id==='lava'){const level=Number(props.level??0),height=level>=8?8/9:Math.max(1/9,(8-level)/9);return [{geometry:fluidGeometry(options.fluidCorners??[height,height,height,height],options.fluidMask??options.occlusionMask??0),material:mkmat('block/'+id+(level>0?'_flow':'_still'),id,false)}];}
 if(props.waterlogged==='true'){const dry=s.replace('waterlogged=true','waterlogged=false'),parts=await buildState(dry,options),water=await buildState('minecraft:water[level=0]',{...options,occlusionMask:options.fluidMask??0});return [...parts,...water];}
 const entity=specialModel(id,props,mkmat,options.blockEntity,options.minecraft);if(entity)return entity;
 if(special.test(id))throw Error('需要方块实体渲染器: '+s);
 const bs=await read('/assets/minecraft/blockstates/'+id+'.json'),variants=selectVariants(bs,props),byTex=new Map();
 for(const v of variants){const m=await model(v.model,read);if(!m.elements?.length)throw Error('模型需要特殊渲染: '+s);
 for(const e of m.elements){const [x,y,z]=e.from.map(n=>n/16),[X,Y,Z]=e.to.map(n=>n/16);
 const vertices={south:[[x,y,Z],[X,y,Z],[X,Y,Z],[x,Y,Z]],north:[[X,y,z],[x,y,z],[x,Y,z],[X,Y,z]],east:[[X,y,Z],[X,y,z],[X,Y,z],[X,Y,Z]],west:[[x,y,z],[x,y,Z],[x,Y,Z],[x,Y,z]],up:[[x,Y,Z],[X,Y,Z],[X,Y,z],[x,Y,z]],down:[[x,y,z],[X,y,z],[X,y,Z],[x,y,Z]]};
 const defaultUV={up:[x,z,X,Z],down:[x,1-Z,X,1-z],north:[1-X,1-Y,1-x,1-y],south:[x,1-Y,X,1-y],west:[z,1-Y,Z,1-y],east:[1-Z,1-Y,1-z,1-y]};
 for(const [face,f]of Object.entries(e.faces)){
 if(f.cullface&&options.occlusionMask){const directions={east:[1,0,0],west:[-1,0,0],up:[0,1,0],down:[0,-1,0],south:[0,0,1],north:[0,0,-1]},normal=new THREE.Vector3(...directions[f.cullface]).applyEuler(new THREE.Euler(-(v.x??0)*Math.PI/180,-(v.y??0)*Math.PI/180,0,'YXZ')),axis=normal.toArray().map(n=>Math.round(n)),index=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].findIndex(d=>d.every((n,i)=>n===axis[i]));if(index>=0&&options.occlusionMask&(1<<index))continue;}
 const a=vertices[face];if(!a)throw Error('Unknown face '+face);const uv=f.uv||defaultUV[face].map(n=>n*16);
 let u=[[uv[0]/16,1-uv[3]/16],[uv[2]/16,1-uv[3]/16],[uv[2]/16,1-uv[1]/16],[uv[0]/16,1-uv[1]/16]];
 for(let i=0;i<(f.rotation||0)/90;i++)u.unshift(u.pop());
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(a.flat(),3));g.setAttribute('uv',new THREE.Float32BufferAttribute(u.flat(),2));g.setIndex([0,1,2,0,2,3]);
 if(e.rotation){const r=e.rotation,origin=r.origin.map(n=>n/16),angle=r.angle*Math.PI/180;if(!['x','y','z'].includes(r.axis))throw Error('Unknown rotation axis');g.translate(...origin.map(n=>-n));g['rotate'+r.axis.toUpperCase()](angle);if(r.rescale){const scale=[1,1,1],axis='xyz'.indexOf(r.axis);for(let i=0;i<3;i++)if(i!==axis)scale[i]=1/Math.cos(angle);g.scale(...scale)}g.translate(...origin)}
 g.translate(-.5,-.5,-.5);g.rotateX(-(v.x||0)*Math.PI/180);g.rotateY(-(v.y||0)*Math.PI/180);g.translate(.5,.5,.5);g.computeVertexNormals();
 const t=textureName(f.texture,m.textures),tint=f.tintindex!==undefined,key=t+'|'+tint;if(tint&&!/^(grass_block|grass|short_grass|tall_grass|fern|large_fern|vine|bamboo|sugar_cane|water_cauldron|lily_pad|.*_leaves)$/.test(id))throw Error('尚未支持此方块的专用染色: '+s);if(!byTex.has(key))byTex.set(key,{t,tint,gs:[]});byTex.get(key).gs.push(g);
 }} }
 if(!byTex.size){if(options.occlusionMask)return [];throw Error('No renderable faces '+s);}
 return [...byTex.values()].map(({t,tint,gs})=>({geometry:mergeGeometries(gs),material:mkmat(t,id,tint)}));
}
export function validate(d){if(d.schema!==1||!supportedMinecraft(d.minecraft)||!Array.isArray(d.bounds)||d.bounds.length!==6)throw Error('需要受支持的 Minecraft Java / schema 1 的地图数据');const b=d.bounds;if(!b.every(Number.isSafeInteger))throw Error('无效边界');const n=(b[3]-b[0]+1)*(b[4]-b[1]+1)*(b[5]-b[2]+1);if(n<1||n>100000||Object.keys(d.blocks||{}).length!==n)throw Error('区域必须完整，且不超过100000个位置');for(const [key,s]of Object.entries(d.blocks)){const xyz=key.split(',').map(Number);if(xyz.length!==3||xyz.some((v,i)=>!Number.isSafeInteger(v)||v<b[i]||v>b[i+3])||xyz.join(',')!==key)throw Error('无效坐标 '+key);parseState(s)}return d;}
