import fs from 'node:fs';
import path from 'node:path';
import {PROJECT} from './workspace-paths.mjs';

const assets=path.join(PROJECT,'assets');
let registry;
export function normalizeBlockState(value){
 const match=/^(?:minecraft:)?([a-z0-9_]+)(?:\[([a-z0-9_=,]+)\])?$/.exec(value);
 if(!match)throw Error('无效的 Minecraft 方块状态 '+String(value));
 const [,name,properties]=match;
 registry??=JSON.parse(fs.readFileSync(path.join(assets,'block-states-1.20.1.json'),'utf8'));
 const stateful=Object.hasOwn(registry,name)?registry[name]:undefined;
 if(!stateful&&!['air','cave_air','void_air'].includes(name)&&!fs.existsSync(path.join(assets,'minecraft','blockstates',name+'.json')))throw Error('1.20.1 方块不存在 '+name);
 const [values,defaults]=stateful??[{},{}],result={...defaults},seen=new Set();
 for(const entry of properties?.split(',')??[]){
  const [key,setting,...tail]=entry.split('=');
  if(tail.length||seen.has(key)||!Object.hasOwn(values,key)||!values[key].includes(setting))throw Error('无效的方块属性 '+name+' '+entry);
  seen.add(key);
  result[key]=setting;
 }
 const fields=Object.keys(result).sort().map(key=>key+'='+result[key]);
 return 'minecraft:'+name+(fields.length?'['+fields.join(',')+']':'');
}
