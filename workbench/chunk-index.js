// Read-only scene index. Source JSON remains whole-file; only GPU residency streams.
import {faceDirections,fluidKind,fluidCornerHeights} from './tools/fluid-shape.mjs';
export const CHUNK_SIZE = 16;
export const isAir = s => /^minecraft:(air|cave_air|void_air)$/.test(s);
export function chunkCoord(n) { return Math.floor(n / CHUNK_SIZE); }
export function makeIndex(snapshot, repeats=1,options={}) {
  if (![1,2,4].includes(repeats)) throw Error('Unsupported synthetic repeat count');
  const templates=new Map();
  for(const [key,state] of Object.entries(snapshot.blocks)) {
    if(isAir(state)) continue;
    const p=key.split(',').map(Number), id=`${chunkCoord(p[0])},${chunkCoord(p[2])}`;
    if(!templates.has(id)) templates.set(id,[]);
    templates.get(id).push({p,state,block_entity:snapshot.block_entities?.[key]});
  }
  return indexFromTemplates(snapshot,repeats,options,templates);
}
function indexFromTemplates(snapshot,repeats,options,templates){
  const b=snapshot.bounds, w=b[3]-b[0]+1, depth=b[5]-b[2]+1;
  const chunks=[];
  for(let tx=0;tx<repeats;tx++) for(let tz=0;tz<repeats;tz++) {
    const dx=tx*w,dz=tz*depth;
    for(const [key,cells] of templates) {
      const [cx,cz]=key.split(',').map(Number);
      chunks.push({id:`${tx}:${tz}:${key}`,column:key,cells,offset:[dx,0,dz],center:[cx*16+8+dx,cz*16+8+dz],blocks:options.cull?snapshot.blocks:null,bounds:b,context:snapshot.context_blocks,opaqueStates:options.opaqueStates});
    }
  }
  return {chunks,bounds:[b[0],b[1],b[2],b[3]+w*(repeats-1),b[4],b[5]+depth*(repeats-1)],
    repeats,sourcePositions:Object.keys(snapshot.blocks).length,virtualPositions:Object.keys(snapshot.blocks).length*repeats*repeats,
    sourceNonAir:[...templates.values()].reduce((n,c)=>n+c.length,0), templates};
}
export function patchLocalIndex(previous,snapshot,dirty,opaqueStates){
  const templates=new Map(previous.templates),[minX,minY,minZ,maxX,maxY,maxZ]=snapshot.bounds;
  for(const column of dirty){
    const [cx,cz]=column.split(',').map(Number);
    const x0=Math.max(minX,cx*16),x1=Math.min(maxX,cx*16+15);
    const z0=Math.max(minZ,cz*16),z1=Math.min(maxZ,cz*16+15);
    const cells=[];
    for(let y=minY;y<=maxY;y++)for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++){
      const state=snapshot.blocks[`${x},${y},${z}`];
      if(state!==undefined&&!isAir(state))cells.push({p:[x,y,z],state,block_entity:snapshot.block_entities?.[`${x},${y},${z}`]});
    }
    if(cells.length)templates.set(column,cells);
    else templates.delete(column);
  }
  return indexFromTemplates(snapshot,1,{cull:true,opaqueStates},templates);
}
export function wantedChunks(index,x,z,radius=32,maxChunks=36) {
  return index.chunks.map(c=>({c,d:Math.hypot(c.center[0]-x,c.center[1]-z)}))
    .filter(o=>o.d<=radius+12).sort((a,b)=>a.d-b.d||a.c.id.localeCompare(b.c.id)).slice(0,maxChunks).map(o=>o.c);
}
export function cellsInChunk(c,cap=Infinity,min=-Infinity) {
  const opaque=s=>c.opaqueStates?c.opaqueStates.has(s):/^minecraft:(stone|cobblestone|deepslate|tuff|calcite|dirt|grass_block|podzol|mycelium|sand|red_sand|gravel|bedrock|stone_bricks|mossy_stone_bricks|moss_block|[a-z_]+_(planks|ore|terracotta|concrete|wool))(?=\[|$)/.test(s??'');
  const fluid=s=>/^minecraft:(water|lava)(?=\[|$)/.exec(s??'')?.[1];
  const visible=a=>{if(!c.blocks)return true;const neighbors=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].map(d=>{const p=a.p.map((v,i)=>v+d[i]);return p[1]<min||p[1]>cap?null:c.blocks[p.join(',')];});if(opaque(a.state))return !neighbors.every(opaque);const f=fluid(a.state);return !f||!neighbors.every(s=>fluid(s)===f||opaque(s));};
  return c.cells.filter(a=>a.p[1]<=cap&&a.p[1]>=min&&visible(a)).map(a=>{const p=a.p.map((v,i)=>v+c.offset[i]),get=(x,y,z)=>{const key=[x,y,z].join(',');return c.blocks?.[key]??c.context?.[key]??null;},kind=fluidKind(a.state);let mask=0,fluidMask=0;if(c.blocks)for(let f=0;f<6;f++){const d=faceDirections[f],y=a.p[1]+d[1],cut=y<min&&min>(c.bounds?.[1]??-Infinity)||y>cap&&cap<(c.bounds?.[4]??Infinity),s=cut?null:get(a.p[0]+d[0],y,a.p[2]+d[2]);if(opaque(s))mask|=1<<f;if(opaque(s)||kind&&fluidKind(s)===kind)fluidMask|=1<<f;}return {p,k:p.join(','),s:a.state,block_entity:a.block_entity,mask,fluid_mask:fluidMask,fluid_corners:kind&&c.blocks?fluidCornerHeights(...a.p,kind,get,opaque):undefined};});
}
