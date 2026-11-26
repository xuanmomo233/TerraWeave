import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {javaReleases,supportedMinecraft} from '../minecraft-version.js';
import {buildState,materialSettings} from '../model-terrain.js';
import {textureAnimation} from '../texture-animation.js';
import catalog from './design-block-catalog.json' with {type:'json'};
import {blockRule,versionIndex} from './block-state-catalog.mjs';
import {variantChoices} from './model-variants.mjs';
import {visitZipEntries} from './render-packs.mjs';

const [directory,output,...requested]=process.argv.slice(2);
if(!directory||!output||requested.some(version=>!supportedMinecraft(version))){
 throw Error('Usage: node tools/verify-vanilla-materials.mjs <client-jar-directory> <report.json> [version...]');
}
const prefix='assets/minecraft/';
const included=/^assets\/minecraft\/(?:(?:models|blockstates)\/.+\.json|textures\/.+\.png(?:\.mcmeta)?)$/;
const invisible=new Set(['air','cave_air','void_air','barrier','structure_void','light']);
const stateName=(id,props)=>id+(Object.keys(props).length
 ?'['+Object.entries(props).map(pair=>pair.join('=')).join(',')+']':'');

function *states(entries,props={},index=0){
 if(index===entries.length){yield {...props};return;}
 const [key,values]=entries[index];
 for(const value of values){props[key]=value;yield* states(entries,props,index+1);}
}

function variantIndices(choices){
 const base=choices.map(()=>0);
 return [base,...choices.flatMap((options,group)=>options.slice(1).map((_,i)=>base.map((v,j)=>group===j?i+1:v)))];
}

async function inspectVersion(version){
 const models=new Map(),sprites=new Map(),metadata=new Map();
 const archive=fs.readFileSync(path.join(directory,version+'.jar'));
 visitZipEntries(archive,name=>included.test(name),(name,data)=>{
  const file=name.slice(prefix.length);
  if(file.endsWith('.json'))models.set(file,JSON.parse(data));
  else if(file.endsWith('.mcmeta'))metadata.set(file.slice(0,-7),JSON.parse(data));
  else{
   assert.equal(data.toString('hex',0,8),'89504e470d0a1a0a',name);
   sprites.set(file,[data.readUInt32BE(16),data.readUInt32BE(20)]);
  }
 });
 const release=versionIndex(version),usedSprites=new Set(),animations=new Set(),failures=[],empty=new Set(),exempt=[];
 let blockCount=0,stateCount=0,combinations=0;
 function readJson(url){
  const model=models.get(url.slice('/assets/minecraft/'.length));
  if(!model)throw Error('Missing model JSON '+url);
  return model;
 }
 function makeMaterial(sprite,id,tint,forceTranslucent){
  const file='textures/'+sprite+'.png',dimensions=sprites.get(file);
  if(!dimensions)throw Error('Missing texture '+file);
  assert.ok(dimensions.every(size=>size>0),file);
  const meta=metadata.get(file)?.animation;
  if(meta){
   assert.ok(textureAnimation(...dimensions,meta),'Unsupported animation '+file);
   animations.add(file);
  }
  usedSprites.add(file);
  return materialSettings(id,tint,forceTranslucent);
 }
 const options={minecraft:version,readJson,makeMaterial};
 for(const id of Object.keys(catalog.blocks)){
  const rule=blockRule(id,release);
  if(!rule)continue;
  blockCount++;
  const block=id.slice('minecraft:'.length);
  if(invisible.has(block)){exempt.push(block);continue;}
  const definition=models.get('blockstates/'+block+'.json');
  const renderedSelections=new Set(),errors=new Set();
  for(const props of states(Object.entries(rule[0]))){
   stateCount++;
   const state=stateName(id,props);
   try{
    const choices=definition?variantChoices(definition,props):[];
    const signature=JSON.stringify([choices,props.waterlogged,props.level,props.map]);
    if(renderedSelections.has(signature))continue;
    renderedSelections.add(signature);
    for(const indices of variantIndices(choices)){
     const parts=await buildState(state,{...options,variantIndices:indices});
     combinations++;
     if(!parts.length){
      const unusedWall=block.endsWith('_wall')&&choices.length===0;
      const hiddenCrop=block==='pitcher_crop'&&props.half==='upper'&&Number(props.age)<3;
      assert.ok(unusedWall||hiddenCrop,'Unexpected empty model');
      empty.add(block);
     }
     for(const part of parts){
      try{
       const positions=part.geometry.getAttribute('position'),uv=part.geometry.getAttribute('uv');
       assert.ok(positions?.count&&positions.array.every(Number.isFinite),'Invalid model vertices');
       assert.ok(uv?.count===positions.count&&uv.array.every(Number.isFinite),'Invalid texture coordinates');
      }finally{part.geometry.dispose();}
     }
    }
   }catch(error){
    if(!errors.has(error.message)){failures.push({state,error:error.message});errors.add(error.message);}
   }
  }
 }
 assert.equal(blockCount,catalog.versions[release][2]);
 return {version,block_count:blockCount,state_count:stateCount,model_combinations:combinations,
  sprites:usedSprites.size,animations:animations.size,exempt,empty:[...empty],failures};
}

const reports=[];
for(const version of requested.length?requested:Object.keys(javaReleases)){
 const report=await inspectVersion(version);
 reports.push(report);
 const {failures,...counts}=report;
 console.log(JSON.stringify({...counts,failed_blocks:new Set(failures.map(item=>item.state.split('[')[0])).size}));
}
fs.writeFileSync(output,JSON.stringify({reports},null,2)+'\n');
if(reports.some(report=>report.failures.length))process.exitCode=1;
