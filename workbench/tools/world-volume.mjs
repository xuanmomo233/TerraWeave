import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {worldIndex,readWorldChunk,materialColor} from './world-surface.mjs';
import {completeAnvilChunk as supported} from '../minecraft-version.js';

const air=name=>!name||/^minecraft:(air|cave_air|void_air|barrier|structure_void|light)$/.test(name);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function save(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.pending-'+process.pid;fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,file);}
export function cachedVolumeSceneInfo(root,index){
 try{
  const old=JSON.parse(fs.readFileSync(path.join(root,'scene-index.json'),'utf8'));
  if(old.version===2&&old.revision===index.revision)return old;
 }catch{}
 return null;
}
export function volumeSceneInfo(root,index=worldIndex()){
 const file=path.join(root,'scene-index.json'),cached=cachedVolumeSceneInfo(root,index);
 if(cached)return cached;
 const occupied=[],unreadable=[],helpers=[];let bounds=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
 for(const [x,z]of index.chunks){let chunk;try{chunk=readWorldChunk(x,z,index.directory);}catch{}if(!supported(chunk)){unreadable.push([x,z]);continue;}
  const helperSections=(chunk.sections??[]).filter(s=>s.block_states?.palette?.some(p=>p.Name==='minecraft:barrier'));if(helperSections.length)helpers.push([x,z,Math.min(...helperSections.map(s=>s.Y))*16,Math.max(...helperSections.map(s=>s.Y))*16+15]);const sections=(chunk.sections??[]).filter(s=>s.Y>=-4&&s.Y<20&&s.block_states?.palette?.some(p=>!air(p.Name)));if(!sections.length)continue;
  const min=Math.min(...sections.map(s=>s.Y))*16,max=Math.max(...sections.map(s=>s.Y))*16+15;occupied.push([x,z,min,max]);bounds=[Math.min(bounds[0],x*16),Math.min(bounds[1],min),Math.min(bounds[2],z*16),Math.max(bounds[3],x*16+15),Math.max(bounds[4],max),Math.max(bounds[5],z*16+15)];
 }
 const result={version:2,world:index.world,world_uuid:index.world_uuid,revision:index.revision,bounds:occupied.length?bounds:null,generated_bounds:index.bounds,chunk_count:index.chunk_count,occupied_chunks:occupied,helper_chunks:helpers,unreadable_chunks:unreadable,source:'saved_anvil_volume',limits:'Volumetric visible block occupancy from complete saved chunks. Invisible barriers are omitted from scenery; optional barrier glyphs are sampled in distant tiles. Coarse materials differ from detailed live models.'};save(file,result);return result;
}
export function sectionIndices(section){
 const states=section.block_states,palette=states?.palette;if(!palette?.length)return null;const result=new Uint16Array(4096);if(palette.length===1)return result;
 const bits=Math.max(4,Math.ceil(Math.log2(palette.length))),per=Math.floor(64/bits),mask=(1<<bits)-1;if(!states.data||states.data.length<Math.ceil(4096/per))return null;
 for(let n=0;n<states.data.length;n++){const value=BigInt.asUintN(64,states.data[n]),lo=Number(value&0xffffffffn)>>>0,hi=Number(value>>32n)>>>0;
  for(let j=0;j<per&&n*per+j<4096;j++){const shift=j*bits;result[n*per+j]=(shift<32?(lo>>>shift|(shift+bits>32?hi<<(32-shift):0)):hi>>>(shift-32))&mask;}
 }return result;
}
// Greedy faces retain full 3D occupancy, including overhangs, undersides and hollow interiors.
// Cells include a one-cell halo; only faces belonging to the interior are emitted.
export function greedyVolume(cells,dims,origin=[0,0,0],step=1){
 const strideX=dims[0]+2,strideY=strideX*(dims[2]+2),at=p=>cells[(p[1]+1)*strideY+(p[2]+1)*strideX+p[0]+1],quads=[];
 for(let axis=0;axis<3;axis++){const u=(axis+1)%3,v=(axis+2)%3,w=dims[u],h=dims[v],mask=new Uint32Array(w*h),p=[0,0,0];
  for(let plane=0;plane<=dims[axis];plane++){
   for(let j=0;j<h;j++)for(let i=0;i<w;i++){p[u]=i;p[v]=j;p[axis]=plane-1;const a=at(p);p[axis]=plane;const b=at(p);mask[j*w+i]=a&&!b&&plane>0?a|0x1000000:b&&!a&&plane<dims[axis]?b|0x2000000:0;}
   for(let j=0;j<h;j++)for(let i=0;i<w;){const color=mask[j*w+i];if(!color){i++;continue;}let width=1,height=1;while(i+width<w&&mask[j*w+i+width]===color)width++;
    outer:while(j+height<h){for(let k=0;k<width;k++)if(mask[(j+height)*w+i+k]!==color)break outer;height++;}
    quads.push([axis*2+(color&0x1000000?1:0),origin[axis]+plane*step,origin[u]+i*step,origin[v]+j*step,width*step,height*step,color&0xffffff]);
    for(let y=0;y<height;y++)mask.fill(0,(j+y)*w+i,(j+y)*w+i+width);i+=width;
   }
  }
 }return quads;
}
export function volumeTile(tx,tz,level,root,index=worldIndex()){
 if(![tx,tz,level].every(Number.isSafeInteger)||level<0||level>6||Math.abs(tx)>500000||Math.abs(tz)>500000)throw Error('Invalid volume tile');
 const step=2**level,span=64*step,minX=tx*span,minZ=tz*span,parts=index.regions.filter(r=>r.x*512<minX+span+step&&(r.x+1)*512>minX-step&&r.z*512<minZ+span+step&&(r.z+1)*512>minZ-step),revision=digest([index.world_uuid,parts.map(r=>[r.x,r.z,r.size,r.mtime])]),file=path.join(root,`volume-${level}-${tx}-${tz}.json`);
 try{const old=JSON.parse(fs.readFileSync(file,'utf8'));if(old.version===2&&old.revision===revision)return old;}catch{}
 const dims=[64,384/step,64],stride=66,layer=stride*stride,cells=new Uint32Array(layer*(dims[1]+2)),tops=new Int16Array(cells.length);tops.fill(-32768);let chunks=0;const unreadable=[],barriers=new Map(),markerStep=Math.max(4,step);
 function mark(x,y,z){if(x<minX||x>=minX+span||z<minZ||z>=minZ+span||barriers.size>=2048)return;const key=[Math.floor(x/markerStep),Math.floor(y/markerStep),Math.floor(z/markerStep)].join(',');if(!barriers.has(key))barriers.set(key,[x+.5,y+.5,z+.5]);}
 function put(x,y,z,color){const gx=Math.floor((x-minX)/step),gy=Math.floor((y+64)/step),gz=Math.floor((z-minZ)/step);if(gx< -1||gx>64||gz< -1||gz>64||gy<0||gy>=dims[1])return;const i=(gy+1)*layer+(gz+1)*stride+gx+1;if(y>=tops[i]){cells[i]=color;tops[i]=y;}}
 for(const [cx,cz]of index.chunks){if(cx*16>=minX+span+step||cx*16+16<=minX-step||cz*16>=minZ+span+step||cz*16+16<=minZ-step)continue;let chunk;try{chunk=readWorldChunk(cx,cz,index.directory);}catch{}if(!supported(chunk)){unreadable.push([cx,cz]);continue;}chunks++;
  for(const section of chunk.sections??[]){if(section.Y< -4||section.Y>=20)continue;const palette=section.block_states?.palette;if(!palette?.some(p=>!air(p.Name)||p.Name==='minecraft:barrier'))continue;const colors=palette.map(p=>air(p.Name)?0:materialColor(p.Name)),x0=cx*16,y0=section.Y*16,z0=cz*16;
   if(palette.length===1){const hop=palette[0].Name==='minecraft:barrier'?Math.min(markerStep,16):Math.min(step,16);for(let y=y0;y<y0+16;y+=hop)for(let z=z0;z<z0+16;z+=hop)for(let x=x0;x<x0+16;x+=hop)if(colors[0])put(x,y,z,colors[0]);else mark(x,y,z);continue;}
   const ids=sectionIndices(section);if(!ids){unreadable.push([cx,cz]);continue;}for(let i=0;i<4096;i++){const color=colors[ids[i]],x=x0+i%16,y=y0+Math.floor(i/256),z=z0+Math.floor(i/16)%16;if(color)put(x,y,z,color);else if(palette[ids[i]]?.Name==='minecraft:barrier')mark(x,y,z);}
  }
 }
 const quads=greedyVolume(cells,dims,[minX,-64,minZ],step),result={version:2,x:tx,z:tz,level,step,bounds:[minX,-64,minZ,minX+span,320,minZ+span],quads,barriers:[...barriers.values()],revision,known_chunks:chunks,unreadable_chunks:unreadable,source:'saved_anvil_volume'};save(file,result);
 const files=fs.readdirSync(root).filter(n=>/^volume-.*\.json$/.test(n));if(files.length>128)for(const old of files.map(n=>({n,t:fs.statSync(path.join(root,n)).mtimeMs})).sort((a,b)=>a.t-b.t).slice(0,files.length-128))try{fs.unlinkSync(path.join(root,old.n));}catch(e){if(e.code!=='ENOENT')throw e;}
 return result;
}
