import fs from 'node:fs';
import path from 'node:path';
import {inflateSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {worldSource} from './world-source.mjs';

export function parseNbt(bytes){
 let offset=0,nodes=0;
 const take=n=>{if(n<0||offset+n>bytes.length)throw Error('Truncated NBT');const b=bytes.subarray(offset,offset+n);offset+=n;return b;};
 const u8=()=>take(1)[0],i32=()=>take(4).readInt32BE(),str=()=>take(take(2).readUInt16BE()).toString('utf8');
 function value(tag,depth=0){if(depth>64||++nodes>2000000)throw Error('NBT complexity limit');switch(tag){
  case 1:return take(1).readInt8();case 2:return take(2).readInt16BE();case 3:return i32();case 4:return take(8).readBigInt64BE();case 5:return take(4).readFloatBE();case 6:return take(8).readDoubleBE();
  case 7:{const length=i32();return take(length);}case 8:return str();
  case 9:{const type=u8(),length=i32();if(length<0||length>1000000)throw Error('Invalid NBT list');return Array.from({length},()=>value(type,depth+1));}
  case 10:{const result=Object.create(null);while(true){const type=u8();if(!type)return result;const key=str();result[key]=value(type,depth+1);}}
  case 11:case 12:{const length=i32(),size=tag===11?4:8;if(length<0||length>4000000/size)throw Error('Invalid NBT array');const b=take(length*size);return Array.from({length},(_,i)=>tag===11?b.readInt32BE(i*4):b.readBigUInt64BE(i*8));}
  default:throw Error('Unknown NBT tag '+tag);
 }}
 if(u8()!==10)throw Error('NBT root is not a compound');str();return value(10);
}
export function worldIndex(){
 const source=worldSource();
 const directory=source?.error?undefined:source?.directory;
 const regions=[],chunks=[];
 for(const file of directory?fs.readdirSync(path.join(directory,'region')).sort():[]){const match=/^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(file);if(!match)continue;const name=path.join(directory,'region',file),stat=fs.statSync(name);if(stat.size<8192)continue;
  const header=Buffer.alloc(4096),fd=fs.openSync(name,'r');try{fs.readSync(fd,header,0,4096,0);}finally{fs.closeSync(fd);}
  const rx=Number(match[1]),rz=Number(match[2]);let count=0;
  for(let i=0;i<1024;i++){const entry=header.readUInt32BE(i*4),sector=entry>>>8;if(sector<2||!(entry&255)||sector*4096+5>stat.size)continue;chunks.push([rx*32+i%32,rz*32+Math.floor(i/32)]);count++;}
  if(count)regions.push({x:rx,z:rz,file:name,size:stat.size,mtime:stat.mtimeMs,chunks:count});
 }
 const bounds=chunks.reduce((b,[x,z])=>[Math.min(b[0],x*16),Math.min(b[1],z*16),Math.max(b[2],x*16+15),Math.max(b[3],z*16+15)],[Infinity,Infinity,-Infinity,-Infinity]);
 const revision=createHash('sha256').update(JSON.stringify([source?.world_uuid,regions.map(r=>[r.x,r.z,r.size,r.mtime])])).digest('hex');
 const level=directory?fs.statSync(path.join(directory,'level.dat')):null;
 return {directory,world:source?.world,world_uuid:source?.world_uuid,dimension:'minecraft:overworld',minecraft:'1.20.1',bounds:chunks.length?bounds:null,chunk_count:chunks.length,region_count:regions.length,regions,chunks,revision,environment_revision:level?revision+':'+level.mtimeMs+':'+level.size:null,source:'saved_anvil_surface',limits:'Existing generated overworld only. Unknown or incomplete data stays unknown. Surface colors are a material approximation, not client lighting.'};
}
function packed(data,index,bits){const per=Math.floor(64/bits),value=data?.[Math.floor(index/per)];return value===undefined?null:Number((BigInt.asUintN(64,value)>>BigInt(index%per*bits))&((1n<<BigInt(bits))-1n));}
function stateName(palette){const name=palette?.Name;if(typeof name!=='string')return null;const properties=palette.Properties?Object.entries(palette.Properties).sort().map(([k,v])=>k+'='+v):[];return name+(properties.length?'['+properties.join(',')+']':'');}
export function decodeSurfaceChunk(nbt){
 if(nbt.DataVersion!==3465||!['full','minecraft:full'].includes(nbt.Status))throw Error('Only complete 1.20.1 chunks are supported');
 const sections=new Map((nbt.sections??[]).filter(s=>s.block_states).map(s=>[s.Y,s.block_states]));
 function block(x,y,z){const section=sections.get(Math.floor(y/16));if(!section)return null;const palette=section.palette;if(!palette?.length)return null;const i=((y%16+16)%16)*256+z*16+x,idx=palette.length===1?0:packed(section.data,i,Math.max(4,Math.ceil(Math.log2(palette.length))));return idx===null?null:stateName(palette[idx]);}
 function surface(x,z,visibleOnly=false){const map=nbt.Heightmaps?.WORLD_SURFACE??nbt.Heightmaps?.MOTION_BLOCKING;let y=map?packed(map,z*16+x,9):null;y=y===null?319:y-65;if(y< -64)return {y:null,state:'minecraft:air',empty:true};
  for(;y>=-64;y--){const state=block(x,y,z);if(state===null)return null;if(!/^minecraft:(air|cave_air|void_air)$/.test(state)&&!(visibleOnly&&/^minecraft:(barrier|structure_void|light)(\[|$)/.test(state)))return {y,state};}return {y:null,state:'minecraft:air',empty:true};
 }
 return {block,surface};
}
export function readWorldChunk(cx,cz,directory){
 if(directory===undefined){
  const source=worldSource();
  directory=source?.error?null:source?.directory;
 }
 if(!directory)return null;
 const file=path.join(directory,'region','r.'+Math.floor(cx/32)+'.'+Math.floor(cz/32)+'.mca');if(!fs.existsSync(file))return null;const fd=fs.openSync(file,'r');
 try{const stat=fs.fstatSync(fd);if(stat.size<8192)return null;const location=Buffer.alloc(4);fs.readSync(fd,location,0,4,((cz%32+32)%32*32+(cx%32+32)%32)*4);const entry=location.readUInt32BE(),sector=entry>>>8;if(sector<2||!(entry&255))return null;
  const prefix=Buffer.alloc(5);if(fs.readSync(fd,prefix,0,5,sector*4096)!==5)return null;const length=prefix.readUInt32BE(),compression=prefix[4];if(length<1||length>16*1024*1024||sector*4096+4+length>stat.size||compression&128)return null;const payload=Buffer.alloc(length-1);fs.readSync(fd,payload,0,payload.length,sector*4096+5);
  const bytes=compression===1?gunzipSync(payload,{maxOutputLength:16*1024*1024}):compression===2?inflateSync(payload,{maxOutputLength:16*1024*1024}):compression===3?payload:null;if(!bytes)return null;return parseNbt(bytes);
 }finally{fs.closeSync(fd);}
}
export function readSurfaceChunk(cx,cz,directory){const nbt=readWorldChunk(cx,cz,directory);return nbt?decodeSurfaceChunk(nbt):null;}
export function sampleSurface(x,z,visibleOnly=false,directory){if(!Number.isSafeInteger(x)||!Number.isSafeInteger(z)||Math.abs(x)>30000000||Math.abs(z)>30000000)throw Error('Invalid world coordinate');const chunk=readSurfaceChunk(Math.floor(x/16),Math.floor(z/16),directory);return chunk?.surface((x%16+16)%16,(z%16+16)%16,visibleOnly)??null;}
export function materialColor(state){const id=state.replace('minecraft:','').split('[')[0];
 if(/water|bubble_column/.test(id))return 0x397ba8;if(/lava|fire/.test(id))return 0xd65b25;if(/snow|quartz|white_concrete|white_wool/.test(id))return 0xdce4e3;if(/sand|sandstone|end_stone/.test(id))return 0xc9bd88;if(/grass|moss/.test(id))return 0x738a4b;if(/leaves|vine|fern/.test(id))return 0x405f3b;if(/log|wood|planks|stairs|slab/.test(id)&&/oak|spruce|birch|jungle|acacia|mangrove|cherry/.test(id))return /dark_oak|spruce/.test(id)?0x69533b:0xa08658;if(/dirt|mud|farmland/.test(id))return 0x7f6950;if(/terracotta|bricks/.test(id))return 0xa77963;if(/glass/.test(id))return 0x99c2c2;if(/ice/.test(id))return 0x97bdcf;if(/deepslate|blackstone|basalt/.test(id))return 0x4f5357;return 0x8a8c85;
}
export function surfaceTile(tx,tz,level,cacheRoot,index=worldIndex(),sliceY=null){
 if(![tx,tz,level].every(Number.isSafeInteger)||level<0||level>10||Math.abs(tx)>2000000||Math.abs(tz)>2000000)throw Error('Invalid surface tile');
 if(sliceY!==null&&(!Number.isSafeInteger(sliceY)||sliceY< -64||sliceY>319))throw Error('地图切片高度须在 Y -64 至 319 内');
 const file=sliceY===null?path.join(cacheRoot,`tile-${level}-${tx}-${tz}.json`):null;
 const step=2**level,size=64,span=step*size,minX=tx*span,minZ=tz*span;
 const parts=index.regions.filter(r=>r.x*512<minX+span&&(r.x+1)*512>minX&&r.z*512<minZ+span&&(r.z+1)*512>minZ);
 const revision=createHash('sha256').update(JSON.stringify(parts.map(r=>[r.x,r.z,r.mtime,r.size]))+(sliceY===null?'':'/Y='+sliceY)).digest('hex');
 if(file&&fs.existsSync(file)){try{const old=JSON.parse(fs.readFileSync(file,'utf8'));if(old.version===3&&old.revision===revision)return old;}catch{}}
 const chunks=new Map(),colors=Array(size*size).fill(0),heights=Array(size*size).fill(null),availability=Array(size*size).fill(0);let known=0;
 for(let py=0;py<size;py++)for(let px=0;px<size;px++){
  const x=minX+px*step+Math.floor(step/2),z=minZ+py*step+Math.floor(step/2),cx=Math.floor(x/16),cz=Math.floor(z/16),key=cx+','+cz;
  if(!chunks.has(key)){try{chunks.set(key,readSurfaceChunk(cx,cz,index.directory));}catch{chunks.set(key,null);}}
  const chunk=chunks.get(key),lx=(x%16+16)%16,lz=(z%16+16)%16;
  let s;
  if(sliceY===null)s=chunk?.surface(lx,lz,true);
  else{
   const state=chunk?.block(lx,sliceY,lz);
   if(state){const empty=/^minecraft:(air|cave_air|void_air|barrier|structure_void|light)(\[|$)/.test(state);s={state,y:empty?null:sliceY,empty};}
  }
  if(s){const i=py*size+px;colors[i]=s.empty?0:materialColor(s.state);heights[i]=s.y;availability[i]=s.empty?1:2;known++;}
 }
 const result={version:3,x:tx,z:tz,level,size,step,bounds:[minX,minZ,minX+span,minZ+span],colors,heights,availability,known,revision,source:sliceY===null?'saved_anvil_surface':'saved_anvil_slice',...(sliceY===null?{}:{slice_y:sliceY})};
 if(!file)return result;
 fs.mkdirSync(cacheRoot,{recursive:true});
 const temp=file+'.pending-'+process.pid;fs.writeFileSync(temp,JSON.stringify(result));fs.renameSync(temp,file);
 const files=fs.readdirSync(cacheRoot).filter(n=>n.startsWith('tile-')&&n.endsWith('.json'));if(files.length>192)for(const old of files.map(n=>({n,t:fs.statSync(path.join(cacheRoot,n)).mtimeMs})).sort((a,b)=>a.t-b.t).slice(0,files.length-192))fs.unlinkSync(path.join(cacheRoot,old.n));
 return result;
}
