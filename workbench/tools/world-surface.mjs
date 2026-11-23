import fs from 'node:fs';
import path from 'node:path';
import {inflateSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {overworldRegionDirectory,worldSource} from './world-source.mjs';
import {baselineMinecraft,completeAnvilChunk,javaReleases,supportedDataVersion,supportedMinecraft} from '../minecraft-version.js';
import {decodeAnvilLz4} from './anvil-lz4.mjs';
import {normalizeAnvilPalette} from './anvil-block-palette.mjs';
import {parseNbt,readLevelNbt} from './nbt.mjs';
export {parseNbt,readLevelNbt} from './nbt.mjs';

let lastIndex;
export function worldIndex(source=worldSource()){
 const directory=source?.error?undefined:source?.directory;
 const region_directory=directory?source.region_directory:null;
 const regions=[],chunks=[];
 const regionFiles=region_directory?fs.readdirSync(region_directory).filter(name=>/^r\.-?\d+\.-?\d+\.mca$/.test(name)).sort():[];
 const files=regionFiles.map(file=>{const name=path.join(region_directory,file);return {file,name,stat:fs.statSync(name)};});
 const level=directory?fs.statSync(path.join(directory,'level.dat')):null;
 const environment=directory?[path.join(directory,'data/minecraft/world_clocks.dat'),
  path.join(directory,'dimensions/minecraft/overworld/data/minecraft/weather.dat')].map(file=>{
  const s=fs.statSync(file,{throwIfNoEntry:false});return [s?.size,s?.mtimeMs];
 }):[];
 const stamp=JSON.stringify([source,level?.mtimeMs,level?.size,environment,files.map(({file,stat})=>[file,stat.size,stat.mtimeMs])]);
 if(lastIndex?.stamp===stamp)return lastIndex.index;
 const meta=level?readLevelNbt(path.join(directory,'level.dat'))?.Data:null;
 if(level&&!meta)throw Error('无法读取存档的 level.dat');
 const version=meta?.Version?.Name,data_version=meta?.DataVersion??meta?.Version?.Id;
 if(data_version!==undefined&&!supportedDataVersion(data_version)||version!==undefined&&!supportedMinecraft(version))
  throw Error('此存档版本超出当前读取范围：'+(version??data_version));
 if(version&&data_version!==undefined&&javaReleases[version]!==data_version)
  throw Error('存档版本 '+version+' 与 DataVersion '+data_version+' 不一致');
 for(const {file,name,stat} of files){const match=/^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(file);if(stat.size<8192)continue;
  const header=Buffer.alloc(4096),fd=fs.openSync(name,'r');try{fs.readSync(fd,header,0,4096,0);}finally{fs.closeSync(fd);}
  const rx=Number(match[1]),rz=Number(match[2]);let count=0;
  for(let i=0;i<1024;i++){const entry=header.readUInt32BE(i*4),sector=entry>>>8;if(sector<2||!(entry&255)||sector*4096+5>stat.size)continue;chunks.push([rx*32+i%32,rz*32+Math.floor(i/32)]);count++;}
  if(count)regions.push({x:rx,z:rz,file:name,size:stat.size,mtime:stat.mtimeMs,chunks:count});
 }
 const void_world=source?.void_world;
 const [x,,z]=void_world?.spawn??[0,0,0];
 const initial=void_world?[x-48,z-48,x+47,z+47]:[Infinity,Infinity,-Infinity,-Infinity];
 const bounds=chunks.reduce((b,[x,z])=>[Math.min(b[0],x*16),Math.min(b[1],z*16),Math.max(b[2],x*16+15),Math.max(b[3],z*16+15)],initial);
 const minecraft=version??baselineMinecraft;
 const revision=createHash('sha256').update(JSON.stringify([source?.world_uuid,minecraft,region_directory,regions.map(r=>[r.x,r.z,r.size,r.mtime])])).digest('hex');
 const environment_revision=level?createHash('sha256').update(JSON.stringify([revision,level.mtimeMs,level.size,environment])).digest('hex'):null;
 const index={directory,region_directory,world:source?.world,world_uuid:source?.world_uuid,paper_world_uuid:source?.paper_world_uuid,void_world,pristine_void:!!void_world&&!regionFiles.length,dimension:'minecraft:overworld',minecraft,data_version,bounds:chunks.length||void_world?bounds:null,chunk_count:chunks.length,region_count:regions.length,regions,chunks,revision,environment_revision,source:'saved_anvil_surface',limits:'Existing generated overworld only. Unknown or incomplete data stays unknown. Surface colors are a material approximation, not client lighting.'};
 lastIndex={stamp,index};return index;
}
export function savedWorldCamera(index){
 if(!index.directory||!index.bounds)return null;
 const usable=pos=>Array.isArray(pos)&&pos.length===3&&pos.every(Number.isFinite)&&
  pos[0]>=index.bounds[0]&&pos[0]<=index.bounds[2]+1&&pos[2]>=index.bounds[1]&&pos[2]<=index.bounds[3]+1;
 const camera=player=>{
  if(!player||!usable(player.Pos)||(player.Dimension!==undefined&&player.Dimension!=='minecraft:overworld'&&player.Dimension!==0))return null;
  const position=[player.Pos[0],player.Pos[1]+1.62,player.Pos[2]];
  const [yaw=0,pitch=0]=(Array.isArray(player.Rotation)?player.Rotation:[]).map(n=>Number.isFinite(n)?n*Math.PI/180:0);
  return {mode:'free',world_uuid:index.world_uuid,position,target:[position[0]-Math.sin(yaw)*Math.cos(pitch)*24,position[1]-Math.sin(pitch)*24,position[2]+Math.cos(yaw)*Math.cos(pitch)*24]};
 };
 const data=readLevelNbt(path.join(index.directory,'level.dat'))?.Data;
 const single=camera(data?.Player);if(single)return single;
 for(const relative of ['players/data','playerdata']){
  const directory=path.join(index.directory,relative);
  if(!fs.statSync(directory,{throwIfNoEntry:false})?.isDirectory())continue;
  const recent=fs.readdirSync(directory).filter(name=>/^[a-f0-9-]{36}\.dat$/i.test(name))
   .map(name=>{const file=path.join(directory,name);return {file,mtime:fs.statSync(file,{throwIfNoEntry:false})?.mtimeMs??0};})
   .sort((a,b)=>b.mtime-a.mtime).slice(0,8);
  for(const {file} of recent){const pose=camera(readLevelNbt(file));if(pose)return pose;}
 }
 const spawn=data?.spawn?.pos??[data?.SpawnX,data?.SpawnY,data?.SpawnZ];
 return usable(spawn)?{position:[spawn[0]+12,spawn[1]+12,spawn[2]-12],target:spawn,mode:'free',world_uuid:index.world_uuid}:null;
}
function packed(data,index,bits){const per=Math.floor(64/bits),value=data?.[Math.floor(index/per)];return value===undefined?null:Number((BigInt.asUintN(64,value)>>BigInt(index%per*bits))&((1n<<BigInt(bits))-1n));}
function stateName(palette){const name=palette?.Name;if(typeof name!=='string')return null;const properties=palette.Properties?Object.entries(palette.Properties).sort().map(([k,v])=>k+'='+v):[];return name+(properties.length?'['+properties.join(',')+']':'');}
export function decodeSurfaceChunk(nbt){
 if(!completeAnvilChunk(nbt))throw Error('Unsupported or incomplete Anvil chunk');
 const sections=new Map((nbt.sections??[]).filter(s=>s.block_states).map(s=>[s.Y,s.block_states]));
 function block(x,y,z){const section=sections.get(Math.floor(y/16));if(!section)return null;const palette=section.palette;if(!palette?.length)return null;const i=((y%16+16)%16)*256+z*16+x,idx=palette.length===1?0:packed(section.data,i,Math.max(4,Math.ceil(Math.log2(palette.length))));return idx===null?null:stateName(palette[idx]);}
 function surface(x,z,visibleOnly=false){const map=nbt.Heightmaps?.WORLD_SURFACE??nbt.Heightmaps?.MOTION_BLOCKING;let y=map?packed(map,z*16+x,9):null;y=y===null?319:y-65;if(y< -64)return {y:null,state:'minecraft:air',empty:true};
  for(;y>=-64;y--){const state=block(x,y,z);if(state===null)return null;if(!/^minecraft:(air|cave_air|void_air)$/.test(state)&&!(visibleOnly&&/^minecraft:(barrier|structure_void|light)(\[|$)/.test(state)))return {y,state};}return {y:null,state:'minecraft:air',empty:true};
 }
 return {block,surface};
}
const voidAirChunk=Object.freeze({DataVersion:3465,Status:'minecraft:full',sections:Object.freeze([])});
const chunkLocationOffset=(cx,cz)=>((cz%32+32)%32*32+(cx%32+32)%32)*4;
function readChunkData(fd,size,entry,region,cx,cz,missing){
 if(!entry)return missing;
 const sector=entry>>>8,sectors=entry&255;
 if(sector<2||!sectors)return null;
 const offset=sector*4096,prefix=Buffer.alloc(5),maxOutputLength=16*1024*1024;
 if(fs.readSync(fd,prefix,0,5,offset)!==5)return null;
 const length=prefix.readUInt32BE(),external=!!(prefix[4]&128),compression=prefix[4]&127;
 if(length<1||length+4>sectors*4096||offset+4+length>size)return null;
 let payload;
 if(external){
  const sidecar=path.join(region,`c.${cx}.${cz}.mcc`),externalFile=fs.statSync(sidecar,{throwIfNoEntry:false});
  if(length!==1||!externalFile?.isFile()||externalFile.size>maxOutputLength)return null;
  payload=fs.readFileSync(sidecar);
 }else{
  payload=Buffer.alloc(length-1);
  if(fs.readSync(fd,payload,0,payload.length,offset+5)!==payload.length)return null;
 }
 const bytes=compression===1?gunzipSync(payload,{maxOutputLength}):compression===2?inflateSync(payload,{maxOutputLength}):
  compression===3?payload:compression===4?decodeAnvilLz4(payload,maxOutputLength):null;
 return bytes?normalizeAnvilPalette(parseNbt(bytes)):null;
}
export function readWorldChunk(cx,cz,directory,voidWorld){
 if(directory===undefined){
  const source=worldSource();
  directory=source?.error?null:source?.directory;
  voidWorld=source?.void_world;
 }
 if(!directory)return null;
 const missing=voidWorld?voidAirChunk:null;
 const region=overworldRegionDirectory(directory);
 if(!region)return missing;
 const file=path.join(region,'r.'+Math.floor(cx/32)+'.'+Math.floor(cz/32)+'.mca');if(!fs.existsSync(file))return missing;const fd=fs.openSync(file,'r');
 try{
  const {size}=fs.fstatSync(fd);
  if(size<8192)return null;
  const location=Buffer.alloc(4);
  fs.readSync(fd,location,0,4,chunkLocationOffset(cx,cz));
  return readChunkData(fd,size,location.readUInt32BE(),region,cx,cz,missing);
 }finally{fs.closeSync(fd);}
}
function surfaceChunk(nbt){
 if(nbt===voidAirChunk)return {block:()=>'minecraft:air',surface:()=>({y:null,state:'minecraft:air',empty:true})};
 return nbt?decodeSurfaceChunk(nbt):null;
}
export function readSurfaceChunk(cx,cz,directory,voidWorld){return surfaceChunk(readWorldChunk(cx,cz,directory,voidWorld));}
export function sampleSurface(x,z,visibleOnly=false,directory,voidWorld){if(!Number.isSafeInteger(x)||!Number.isSafeInteger(z)||Math.abs(x)>30000000||Math.abs(z)>30000000)throw Error('Invalid world coordinate');const chunk=readSurfaceChunk(Math.floor(x/16),Math.floor(z/16),directory,voidWorld);return chunk?.surface((x%16+16)%16,(z%16+16)%16,visibleOnly)??null;}
export function materialColor(state){const id=state.replace('minecraft:','').split('[')[0];
 if(/water|bubble_column/.test(id))return 0x397ba8;if(/lava|fire/.test(id))return 0xd65b25;if(/snow|quartz|white_concrete|white_wool/.test(id))return 0xdce4e3;if(/sand|sandstone|end_stone/.test(id))return 0xc9bd88;if(/grass|moss/.test(id))return 0x738a4b;if(/leaves|vine|fern/.test(id))return 0x405f3b;if(/log|wood|planks|stairs|slab/.test(id)&&/oak|spruce|birch|jungle|acacia|mangrove|cherry/.test(id))return /dark_oak|spruce/.test(id)?0x69533b:0xa08658;if(/dirt|mud|farmland/.test(id))return 0x7f6950;if(/terracotta|bricks/.test(id))return 0xa77963;if(/glass/.test(id))return 0x99c2c2;if(/ice/.test(id))return 0x97bdcf;if(/deepslate|blackstone|basalt/.test(id))return 0x4f5357;return 0x8a8c85;
}
export function surfaceTile(tx,tz,level,cacheRoot,index=worldIndex(),sliceY=null,construction){
 if(![tx,tz,level].every(Number.isSafeInteger)||level<0||level>10||Math.abs(tx)>2000000||Math.abs(tz)>2000000)throw Error('Invalid surface tile');
 if(sliceY!==null&&(!Number.isSafeInteger(sliceY)||sliceY< -64||sliceY>319))throw Error('地图切片高度须在 Y -64 至 319 内');
 const file=sliceY===null?path.join(cacheRoot,`tile-${level}-${tx}-${tz}.json`):null;
 const step=2**level,size=64,span=step*size,minX=tx*span,minZ=tz*span;
 const parts=index.regions.filter(r=>r.x*512<minX+span&&(r.x+1)*512>minX&&r.z*512<minZ+span&&(r.z+1)*512>minZ);
 const revision=createHash('sha256').update(JSON.stringify([index.world_uuid,index.minecraft,index.region_directory,index.void_world,parts.map(r=>[r.x,r.z,r.mtime,r.size])])+
  (sliceY===null?'':'/Y='+sliceY)).update(construction?.mapTileKey?.(tx,tz,level)??construction?.visibility_revision??'').digest('hex');
 if(file&&fs.existsSync(file)){try{const old=JSON.parse(fs.readFileSync(file,'utf8'));if(old.version===3&&old.revision===revision)return old;}catch{}}
 // Map tiles scan many columns in the same .mca. Keep one region open and read its location table once.
 const regions=new Map(parts.map(r=>[r.x+','+r.z,r.file]));
 const missing=index.directory&&index.void_world?voidAirChunk:null;
 let reader;
 function readTileChunk(cx,cz){
  const regionFile=regions.get(Math.floor(cx/32)+','+Math.floor(cz/32));
  if(!regionFile)return missing&&!index.pristine_void?readSurfaceChunk(cx,cz,index.directory,index.void_world):surfaceChunk(missing);
  if(reader?.file!==regionFile){
   if(reader)fs.closeSync(reader.fd);
   reader=null;
   const fd=fs.openSync(regionFile,'r');
   try{
    const header=Buffer.alloc(4096),{size}=fs.fstatSync(fd);
    if(size<8192||fs.readSync(fd,header,0,header.length,0)!==header.length)throw Error('Incomplete region table');
    reader={file:regionFile,fd,size,header};
   }catch(error){fs.closeSync(fd);throw error;}
  }
  const entry=reader.header.readUInt32BE(chunkLocationOffset(cx,cz));
  return surfaceChunk(readChunkData(reader.fd,reader.size,entry,index.region_directory,cx,cz,missing));
 }
 const chunks=new Map(),colors=Array(size*size).fill(0),heights=Array(size*size).fill(null),availability=Array(size*size).fill(0);let known=0;
 try{
  for(let py=0;py<size;py++)for(let px=0;px<size;px++){
   const x=minX+px*step+Math.floor(step/2),z=minZ+py*step+Math.floor(step/2),cx=Math.floor(x/16),cz=Math.floor(z/16),key=cx+','+cz;
   if(!chunks.has(key)){try{chunks.set(key,readTileChunk(cx,cz));}catch{chunks.set(key,null);}}
   const chunk=chunks.get(key),lx=(x%16+16)%16,lz=(z%16+16)%16;
   let s;
   if(sliceY===null){
    s=chunk?.surface(lx,lz,true);
    const column=s&&construction?.column(x,z);
    if(column){
     const top=Math.max(s.y??-64,...column.keys());
     s={state:'minecraft:air',y:null,empty:true};
     for(let y=top;y>=-64;y--){
      const state=construction.block(x,y,z,chunk.block(lx,y,lz));
      if(!state||/^minecraft:(air|cave_air|void_air|barrier|structure_void|light)(\[|$)/.test(state))continue;
      s={state,y,empty:false};break;
     }
    }
   }
   else{
    const raw=chunk?.block(lx,sliceY,lz);
    const state=raw&&construction?construction.block(x,sliceY,z,raw):raw;
    if(state){const empty=/^minecraft:(air|cave_air|void_air|barrier|structure_void|light)(\[|$)/.test(state);s={state,y:empty?null:sliceY,empty};}
   }
   if(s){const i=py*size+px;colors[i]=s.empty?0:materialColor(s.state);heights[i]=s.y;availability[i]=s.empty?1:2;known++;}
  }
 }finally{if(reader)fs.closeSync(reader.fd);}
 const result={version:3,x:tx,z:tz,level,size,step,bounds:[minX,minZ,minX+span,minZ+span],colors,heights,availability,known,revision,source:sliceY===null?'saved_anvil_surface':'saved_anvil_slice',...(sliceY===null?{}:{slice_y:sliceY})};
 if(!file)return result;
 fs.mkdirSync(cacheRoot,{recursive:true});
 const temp=file+'.pending-'+process.pid;fs.writeFileSync(temp,JSON.stringify(result));fs.renameSync(temp,file);
 const files=fs.readdirSync(cacheRoot).filter(n=>n.startsWith('tile-')&&n.endsWith('.json'));if(files.length>192)for(const old of files.map(n=>({n,t:fs.statSync(path.join(cacheRoot,n)).mtimeMs})).sort((a,b)=>a.t-b.t).slice(0,files.length-192))fs.unlinkSync(path.join(cacheRoot,old.n));
 return result;
}
