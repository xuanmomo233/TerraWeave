import {invoke} from '@tauri-apps/api/core';
import {Matrix4,Vector3} from 'three';
import {createTextureAtlas,modelGroupKey} from './textured-world.js';
import {awaitTextures} from './model-terrain.js';
import {callWorkbench} from './workbench-api.js';

const blockEntity=/^minecraft:(?:conduit|chest|trapped_chest|ender_chest|.*_bed|.*_banner|.*_sign|.*_head|.*_skull|.*shulker_box|end_portal)(?:\[|$)/;
const celestialUp=new Vector3(0,1,0);
const toArray=attribute=>Array.from(attribute.array);
const moonNames=['full_moon','waning_gibbous','third_quarter','waning_crescent','new_moon','waxing_crescent','first_quarter','waxing_gibbous'];

async function celestialTextures(minecraft){
 const read=name=>invoke('read_asset',{name:'minecraft/textures/environment/'+name+'.png',minecraft});
 try{return await Promise.all([read('sun'),read('moon_phases')]);}
 catch{
  const [sun,...directory]=await Promise.all([read('celestial/sun'),...moonNames.map(name=>read('celestial/moon/'+name))]);
  const phases=await Promise.all(directory.map(async url=>{
   const image=new Image();image.src=url;await image.decode();return image;
  }));
  const size=Math.max(...phases.map(p=>Math.max(p.width,p.height))),canvas=document.createElement('canvas');
  canvas.width=size*4;canvas.height=size*2;
  const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
  phases.forEach((phase,i)=>ctx.drawImage(phase,i%4*size,Math.floor(i/4)*size,size,size));
  return [sun,canvas.toDataURL('image/png')];
 }
}

function entityId(state,rules,water){
 const [name,properties='']=state.replace(/\]$/,'').split('[');
 const values=new Set(properties.split(','));
 const matches=rules.filter(r=>r.name===(water?'minecraft:water':name)&&r.properties.every(p=>values.has(p)));
 matches.sort((a,b)=>b.properties.length-a.properties.length);
 return matches[0]?.id??-1;
}
function positionsFor(tile,group,cut){
 const out=[];
 for(const n of group.positions){
  const point=[n%32+tile.bounds[0],Math.floor(n/1024)-64,Math.floor(n/32)%32+tile.bounds[2]];
  if(cut&&point.every((v,i)=>v>=cut[i]&&v<=cut[i+3]))continue;
  out.push(point);
 }
 return out;
}
function lightPositions(data){
 const keys=new Set();
 const column=(x,z)=>{keys.add(x+','+z);};
 for(const group of data.lod.enabled?data.lod.meshes.values():[]){
  const tile=group.userData.tile;
  for(let z=tile.z*2-1;z<=tile.z*2+2;z++)for(let x=tile.x*2-1;x<=tile.x*2+2;x++)column(x,z);
 }
 if(!data.region.panorama){
  const b=data.snapshot.bounds;
  for(let z=Math.floor(b[2]/16)-1;z<=Math.floor(b[5]/16)+1;z++){
   for(let x=Math.floor(b[0]/16)-1;x<=Math.floor(b[3]/16)+1;x++)column(x,z);
  }
 }
 return [...keys].sort().map(key=>key.split(',').map(Number));
}

