import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {baselineMinecraft,supportedMinecraft} from '../minecraft-version.js';
import {modelProperties} from './block-state-catalog.mjs';

const TILE_SIZE=32,PLANE=TILE_SIZE*TILE_SIZE,TILE_BYTES=384*PLANE*4;
const AIR='minecraft:air';
const tileOf=(x,z)=>Math.floor(x/TILE_SIZE)+','+Math.floor(z/TILE_SIZE);
const coord=(x,y,z)=>(y+64)*PLANE+(z&31)*TILE_SIZE+(x&31);
const manifestName='generated-construction.json';

export function readGeneratedConstruction(root,worldUuid){
 const base=path.join(root,'authoring'),file=path.join(base,manifestName);
 let data;
 try{data=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(data.world_uuid!==worldUuid)return null;
 const {revision,plans,palette,tiles,restores={},minecraft=baselineMinecraft}=data;
 if(data.schema!==1||!/^[0-9a-f]{64}$/.test(revision)||!Array.isArray(plans)||plans[0]!==null||
    plans.length>256||!plans.slice(1).every(plan=>/^[a-zA-Z0-9-]{1,99}$/.test(plan))||
    !Array.isArray(palette)||palette[0]!==AIR||palette.length>256||!palette.every(value=>typeof value==='string')||
    !tiles||typeof tiles!=='object'||Array.isArray(tiles)||!supportedMinecraft(minecraft))throw Error('生成内容的规划归属记录无效');
 const planTiles=new Map();
 for(const [key,owners] of Object.entries(tiles)){
  if(!/^-?\d+,-?\d+$/.test(key)||!Array.isArray(owners)||!owners.every(owner=>Number.isInteger(owner)&&plans[owner]))
   throw Error('生成内容的规划图块无效');
  for(const owner of owners){
   const plan=plans[owner];
   if(!planTiles.has(plan))planTiles.set(plan,new Set());
   planTiles.get(plan).add(key);
  }
 }
 for(const sections of Object.values(restores))if(!Array.isArray(sections)||
  !sections.every(y=>Number.isInteger(y)&&y>=-4&&y<=19))throw Error('生成内容的恢复层无效');
 const folder=path.join(base,'generated-construction',revision);
 return {revision,planTiles,project(hidden){
  const ownerHidden=plans.map(plan=>hidden.has(plan)),affected=new Set();
  for(const plan of hidden)for(const key of planTiles.get(plan)??[])affected.add(key);
  if(!affected.size)return null;
  const cached=new Map();
  const normalStates=new Map(),normalPalettes=new WeakMap();
  function canonical(state){
   if(typeof state!=='string')return state;
   if(!normalStates.has(state)){
    const [id,fields]=state.split('[');
    const properties=fields?Object.fromEntries(fields.slice(0,-1).split(',').map(part=>part.split('='))):{};
    const values=Object.entries(modelProperties(id,properties,minecraft)).sort().map(([k,v])=>k+'='+v);
    normalStates.set(state,id+(values.length?'['+values.join(',')+']':''));
   }
   return normalStates.get(state);
  }
  const expected=palette.map(canonical);
  let lastKey,lastTile;
  function load(key){
   if(!affected.has(key))return null;
   if(key===lastKey)return lastTile;
   let bytes=cached.get(key);
   if(bytes)cached.delete(key);
   else{
    bytes=gunzipSync(fs.readFileSync(path.join(folder,key+'.gz')),{maxOutputLength:TILE_BYTES});
    if(bytes.length!==TILE_BYTES)throw Error('生成内容的规划图块大小不符');
   }
   cached.set(key,bytes);
   if(cached.size>24)cached.delete(cached.keys().next().value);
   lastKey=key;lastTile=bytes;
   return bytes;
  }
  function replacement(entry,actual){
   const owner=(entry>>>8)&255;
   if(!ownerHidden[owner]||actual!==expected[entry&255])return undefined;
   return ownerHidden[entry>>>24]?AIR:palette[(entry>>>16)&255];
  }
  return {
   affected,
   block(x,y,z,actual){
    if(y< -64||y>319)return actual;
    const tile=load(tileOf(x,z));
    return tile?replacement(tile.readUInt32LE(coord(x,y,z)*4),canonical(actual))??actual:actual;
   },
   section(cx,cz,cy,cells,names,idFor,handled){
    if(cy< -4||cy>19)return;
    const tile=load(tileOf(cx*16,cz*16));
    if(!tile)return;
    let normalized=normalPalettes.get(names);
    if(!normalized){normalized=[];normalPalettes.set(names,normalized);}
    for(let i=normalized.length;i<names.length;i++)normalized.push(canonical(names[i]));
    const base=coord(cx*16,cy*16,cz*16)*4;
    for(let y=0;y<16;y++)for(let z=0;z<16;z++){
     const start=base+(y*PLANE+z*TILE_SIZE)*4,local=y*256+z*16;
     for(let x=0;x<16;x++){
      const at=local+x;
      if(handled?.has(at))continue;
      const state=replacement(tile.readUInt32LE(start+x*4),normalized[cells[at]]);
      if(state!==undefined)cells[at]=state===AIR?0:idFor(state);
     }
    }
   },
   // A hidden trail can expose its original ground even in a currently empty section.
   restoreSections:(cx,cz)=>affected.has(tileOf(cx*16,cz*16))?restores[cx+','+cz]??[]:[]
  };
 }};
}
