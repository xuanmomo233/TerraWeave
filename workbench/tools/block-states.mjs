import fs from 'node:fs';
import path from 'node:path';
import {PROJECT} from './workspace-paths.mjs';
import {baselineMinecraft,supportedMinecraft} from '../minecraft-version.js';

const assets=path.join(PROJECT,'assets');
let registry;
const versions=new Map();
function modelStateRules(version,name,older){
 const key=version+':'+name;
 if(versions.has(key))return versions.get(key);
 const file=path.join(assets,'vanilla',version,'minecraft','blockstates',name+'.json');
 if(!fs.existsSync(file)){
  if(['air','cave_air','void_air'].includes(name))return [{},{}];
  throw Error(version+' 方块不存在 '+name);
 }
 const model=JSON.parse(fs.readFileSync(file,'utf8')),values={...older?.[0]},defaults={...older?.[1]};
 const declared=new Map();
 function collect(condition){
  for(const [property,value] of Object.entries(condition??{})){
   if((property==='AND'||property==='OR')&&Array.isArray(value)){
    value.forEach(collect);
   }else if(typeof value==='string'){
    if(!declared.has(property))declared.set(property,new Set());
    for(const option of value.split('|'))declared.get(property).add(option);
   }
  }
 }
 for(const variant of Object.keys(model.variants??{}))if(variant)
  collect(Object.fromEntries(variant.split(',').map(pair=>pair.split('='))));
 for(const part of model.multipart??[])collect(part.when);
 for(const [property,options] of declared){
  values[property]=[...options];
  if(options.size===1)defaults[property]=values[property][0];
  else if(!options.has(defaults[property]))delete defaults[property];
 }
 const rules=[values,defaults,[...declared.keys()]];
 versions.set(key,rules);
 return rules;
}
export function normalizeBlockState(value,version=baselineMinecraft){
 const match=/^(?:minecraft:)?([a-z0-9_]+)(?:\[([a-z0-9_=,]+)\])?$/.exec(value);
 if(!match)throw Error('无效的 Minecraft 方块状态 '+String(value));
 if(!supportedMinecraft(version))throw Error('不支持的方块版本 '+version);
 const [,name,properties]=match;
 registry??=JSON.parse(fs.readFileSync(path.join(assets,'block-states-1.20.1.json'),'utf8'));
 const stateful=Object.hasOwn(registry,name)?registry[name]:undefined;
 if(version===baselineMinecraft&&!stateful&&!['air','cave_air','void_air'].includes(name)&&!fs.existsSync(path.join(assets,'minecraft','blockstates',name+'.json')))throw Error('1.20.1 方块不存在 '+name);
 const [values,defaults,required=[]]=version===baselineMinecraft?stateful??[{},{}]:modelStateRules(version,name,stateful);
 const result={...defaults},seen=new Set();
 for(const entry of properties?.split(',')??[]){
  const [key,setting,...tail]=entry.split('=');
  if(tail.length||seen.has(key)||!Object.hasOwn(values,key)||!values[key].includes(setting))throw Error('无效的方块属性 '+name+' '+entry);
  seen.add(key);
  result[key]=setting;
 }
 const missing=required.filter(key=>!Object.hasOwn(result,key));
 if(missing.length)throw Error(version+' 的 '+name+' 需要明确指定方块属性 '+missing.join(', '));
 const fields=Object.keys(result).sort().map(key=>key+'='+result[key]);
 return 'minecraft:'+name+(fields.length?'['+fields.join(',')+']':'');
}
