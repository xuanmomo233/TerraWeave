import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {worldIndex,readWorldChunk} from './world-surface.mjs';
import {sectionIndices} from './world-volume.mjs';
import {fluidCornerHeights} from './fluid-shape.mjs';
import {assetRoots} from './render-packs.mjs';
import {baselineMinecraft,completeAnvilChunk} from '../minecraft-version.js';
import {blockEntityAppearance} from './block-entity-appearance.mjs';
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
const faces=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]],isAir=s=>/^minecraft:(air|cave_air|void_air|structure_void|light)(\[|$)/.test(s),invisible=s=>/^minecraft:(barrier|structure_void|light)(\[|$)/.test(s);
const stateName=p=>p.Name+(p.Properties?'['+Object.entries(p.Properties).sort().map(([k,v])=>k+'='+v).join(',')+']':'');
function json(name,minecraft){const key=minecraft+':'+name;if(!jsonCache.has(key)){const candidates=overlays.map(root=>path.join(root,'minecraft',name));const vanilla=minecraft===baselineMinecraft?assets:path.join(path.dirname(assets),'vanilla',minecraft,'minecraft');const file=candidates.find(f=>fs.existsSync(f))??path.join(vanilla,name);jsonCache.set(key,JSON.parse(fs.readFileSync(file,'utf8')));}return jsonCache.get(key);}
function model(name,minecraft,depth=0){if(depth>24)throw Error('Model parent cycle');const m=json('models/'+name.replace('minecraft:','')+'.json',minecraft);return m.elements?m:m.parent?{...model(m.parent,minecraft,depth+1),...m}:m;}
export function fullCubeOccluder(state,minecraft=baselineMinecraft){
 const key=minecraft+':'+state;if(solidCache.has(key))return solidCache.get(key);let solid=false;
 try{const name=state.split('[')[0].replace('minecraft:','');if(!/glass|leaves|ice|slime|honey|spawner|barrier|light|water|lava|powder_snow/.test(name)){const props=Object.fromEntries((/\[([^\]]+)\]/.exec(state)?.[1]??'').split(',').filter(Boolean).map(s=>s.split('='))),bs=json('blockstates/'+name+'.json',minecraft),entry=Object.entries(bs.variants??{}).find(([key])=>!key||key.split(',').every(p=>{const [k,v]=p.split('=');return v.split('|').includes(props[k]);}));if(entry){const variant=Array.isArray(entry[1])?entry[1][0]:entry[1],m=model(variant.model,minecraft);solid=m.elements?.some(e=>!e.rotation&&e.from.every(n=>n===0)&&e.to.every(n=>n===16)&&Object.keys(e.faces).length===6)??false;}}}catch{}
 solidCache.set(key,solid);return solid;
}
const fluid=s=>/^minecraft:(water|lava)(\[|$)/.exec(s??'')?.[1]??(/waterlogged=true/.test(s??'')?'water':null);
export function fluidCorners(x,y,z,kind,get,minecraft=baselineMinecraft){
 return fluidCornerHeights(x,y,z,kind,get,s=>fullCubeOccluder(s,minecraft));
}
export function modelTile(tx,tz,root,index=worldIndex()){
 refreshModelAssets();
 if(![tx,tz].every(Number.isSafeInteger)||Math.abs(tx)>1000000||Math.abs(tz)>1000000)throw Error('Invalid model tile');const minecraft=index.minecraft??baselineMinecraft,minX=tx*32,minZ=tz*32,regions=index.regions.filter(r=>r.x*512<minX+33&&(r.x+1)*512>minX-1&&r.z*512<minZ+33&&(r.z+1)*512>minZ-1),revision=createHash('sha256').update(JSON.stringify([index.world_uuid,index.region_directory,minecraft,regions.map(r=>[r.x,r.z,r.mtime,r.size])])).update(packRevision).digest('hex'),file=path.join(root,`models-${tx}-${tz}.json`);
 try{const old=JSON.parse(fs.readFileSync(file,'utf8'));if(old.version===4&&old.revision===revision)return old;}catch{}
 const names=['minecraft:air'],ids=new Map([[names[0],0]]),chunks=new Map(),unknown=new Set(),idFor=s=>{if(!ids.has(s)){ids.set(s,names.length);names.push(s);}return ids.get(s);};
 function chunk(cx,cz){const key=cx+','+cz;if(chunks.has(key))return chunks.get(key);let n;try{n=readWorldChunk(cx,cz,index.directory);}catch{}if(!completeAnvilChunk(n)){chunks.set(key,null);unknown.add(key);return null;}const sections=new Map();for(const s of n.sections??[]){if(!s.block_states?.palette)continue;const local=sectionIndices(s);if(!local)continue;const palette=s.block_states.palette.map(p=>idFor(stateName(p))),cells=new Uint32Array(4096);for(let i=0;i<4096;i++)cells[i]=palette[local[i]];sections.set(s.Y,cells);}const entities=new Map();for(const entity of n.block_entities??[]){const appearance=blockEntityAppearance(entity);if(appearance)entities.set([entity.x,entity.y,entity.z].join(),appearance);}const result={sections,entities};chunks.set(key,result);return result;}
 function at(x,y,z){if(y< -64||y>319)return 0;const c=chunk(Math.floor(x/16),Math.floor(z/16));if(!c)return -1;const section=c.sections.get(Math.floor(y/16));return section?.[((y%16+16)%16)*256+((z%16+16)%16)*16+(x%16+16)%16]??0;}
 const get=(x,y,z)=>{const n=at(x,y,z);return n<0?null:names[n];},groups=new Map(),block_entities={};let total=0,visible=0;
 for(let cz=Math.floor(minZ/16);cz<Math.floor(minZ/16)+2;cz++)for(let cx=Math.floor(minX/16);cx<Math.floor(minX/16)+2;cx++){const c=chunk(cx,cz);if(!c)continue;for(const [sectionY,cells]of c.sections)for(let i=0;i<4096;i++){const s=names[cells[i]];if(!s||isAir(s))continue;total++;const x=cx*16+i%16,y=sectionY*16+Math.floor(i/256),z=cz*16+Math.floor(i/16)%16;if(y< -64||y>319)continue;
   const kind=fluid(s);let mask=0,fluidMask=0;for(let f=0;f<6;f++){const d=faces[f],neighbor=get(x+d[0],y+d[1],z+d[2]),solid=neighbor!==null&&fullCubeOccluder(neighbor,minecraft);if(solid)mask|=1<<f;if(solid||kind&&fluid(neighbor)===kind)fluidMask|=1<<f;}
   if((kind?fluidMask:mask)===63&&!invisible(s))continue;const location=[x,y,z].join(),appearance=c.entities.get(location);if(appearance?.kind==='container')block_entities[location]=appearance;const block_entity=appearance?.kind==='container'?undefined:appearance,corners=kind?fluidCorners(x,y,z,kind,get,minecraft):undefined,key=[cells[i],mask,kind?fluidMask:0,corners?.join(',')??'',JSON.stringify(block_entity)??''].join('|');if(!groups.has(key))groups.set(key,{state:s,mask,fluid_mask:kind?fluidMask:0,fluid_corners:corners,block_entity,positions:[]});groups.get(key).positions.push((y+64)*1024+(z-minZ)*32+x-minX);visible++;
  }}
 const result={version:4,block_entities,minecraft,x:tx,z:tz,bounds:[minX,-64,minZ,minX+32,320,minZ+32],groups:[...groups.values()],total_non_air:total,visible_blocks:visible,unreadable_chunks:[...unknown].map(s=>s.split(',').map(Number)),revision,source:'saved_anvil_exact_models'};fs.mkdirSync(root,{recursive:true});const temp=file+'.pending-'+process.pid;fs.writeFileSync(temp,JSON.stringify(result));fs.renameSync(temp,file);const files=fs.readdirSync(root).filter(n=>/^models-.*\.json$/.test(n));if(files.length>192){const ordered=files.flatMap(n=>{try{return[{n,t:fs.statSync(path.join(root,n)).mtimeMs}];}catch{return[];}}).sort((a,b)=>a.t-b.t);for(const old of ordered.slice(0,files.length-192))try{fs.unlinkSync(path.join(root,old.n));}catch(e){if(e.code!=='ENOENT')throw e;}}
 return result;
}
