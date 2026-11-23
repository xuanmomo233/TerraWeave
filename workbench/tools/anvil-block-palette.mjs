import fs from 'node:fs';
import {javaReleases} from '../minecraft-version.js';

let rules;
export function blockRules26_3(id){
 // Allowed property values and the default state from the 26.3 server's reports/blocks.json.
 rules??=JSON.parse(fs.readFileSync(new URL('./block-states-26.3.json',import.meta.url),'utf8'));
 return Object.hasOwn(rules,id)?rules[id]:undefined;
}

function unpackBlockState(entry){
 if(typeof entry?.Name==='string')return entry;
 // NBT wraps a scalar in an empty-key compound when the palette has mixed entry types.
 const name=typeof entry==='string'?entry:entry?.id??entry?.[''];
 if(typeof name!=='string'||!name)return null;
 const defaults=blockRules26_3(name)?.[1];
 const properties=entry?.properties?{...defaults,...entry.properties}:defaults;
 return properties&&Object.keys(properties).length?{Name:name,Properties:properties}:{Name:name};
}

export function normalizeAnvilPalette(chunk){
 if(chunk.DataVersion<=javaReleases['26.2']||!Array.isArray(chunk.sections))return chunk;
 for(const section of chunk.sections){
  const states=section.block_states;
  if(Array.isArray(states?.palette))states.palette=states.palette.map(entry=>{
   const state=unpackBlockState(entry);
   if(!state)throw Error('Invalid Anvil block palette entry');
   return state;
  });
 }
 for(const entity of chunk.block_entities??[]){
  if(entity?.id==='minecraft:piston'&&entity.blockState)entity.blockState=unpackBlockState(entity.blockState)??entity.blockState;
 }
 return chunk;
}
