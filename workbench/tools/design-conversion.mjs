import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {savedBlocks} from './render-context.mjs';
import {worldIndex} from './world-surface.mjs';
import {validateDesignPacket} from './world-writer.mjs';
import {blockRule as rule,versionIndex} from './block-state-catalog.mjs';
export {registryContains} from './block-state-catalog.mjs';

const id={type:'string'};
const replacements={type:'object',additionalProperties:id};
const argumentsFor=extra=>({type:'object',properties:{export_path:id,replacements,...extra},additionalProperties:false});
const analyze=argumentsFor({issue_offset:{type:'integer'}});
analyze.required=['export_path'];
const convert=argumentsFor({analysis_token:id});
convert.required=['export_path','analysis_token'];
export const DESIGN_CONVERSION_TOOLS=[
 {name:'analyze_design_conversion',description:'Check a TerraWeave export against the current project’s linked target save. Report version differences and proposed writes without changing the source export or target save.',inputSchema:analyze,annotations:{readOnlyHint:true}},
 {name:'convert_design_export',description:'Create a version-checked building export at the same coordinates for the Java save linked to the current project. Vanilla saves can use local world IDs for offline conversion. Applying through world_writer still requires a matching server UUID. Pass the analysis_token from an unblocked analysis.',inputSchema:convert}
];

const statePattern=/^(?:minecraft:)?([a-z0-9_]+)(?:\[([a-z0-9_=,]+)\])?$/;
const limit=80;
const maxExportBytes=64*1024*1024;
const hash=value=>createHash('sha256').update(value).digest('hex');
const renames=new Map([
 ['minecraft:grass','minecraft:short_grass'],['minecraft:short_grass','minecraft:grass'],
 ['minecraft:chain','minecraft:iron_chain'],['minecraft:iron_chain','minecraft:chain']
]);
const absentFalse=new Set(['waterlogged','powered','ominous']);

function parseState(value){
 const match=typeof value==='string'&&statePattern.exec(value);
 if(!match)return null;
 const properties=Object.create(null);
 for(const field of match[2]?.split(',')??[]){
  const [name,option,...other]=field.split('=');
  if(!name||!option||other.length||Object.hasOwn(properties,name))return null;
  properties[name]=option;
 }
 return {id:'minecraft:'+match[1],properties};
}
function canonicalState(id,properties){
 const fields=Object.entries(properties).sort(([a],[b])=>a.localeCompare(b));
 return id+(fields.length?'['+fields.map(([name,value])=>name+'='+value).join(',')+']':'');
}
function invalidProperty(properties,values){
 return Object.entries(properties).find(([name,value])=>!Object.hasOwn(values,name)||!values[name].includes(value));
}
export function blockConverter(from,to,replacementRules={}){
 const sourceVersion=versionIndex(from),targetVersion=versionIndex(to);
 return value=>{
  if(Object.hasOwn(replacementRules,value)){
   const state=parseState(replacementRules[value]),target=state&&rule(state.id,targetVersion);
   if(!target||invalidProperty(state.properties,target[0]))return {reason:'替换后的方块或属性不适用于目标版本'};
   return {state:canonicalState(state.id,{...target[1],...state.properties}),kind:'replaced'};
  }
  const state=parseState(value),source=state&&rule(state.id,sourceVersion);
  if(!source||invalidProperty(state.properties,source[0]))return {reason:'方案的方块或属性与来源版本不符'};
  const equivalent=renames.get(state.id);
  const id=equivalent&&!rule(state.id,targetVersion)?equivalent:state.id;
  const target=rule(id,targetVersion);
  if(!target)return {reason:'目标版本没有这个方块'};
  const current={...source[1],...state.properties},next={...target[1]};
  for(const [name,value] of Object.entries(current)){
   if(!Object.hasOwn(target[0],name)&&absentFalse.has(name)&&value==='false')continue;
   if(!Object.hasOwn(target[0],name)||!target[0][name].includes(value)){
    return {reason:'目标版本无法表示属性 '+name+'='+value};
   }
   next[name]=value;
  }
  const canonical=canonicalState(id,next);
  return {state:canonical,kind:canonical===canonicalState(state.id,current)?'exact':'adapted'};
 };
}

