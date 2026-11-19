import fs from 'node:fs';
import path from 'node:path';
import {volumeSceneInfo} from './world-volume.mjs';
import {readWorldChunk} from './world-surface.mjs';
import {buildState} from '../model-terrain.js';
import {ROOT,PROJECT} from './creative-workbench.mjs';
import {assetRoots} from './render-packs.mjs';
const assetBase=path.join(PROJECT,'assets');
const roots=[...assetRoots(assetBase),assetBase];
function asset(name){
 const found=roots.map(root=>path.join(root,name)).find(file=>fs.existsSync(file));
 if(!found)throw Error('Missing asset '+name);
 return found;
}
const info=volumeSceneInfo(path.join(ROOT,'volume-cache')),states=new Set(),textures=new Set(),failures=[];
for(const [x,z]of info.occupied_chunks)for(const section of readWorldChunk(x,z)?.sections??[])for(const p of section.block_states?.palette??[]){const props=Object.entries(p.Properties??{}).sort().map(([k,v])=>k+'='+v);states.add(p.Name+(props.length?'['+props.join(',')+']':''));}
for(const state of states){if(/^minecraft:(air|cave_air|void_air)$/.test(state))continue;try{const parts=await buildState(state,{readJson:async name=>JSON.parse(fs.readFileSync(asset(name.replace(/^\/assets\//,'')),'utf8')),makeMaterial:texture=>{textures.add(texture);const bytes=fs.readFileSync(asset('minecraft/textures/'+texture+'.png'));if(bytes.length<24||bytes.readUInt32BE(16)<1||bytes.readUInt32BE(20)<1)throw Error('Invalid texture '+texture);return {};}});for(const part of parts)part.geometry.dispose();}catch(error){failures.push({state,error:error.message});}}
const result={at:new Date().toISOString(),world_uuid:info.world_uuid,world_revision:info.revision,state_count:states.size,texture_count:textures.size,failures,scope:'All block states present in the current saved world: model parsing and referenced texture file validation. Visual rendering is verified separately.'};fs.writeFileSync(path.join(ROOT,'model-coverage-acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(failures.length)process.exitCode=1;
