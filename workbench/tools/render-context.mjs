export function contextPositions(bounds){const result=[],min=bounds.slice(0,3).map((n,i)=>Math.max(i===1?-64:-30000000,n-1)),max=bounds.slice(3).map((n,i)=>Math.min(i===1?319:30000000,n+1));for(let y=min[1];y<=max[1];y++)for(let z=min[2];z<=max[2];z++)for(let x=min[0];x<=max[0];x++)if(x<bounds[0]||x>bounds[3]||y<bounds[1]||y>bounds[4]||z<bounds[2]||z>bounds[5])result.push([x,y,z]);return result;}
export function draftContext(context,baseCells,changes,showTarget){
 if(!context)return undefined;
 let result=context;
 function overlay(cells){
  for(const [key,state] of Object.entries(cells??{})){
   if(!Object.hasOwn(context,key)||result[key]===state)continue;
   if(result===context)result={...context};
   result[key]=state;
  }
 }
 overlay(baseCells);
 if(showTarget)overlay(changes);
 return result;
}
import {readWorldChunk} from './world-surface.mjs';
import {sectionIndices} from './world-volume.mjs';
import {completeAnvilChunk} from '../minecraft-version.js';
import {blockEntityAppearance} from './block-entity-appearance.mjs';
function savedChunkReader(directory,voidWorld){
 const chunks=new Map();
 function chunk(cx,cz){
  const key=cx+','+cz;
  if(chunks.has(key))return chunks.get(key);
  let data;
  try{data=readWorldChunk(cx,cz,directory,voidWorld);}catch{}
  let result=null;
  if(completeAnvilChunk(data)){
   const sections=new Map();
   result={sections,entities:data.block_entities??[]};
   for(const s of data.sections??[]){
    if(!s.block_states)continue;
    const indices=sectionIndices(s);
    if(!indices){result=null;break;}
    const palette=s.block_states.palette.map(v=>v.Name+(v.Properties?'['+Object.entries(v.Properties).sort().map(([k,value])=>k+'='+value).join(',')+']':''));
    sections.set(s.Y,{indices,palette});
   }
  }
  chunks.set(key,result);
  return result;
 }
 function block(x,y,z){
  const data=chunk(Math.floor(x/16),Math.floor(z/16));
  if(!data)return undefined;
  const section=data.sections.get(Math.floor(y/16));
  return section?section.palette[section.indices[(y&15)*256+(z&15)*16+(x&15)]]:'minecraft:air';
 }
 return {chunk,block};
}
export function savedRenderContext(bounds,{block}=savedChunkReader()){
 const result={};
 for(const [x,y,z] of contextPositions(bounds)){
  const state=block(x,y,z);
  if(state!==undefined)result[`${x},${y},${z}`]=state;
 }
 return result;
}
export function savedDetailSnapshot(bounds,index){
 const identity={schema:1,world:index.world,minecraft:index.minecraft,uuid:index.world_uuid,world_revision:index.revision,
  environment_revision:index.environment_revision,bounds,context_source:'saved_anvil_neighbors',source:'saved_anvil_detail'};
 if(index.pristine_void) return {...identity,blocks:{},context_blocks:{},block_entity_count:0,block_entity_positions:[],unknown_chunks:[]};
 const reader=savedChunkReader(index.directory,index.void_world),blocks={},unknown_chunks=[],block_entity_positions=[],block_entities={};
 for(let cz=Math.floor(bounds[2]/16);cz<=Math.floor(bounds[5]/16);cz++){
  for(let cx=Math.floor(bounds[0]/16);cx<=Math.floor(bounds[3]/16);cx++){
   const chunk=reader.chunk(cx,cz);
   if(!chunk){unknown_chunks.push(`${cx},${cz}`);continue;}
   for(const entity of chunk.entities){
    const {x,y,z}=entity;
    const position=[x,y,z];
    if(!position.every((n,i)=>Number.isInteger(n)&&n>=bounds[i]&&n<=bounds[i+3]))continue;
    block_entity_positions.push(position);
    const appearance=blockEntityAppearance(entity);
    if(appearance)block_entities[position.join(',')]=appearance;
   }
  }
 }
 for(let y=bounds[1];y<=bounds[4];y++){
  for(let z=bounds[2];z<=bounds[5];z++)for(let x=bounds[0];x<=bounds[3];x++){
   const state=reader.block(x,y,z);
   if(state!==undefined)blocks[`${x},${y},${z}`]=state;
  }
 }
 if(!Object.keys(blocks).length)throw Error('此范围没有可读取的存档区块，请选择已生成区域');
 return {
  ...identity,blocks,context_blocks:savedRenderContext(bounds,reader),
  block_entity_count:block_entity_positions.length,block_entity_positions,block_entities,unknown_chunks
 };
}
export function savedBlocks(keys,index){
 const {block}=savedChunkReader(index.directory,index.void_world),result={};
 for(const key of keys){
  const state=block(...key.split(',').map(Number));
  if(state===undefined)throw Error('此设计含未知存档位置 '+key);
  result[key]=state;
 }
 return result;
}
