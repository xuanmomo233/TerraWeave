import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {javaReleases} from '../minecraft-version.js';

const [reportsRoot,output]=process.argv.slice(2);
if(!reportsRoot||!output)throw Error('Usage: node tools/generate-design-catalog.mjs <report-root> <output-json>');
const versions=[],rules=[],ruleIds=new Map(),blocks=new Map();
const ordered=table=>Object.fromEntries(Object.entries(table).sort(([a],[b])=>a.localeCompare(b)));
for(const [version,dataVersion] of Object.entries(javaReleases)){
 const report=JSON.parse(fs.readFileSync(path.join(reportsRoot,version,'generated','reports','blocks.json'),'utf8'));
 const release=versions.length;
 versions.push([version,dataVersion,Object.keys(report).length]);
 for(const [id,definition] of Object.entries(report).sort(([a],[b])=>a.localeCompare(b))){
  const values=ordered(definition.properties??{}),defaults=ordered(definition.states.find(state=>state.default)?.properties??{});
  // Mojang declares the legal combinations as the Cartesian product of property values.
  assert.equal(definition.states.length,Object.values(values).reduce((count,options)=>count*options.length,1),version+' '+id);
  const states=new Set();
  for(const {properties={}} of definition.states){
   const options=Object.entries(values);
   assert.equal(Object.keys(properties).length,options.length,version+' '+id);
   assert.ok(options.every(([name,allowed])=>allowed.includes(properties[name])),version+' '+id);
   states.add(JSON.stringify(ordered(properties)));
  }
  assert.equal(states.size,definition.states.length,version+' '+id);
  assert.ok(states.has(JSON.stringify(defaults)),version+' '+id);
  const key=JSON.stringify([values,defaults]);
  if(!ruleIds.has(key)){ruleIds.set(key,rules.length);rules.push([values,defaults]);}
  if(!blocks.has(id))blocks.set(id,[]);
  const spans=blocks.get(id),rule=ruleIds.get(key),last=spans.at(-1);
  if(last?.[2]===rule&&last[1]===release-1)last[1]=release;
  else spans.push([release,release,rule]);
 }
}
const entries=[...blocks].sort(([a],[b])=>a.localeCompare(b));
const json=[
 '{',
 ' "versions":'+JSON.stringify(versions)+',',
 ' "rules":['+rules.map(rule=>'\n  '+JSON.stringify(rule)).join(',')+'\n ],',
 ' "blocks":{'+entries.map(([id,spans])=>'\n  '+JSON.stringify(id)+':'+JSON.stringify(spans)).join(',')+'\n }',
 '}',
 ''
].join('\n');
fs.writeFileSync(output,json,{encoding:'utf8',flag:'wx'});