function readExport(file){
 if(typeof file!=='string'||!file.trim())throw Error('请选择要转换的方案文件');
 const source=fs.realpathSync(file.trim()),stat=fs.statSync(source);
 if(!stat.isFile()||stat.size>maxExportBytes)throw Error('请选择大小不超过 64 MB 的方案文件');
 const data=fs.readFileSync(source);
 if(data.length>maxExportBytes)throw Error('方案文件超过 64 MB');
 let packet;
 try{packet=JSON.parse(data);}catch{throw Error('方案文件不是有效的 JSON');}
 return {packet:validateDesignPacket(packet,{allowLocalWorld:true}),sha:hash(data),source};
}
export function designConversion({folder,atomic}){
 return function execute(name,args){
  const index=worldIndex();
  if(!index.directory)throw Error('请先在当前工程关联目标 Java 版存档');
  const targetUuid=index.paper_world_uuid??index.world_uuid;
  const {packet,sha,source}=readExport(args.export_path);
  const configured=args.replacements??{};
  if(!configured||typeof configured!=='object'||Array.isArray(configured)||Object.values(configured).some(value=>typeof value!=='string'))
   throw Error('替换表应由来源和目标方块状态组成');
  const transform=blockConverter(packet.minecraft,index.minecraft,configured);
  const issues=new Map(),mapped=new Map(),changes=Object.create(null);
  const counts={exact:0,adapted:0,replaced:0,blocked:0};
  for(const [position,value] of Object.entries(packet.changes)){
   if(!mapped.has(value))mapped.set(value,transform(value));
   const result=mapped.get(value);
   if(result.state){
    changes[position]=result.state;
    counts[result.kind]++;
   }else{
    const issue=issues.get(value)??{state:value,reason:result.reason,count:0,positions:[]};
    issue.count++;
    if(issue.positions.length<5)issue.positions.push(position);
    issues.set(value,issue);
    counts.blocked++;
   }
  }
  const offset=args.issue_offset??0;
  if(!Number.isSafeInteger(offset)||offset<0||offset>issues.size)throw Error('无效的方块差异页码');
  const entries=[...issues.values()];
  const summary={source_path:source,source_version:packet.minecraft,target_version:index.minecraft,target_world:index.world,target_world_uuid:targetUuid,
   counts,incompatible:entries.slice(offset,offset+limit),incompatible_count:issues.size,
   previous_issue_offset:offset>0?Math.max(0,offset-limit):null,
   next_issue_offset:offset+limit<entries.length?offset+limit:null};
  if(counts.blocked||!Object.keys(changes).length){
   if(name==='convert_design_export')throw Error('请先完成方案检查并处理所有无法转换的方块');
   if(!Object.keys(packet.changes).length)summary.target_error='原方案没有可转换的编辑';
   return summary;
  }
  const base=savedBlocks(Object.keys(changes),index);
  if(worldIndex().revision!==index.revision)throw Error('读取期间目标存档已更新，请重新检查方案');
  const token=hash(JSON.stringify([sha,targetUuid,index.revision,base,changes]));
  summary.analysis_token=token;
  summary.target_blocks_replaced=Object.entries(base).filter(([position,state])=>state!==changes[position]&&
   !/^minecraft:(air|cave_air|void_air)$/.test(state)).length;
  if(name==='analyze_design_conversion')return summary;
  if(args.analysis_token!==token)throw Error('方案或目标存档已变化，请重新检查');
  const digest=hash(JSON.stringify([sha,targetUuid,index.minecraft,changes]));
  const draftId=digest.slice(0,32).match(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/).slice(1).join('-');
  const output={schema:1,world_uuid:targetUuid,minecraft:index.minecraft,draft_id:draftId,draft_revision:1,
   label:typeof packet.label==='string'?packet.label.slice(0,120):'转换后的建筑方案',base,changes,previously_applied:{}};
  validateDesignPacket(output,{allowLocalWorld:true});
  const file=path.join(folder('exports'),'converted-'+token.slice(0,24)+'.json');
  const bytes=JSON.stringify(output);
  if(Buffer.byteLength(bytes)>maxExportBytes)throw Error('转换后的方案超过写入端支持的 64 MB，请先拆分原方案');
  const digestOfOutput=hash(bytes);
  if(!fs.existsSync(file))atomic(file,output);
  else if(hash(fs.readFileSync(file))!==digestOfOutput)throw Error('转换输出已存在且内容不同，请先移开该文件');
  return {...summary,path:file,draft_id:draftId,sha256:digestOfOutput};
 };
}