async function collectScene({lod,chunks,snapshot,region},inputs,animationTime){
 const items=[],missing=new Set();
 for(const group of lod.enabled?lod.meshes.values():[]){
  const tile=group.userData.tile;
  for(const g of tile.groups){
   const parts=lod.prepared.get(modelGroupKey(g,tile.minecraft));if(!parts?.length)continue;
   const positions=positionsFor(tile,g,region.panorama?null:snapshot.bounds);
   if(!positions.length)continue;
   for(const part of parts){
    if(part.material.wireframe)missing.add(g.state);
    else items.push({geometry:part.geometry,material:part.material,state:g.state,positions});
   }
  }
 }
 if(!region.panorama)for(const mesh of chunks.meshes()){
  const {ps,s}=mesh.userData;
  if(!ps?.length||!s||/^minecraft:(?:barrier|structure_void|light)(\[|$)/.test(s))continue;
  if(mesh.material.wireframe)missing.add(s);
  else items.push({geometry:mesh.geometry,material:mesh.material,state:s,positions:ps.map(cell=>cell.p)});
 }
 if(!items.length)throw Error(missing.size?'离线光影缺少可渲染方块模型':'离线场景尚未准备好');
 await awaitTextures(items.map(item=>item.material));
 const shared=lod.atlas&&items.every(item=>!item.material.map||lod.atlas.rects.has(item.material.map));
 const textureAtlas=shared?lod.atlas:createTextureAtlas(items.map(item=>item.material));
 try {
  textureAtlas.animate(animationTime);
  const {dimension,rects,canvas}=textureAtlas,models=[],batches=[],cache=new Map(),ids=new Map();
  for(const {geometry,material,state,positions} of items){
   const water=!!material.userData.water;
   const stage=material.transparent?'gbuffers_water':blockEntity.test(state)?'gbuffers_block':'gbuffers_terrain';
   const key=[geometry.id,material.id,stage].join(':');
   let model=cache.get(key);
   if(model===undefined){
    const {x,y,w,h}=rects.get(material.map)??textureAtlas.white;
    const color=material.color?.getHex()??0xffffff;
    model=models.length;cache.set(key,model);
    models.push({positions:toArray(geometry.getAttribute('position')),normals:toArray(geometry.getAttribute('normal')),
     uvs:toArray(geometry.getAttribute('uv')),indices:geometry.index?Array.from(geometry.index.array):null,
     rect:[x/dimension,1-(y+h)/dimension,w/dimension,h/dimension],
     color:[color>>16&255,color>>8&255,color&255],stage});
   }
   const idKey=water?'minecraft:water':state;
   if(!ids.has(idKey))ids.set(idKey,entityId(state,inputs.pack.block_rules,water));
   batches.push({model,positions,entity:ids.get(idKey)});
  }
  const [sun,moon]=await celestialTextures(snapshot.minecraft);
  return {scene:{models,batches,atlas:canvas.toDataURL('image/png'),sun,moon,light:inputs.world.chunks,origin:snapshot.bounds.slice(0,3)},missing:[...missing],atlas:textureAtlas,ownsAtlas:!shared};
 }catch(error){if(!shared)textureAtlas.texture.dispose();throw error;}
}

function celestial(dayTime,tilt){
 const phase=((dayTime/24000-.25)%1+1)%1;
 const smooth=.5-.5*Math.cos(phase*Math.PI);
 const angle=(phase*2+smooth)/3*Math.PI*2;
 return new Vector3(-Math.sin(angle),Math.cos(angle),0).applyAxisAngle(new Vector3(1,0,0),tilt*Math.PI/180);
}
function biomeAt(world,p){
 const [x,y,z]=p.map(Math.floor);
 const chunk=world.chunks.find(c=>c.x===Math.floor(x/16)&&c.z===Math.floor(z/16));
 const section=chunk?.sections.find(s=>s.y===Math.floor(y/16));
 return section?.biomes[(y&15)>>2<<4|(z&15)>>2<<2|(x&15)>>2]??'minecraft:plains';
}
function frameData(camera,region,snapshot,lod,inputs,width,height,start){
 camera.updateMatrixWorld();
 const rotation=camera.matrixWorldInverse.clone().setPosition(0,0,0);
 const sun=celestial(inputs.world.day_time,inputs.pack.sun_path_rotation);
 const light=sun.y>=0?sun.clone():sun.clone().negate();
 const shadowRotation=new Matrix4().lookAt(light,new Vector3(),Math.abs(light.y)>.985?new Vector3(0,0,1):celestialUp).invert();
 const shadowView=shadowRotation.clone().multiply(new Matrix4().makeTranslation(-camera.position.x,-camera.position.y,-camera.position.z));
 const d=inputs.pack.shadow_distance;
 const shadowProjection=new Matrix4().makeOrthographic(-d,d,d,-d,-100.05,156);
 const p=camera.position.toArray().map((n,i)=>n+snapshot.bounds[i]);
 const eye=p.map(Math.floor),key=eye.join(',');
 const eyeBlock=region.panorama?lod.stateAt(...eye):snapshot.blocks[key]??lod.stateAt(...eye);
 const biome=biomeAt(inputs.world,p),swamp=biome==='minecraft:swamp'||biome==='minecraft:mangrove_swamp';
 const temperatures={'minecraft:forest':.7,'minecraft:birch_forest':.6,'minecraft:taiga':.25,'minecraft:snowy_plains':0,'minecraft:desert':2,'minecraft:mangrove_swamp':.8,'minecraft:swamp':.8};
 return {width,height,near:camera.near,far:camera.far,view:camera.matrixWorldInverse.toArray(),
  rotation:rotation.toArray(),inverse_rotation:rotation.clone().invert().toArray(),
  projection:camera.projectionMatrix.toArray(),inverse_projection:camera.projectionMatrixInverse.toArray(),
  shadow_view:shadowView.toArray(),shadow_rotation:shadowRotation.toArray(),shadow_projection:shadowProjection.toArray(),
  camera:p,sun:sun.clone().multiplyScalar(100).applyMatrix4(rotation).toArray(),up:celestialUp.clone().multiplyScalar(100).applyMatrix4(rotation).toArray(),
  shadow_light:light.multiplyScalar(100).applyMatrix4(rotation).toArray(),sun_world:sun.toArray(),
  fog_color:[.753,.847,1],day_time:inputs.world.day_time,moon_phase:inputs.world.moon_phase,
  time_counter:(performance.now()-start)/1000,rain:inputs.world.raining?1:0,biome_temp:temperatures[biome]??.8,
  in_swamp:swamp?1:0,eye_in_water:/^minecraft:lava/.test(eyeBlock??'')?2:/^minecraft:water/.test(eyeBlock??'')?1:0};
}

export class OfflineIrisView{
 constructor(host,say,present){
  this.canvas=document.createElement('canvas');
  this.canvas.className='offline-iris-view';
  this.canvas.hidden=true;
  this.ctx=this.canvas.getContext('2d',{alpha:false});
  this.error=document.createElement('div');
  this.error.className='offline-iris-error';this.error.hidden=true;
  host.append(this.canvas,this.error);
  this.say=say;
  this.present=present;
  this.presented=null;
  this.inputs=null;
  this.inputsKey='';
  this.key='';
  this.start=performance.now();
  this.nextFrameAt=0;
 }
 get active(){return !!this.shader;}
 shouldAnimate(now){
  return this.active&&!document.hidden&&!this.canvas.hidden&&!this.pending&&now>=this.nextFrameAt;
 }
 configure(id){
  if(this.ownsAtlas)this.atlas?.texture.dispose();
  this.atlas=null;this.ownsAtlas=false;
  this.shader=id?.toLowerCase().endsWith('.zip')?id:null;
  this.key='';this.inputs=null;this.inputsKey='';
  this.presented=null;
  this.canvas.hidden=true;this.error.hidden=!this.active;
  this.error.textContent='正在加载原版光影…';
 }
 async draw(data,{exportFrame=false}={}){
  const {key,snapshot,region,camera,lod}=data;
  const animationTime=data.animationTime??performance.now();
  const environment=data.environment_revision??lod.info?.environment_revision??region.environment_revision;
  const source=data.world_revision??(lod.enabled?lod.info?.revision:undefined);
  const lightKey=JSON.stringify([this.shader,region.world_uuid,environment,source,lod.signature,snapshot.bounds]);
  if(this.inputsKey!==lightKey){
   this.inputs=await callWorkbench('offline_iris_inputs',{shader:this.shader,revision:source,environment_revision:environment,chunk_positions:lightPositions(data)});
   this.inputsKey=lightKey;
  }
  const inputs=this.inputs;
  if(inputs.world.world_uuid!==region.world_uuid)throw Error('原版光影输入与当前存档不一致');
  const renderKey=key+':'+inputs.world.environment_revision;
  if(this.key!==renderKey){
   const prepared=await collectScene(data,inputs,animationTime);
   try{await invoke('iris_prepare',{pack:inputs.pack,scene:prepared.scene});}
   catch(error){if(prepared.ownsAtlas)prepared.atlas.texture.dispose();throw error;}
   if(this.ownsAtlas)this.atlas?.texture.dispose();
   this.atlas=prepared.atlas;this.ownsAtlas=prepared.ownsAtlas;
   this.atlasVersion=this.atlas.texture.version;
   this.missing=prepared.missing;
   this.key=renderKey;
  }
  const scale=exportFrame?1:Math.min(1,1920/Math.max(data.width,data.height));
  const width=Math.max(1,Math.floor(data.width*scale)),height=Math.max(1,Math.floor(data.height*scale));
  const frameCamera=exportFrame?camera:camera.clone();
  const frame=frameData(frameCamera,region,snapshot,lod,inputs,width,height,this.start);
  this.atlas.animate(animationTime);
  const atlasVersion=this.atlas.texture.version;
  if(atlasVersion!==this.atlasVersion)frame.atlas_update=this.atlas.canvas.toDataURL('image/png');
  if(exportFrame){frame.reset_history=true;frame.samples=8;}
  const rgba=await invoke('iris_draw',{frame});
  this.atlasVersion=atlasVersion;
  if(exportFrame){
   const output=document.createElement('canvas');
   output.width=width;output.height=height;
   output.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba),width,height),0,0);
   return output;
  }
  if(this.canvas.width!==width||this.canvas.height!==height){this.canvas.width=width;this.canvas.height=height;}
  this.ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba),width,height),0,0);
  this.canvas.hidden=false;this.error.hidden=!this.missing?.length;
  if(this.missing?.length)this.error.textContent='光影预览缺少 '+this.missing.length+' 种方块模型 · '+this.missing.slice(0,3).join('、');
  const previous=this.presented;
  this.presented={key,camera:frameCamera};
  if(!exportFrame&&(!previous||previous.key!==key||
   !previous.camera.matrixWorld.equals(frameCamera.matrixWorld)||
   !previous.camera.projectionMatrix.equals(frameCamera.projectionMatrix)))this.present?.();
  return this.canvas;
 }
 show(data){
  if(data.region.panorama&&!data.lod.meshes.size)return;
  if(this.pending){this.queued=data;return;}
  this.nextFrameAt=performance.now()+1000/30;
  this.pending=this.draw(data).catch(e=>{
   this.presented=null;
   this.present?.();
   this.canvas.hidden=true;
   this.error.hidden=false;
   this.error.textContent=String(e);
   this.say(String(e));
  }).finally(()=>{
   this.pending=null;
   const next=this.queued;this.queued=null;
   if(next&&this.active&&!this.canvas.hidden)this.show(next);
  });
 }
 async capture(data){
  this.queued=null;
  await this.pending;
  const canvas=await this.draw(data,{exportFrame:true});
  this.report={...await invoke('iris_report'),world_revision:this.inputs.world.world_revision,environment_revision:this.inputs.world.environment_revision,missing_models:this.missing??[]};
  return canvas;
 }
}
