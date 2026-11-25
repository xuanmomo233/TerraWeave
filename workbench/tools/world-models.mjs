import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {worldIndex,readWorldChunk} from './world-surface.mjs';
import {sectionIndices} from './world-volume.mjs';
import {fluidBlockKind,fluidCornerHeights,fluidKind as fluid} from './fluid-shape.mjs';
import {variantChoices} from './model-variants.mjs';
import {assetRoots} from './render-packs.mjs';
import {baselineMinecraft,completeAnvilChunk} from '../minecraft-version.js';
import {blockEntityAppearance} from './block-entity-appearance.mjs';
import {modelProperties} from './block-state-catalog.mjs';
const assets=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../assets/minecraft'),jsonCache=new Map(),solidCache=new Map();
const settings=path.join(path.dirname(assets),'render-settings.json');
let overlays=[],packRevision;
function refreshModelAssets(){
 const revision=fs.existsSync(settings)?fs.readFileSync(settings,'utf8'):'';
 if(packRevision===revision)return;
 overlays=assetRoots(path.dirname(assets));packRevision=revision;
 jsonCache.clear();solidCache.clear();
}
refreshModelAssets();
const isAir=s=>/^minecraft:(air|cave_air|void_air|structure_void|light)(\[|$)/.test(s),invisible=s=>/^minecraft:(barrier|structure_void|light)(\[|$)/.test(s);
const stateName=p=>p.Name+(p.Properties?'['+Object.entries(p.Properties).sort().map(([k,v])=>k+'='+v).join(',')+']':'');
function json(name,minecraft){const key=minecraft+':'+name;if(!jsonCache.has(key)){const candidates=overlays.map(root=>path.join(root,'minecraft',name));const vanilla=minecraft===baselineMinecraft?assets:path.join(path.dirname(assets),'vanilla',minecraft,'minecraft');const file=candidates.find(f=>fs.existsSync(f))??path.join(vanilla,name);jsonCache.set(key,JSON.parse(fs.readFileSync(file,'utf8')));}return jsonCache.get(key);}
function model(name,minecraft,depth=0){if(depth>24)throw Error('Model parent cycle');const m=json('models/'+name.replace('minecraft:','')+'.json',minecraft);return m.elements?m:m.parent?{...model(m.parent,minecraft,depth+1),...m}:m;}
export function fullCubeOccluder(state,minecraft=baselineMinecraft){
 const key=minecraft+':'+state;if(solidCache.has(key))return solidCache.get(key);let solid=false;
 try{const name=state.split('[')[0].replace('minecraft:','');if(!/glass|leaves|ice|slime|honey|spawner|barrier|light|water|lava|powder_snow/.test(name)){const props=Object.fromEntries((/\[([^\]]+)\]/.exec(state)?.[1]??'').split(',').filter(Boolean).map(s=>s.split('='))),bs=json('blockstates/'+name+'.json',minecraft);if(!bs.multipart)solid=variantChoices(bs,modelProperties('minecraft:'+name,props,minecraft))[0].every(v=>model(v.model,minecraft).elements?.some(e=>!e.rotation&&e.from.every(n=>n===0)&&e.to.every(n=>n===16)&&Object.keys(e.faces).length===6));}}catch{}
 solidCache.set(key,solid);return solid;
}
export function fluidCorners(x,y,z,kind,get,minecraft=baselineMinecraft){
 return fluidCornerHeights(x,y,z,kind,get,s=>fullCubeOccluder(s,minecraft));
}
function renderHash(tile){
 return createHash('sha256').update(JSON.stringify([tile.minecraft,tile.groups,tile.block_entities])).digest('hex');
}
export function modelTile(tx,tz,root,index=worldIndex(),construction){
 refreshModelAssets();
 if(![tx,tz].every(Number.isSafeInteger)||Math.abs(tx)>1000000||Math.abs(tz)>1000000)throw Error('Invalid model tile');const minecraft=index.minecraft??baselineMinecraft,minX=tx*32,minZ=tz*32,regions=index.regions.filter(r=>r.x*512<minX+33&&(r.x+1)*512>minX-1&&r.z*512<minZ+33&&(r.z+1)*512>minZ-1),revision=createHash('sha256').update(JSON.stringify([index.world_uuid,index.region_directory,minecraft,regions.map(r=>[r.x,r.z,r.mtime,r.size])])).update(packRevision).update(construction?.tileKey(tx,tz)??'').digest('hex'),file=path.join(root,`models-${tx}-${tz}.json`);
 const cacheVersion=8;
 try{const old=JSON.parse(fs.readFileSync(file,'utf8'));if(old.version===cacheVersion&&old.revision===revision){old.render_hash??=renderHash(old);return old;}}catch{}
 const names=['minecraft:air'],traits=[{air:true}],ids=new Map([[names[0],0]]),chunks=new Map(),unknown=new Set();
 function idFor(state){
  if(!ids.has(state)){
   const air=isAir(state);
   ids.set(state,names.length);
   names.push(state);
   traits.push({air,helper:invisible(state),solid:!air&&fullCubeOccluder(state,minecraft),kind:fluid(state),fluidOnly:!!fluidBlockKind(state)});
  }
  return ids.get(state);
 }
 function chunk(cx,cz){const key=cx+','+cz;if(chunks.has(key))return chunks.get(key);let n;try{n=readWorldChunk(cx,cz,index.directory);}catch{}if(!completeAnvilChunk(n)){chunks.set(key,null);unknown.add(key);return null;}const sections=new Map();for(const s of n.sections??[]){if(!s.block_states?.palette)continue;const local=sectionIndices(s);if(!local)continue;const palette=s.block_states.palette.map(p=>idFor(stateName(p))),cells=new Uint32Array(4096);for(let i=0;i<4096;i++)cells[i]=palette[local[i]];sections.set(s.Y,cells);}const entities=new Map();for(const entity of n.block_entities??[]){const appearance=blockEntityAppearance(entity);if(appearance)entities.set([entity.x,entity.y,entity.z].join(),appearance);}
  if(construction){
   const generated=construction.generated,handled=new Map();
   for(const [x,y,z,resolve] of construction.chunk(cx,cz)){
    const section=Math.floor(y/16),i=(y&15)*256+(z&15)*16+(x&15),cells=sections.get(section);
    if(generated){
     if(!handled.has(section))handled.set(section,new Set());
     handled.get(section).add(i);
    }
    const actual=names[cells?.[i]??0],shown=resolve(actual);
    if(shown===actual)continue;
    if(!cells)sections.set(section,new Uint32Array(4096));
    sections.get(section)[i]=idFor(shown);
    entities.delete([x,y,z].join(','));
   }
   if(generated){
    for(const cy of generated.restoreSections(cx,cz))if(!sections.has(cy))sections.set(cy,new Uint32Array(4096));
    for(const [cy,cells] of sections)generated.section(cx,cz,cy,cells,names,idFor,handled.get(cy));
   }
  }
  const result={sections,entities};chunks.set(key,result);return result;
 }
 function at(x,y,z){if(y< -64||y>319)return 0;const c=chunk(Math.floor(x/16),Math.floor(z/16));if(!c)return -1;const section=c.sections.get(Math.floor(y/16));return section?.[((y%16+16)%16)*256+((z%16+16)%16)*16+(x%16+16)%16]??0;}
 const get=(x,y,z)=>{const n=at(x,y,z);return n<0?null:names[n];},groups=new Map(),block_entities={};let total=0,visible=0;
 const around=new Int32Array(6);
 for(let cz=minZ/16;cz<minZ/16+2;cz++)for(let cx=minX/16;cx<minX/16+2;cx++){
  const c=chunk(cx,cz);
  if(!c)continue;
  const x0=cx*16,z0=cz*16;
  for(const [sectionY,cells] of c.sections){
   const y0=sectionY*16;
   if(y0< -64||y0>319)continue;
   const below=c.sections.get(sectionY-1),above=c.sections.get(sectionY+1);
   for(let i=0;i<4096;i++){
    const material=traits[cells[i]];
    if(material.air)continue;
    total++;
    const a=i&15,b=i>>8,d=(i>>4)&15,x=x0+a,y=y0+b,z=z0+d,kind=material.kind;
    around[0]=a<15?cells[i+1]:at(x+1,y,z);
    around[1]=a>0?cells[i-1]:at(x-1,y,z);
    around[2]=b<15?cells[i+256]??0:y===319?0:above?.[i-3840]??0;
    around[3]=b>0?cells[i-256]??0:y===-64?0:below?.[i+3840]??0;
    around[4]=d<15?cells[i+16]:at(x,y,z+1);
    around[5]=d>0?cells[i-16]:at(x,y,z-1);
    let mask=0,fluidMask=0;
    for(let f=0;f<6;f++){
     const neighbor=traits[around[f]];
     if(neighbor?.solid)mask|=1<<f;
     if(neighbor?.solid||kind&&neighbor?.kind===kind)fluidMask|=1<<f;
    }
    const state=names[cells[i]];
    if((material.fluidOnly?fluidMask:mask)===63&&!material.helper)continue;
    const location=[x,y,z].join(),appearance=c.entities.get(location);
    if(appearance?.kind==='container')block_entities[location]=appearance;
    const block_entity=appearance?.kind==='container'?undefined:appearance;
    const corners=kind&&fluidMask!==63?fluidCorners(x,y,z,kind,get,minecraft):undefined;
    const key=[cells[i],mask,kind?fluidMask:0,corners?.join(',')??'',JSON.stringify(block_entity)??''].join('|');
    if(!groups.has(key))groups.set(key,{state,mask,fluid_mask:kind?fluidMask:0,fluid_corners:corners,block_entity,positions:[]});
    groups.get(key).positions.push((y+64)*1024+(z-minZ)*32+x-minX);
    visible++;
   }
  }
 }
 const result={version:cacheVersion,block_entities,minecraft,x:tx,z:tz,bounds:[minX,-64,minZ,minX+32,320,minZ+32],groups:[...groups.values()],total_non_air:total,visible_blocks:visible,unreadable_chunks:[...unknown].map(s=>s.split(',').map(Number)),revision,source:'saved_anvil_exact_models'};
 result.render_hash=renderHash(result);
 fs.mkdirSync(root,{recursive:true});
 const temp=file+'.pending-'+process.pid;
 fs.writeFileSync(temp,JSON.stringify(result));
 fs.renameSync(temp,file);
 const files=fs.readdirSync(root).filter(name=>/^models-.*\.json$/.test(name));
 if(files.length>384){
  const ordered=files.flatMap(name=>{
   const stat=fs.statSync(path.join(root,name),{throwIfNoEntry:false});
   return stat?[{name,time:stat.mtimeMs}]:[];
  }).sort((a,b)=>a.time-b.time);
  for(const entry of ordered.slice(0,Math.max(0,ordered.length-384))){
   try{fs.unlinkSync(path.join(root,entry.name));}catch(error){if(error.code!=='ENOENT')throw error;}
  }
 }
 return result;
}
