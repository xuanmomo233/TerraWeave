import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {javaReleases,supportedMinecraft} from '../minecraft-version.js';
import {readAnvilRegion,readLevelNbt,stateName,worldIndex} from './world-surface.mjs';
import {sectionIndices} from './world-volume.mjs';
import {blockConverter,registryContains} from './design-conversion.mjs';

export const WORLD_VERSION_AUDIT_TOOL={
 name:'audit_world_version',
 description:'Scan the Java save linked to the current project and export compatibility reports for a target version. The scan reads the save without applying any changes.',
 inputSchema:{type:'object',properties:{target_version:{type:'string',enum:Object.keys(javaReleases)}},required:['target_version'],additionalProperties:false}
};
const releases=new Map(Object.entries(javaReleases).map(([version,id])=>[id,version]));
const regionFolders=new Set(['region','entities','poi']);
const groups={
 incompatible_block:'需要替换的方块',adapted_block:'可按已知规则调整的方块',
 item:'目标版本缺少的物品',entity:'目标版本缺少的实体',
 block_entity:'目标版本缺少的方块实体',check_data:'需要另行核对的数据',unreadable:'无法读取的数据'
};
const namespaced=id=>id.includes(':')?id:'minecraft:'+id;

function saveFiles(root,record){
 const files=[];
 const stack=[root],siblings=path.dirname(root);
 for(const suffix of ['_nether','_the_end']){
  const folder=path.join(siblings,path.basename(root)+suffix);
  const info=fs.lstatSync(folder,{throwIfNoEntry:false});
  if(info?.isDirectory()&&fs.existsSync(path.join(folder,'level.dat')))stack.push(folder);
 }
 const roots=[...stack];
 while(stack.length){
  const current=stack.pop();
  for(const entry of fs.readdirSync(current,{withFileTypes:true})){
   const file=path.join(current,entry.name),relative=path.relative(root,file).split(path.sep).join('/');
   if(entry.isSymbolicLink()){
    record('unreadable',relative,'符号链接需要单独检查',relative);
   }else if(entry.isDirectory()){
    if(entry.name==='datapacks'){
     for(const pack of fs.readdirSync(file))record('check_data',pack,'外部数据包需要对应版本',relative+'/'+pack);
    }else stack.push(file);
   }else if(entry.isFile()&&(
    regionFolders.has(path.basename(current))&&/^[rc]\.-?\d+\.-?\d+\.(?:mca|mcc)$/.test(entry.name)||
    entry.name.endsWith('.dat')
   ))files.push({file,relative});
  }
 }
 return {files:files.sort((a,b)=>a.relative.localeCompare(b.relative)),roots};
}

export function auditWorldVersion({targetVersion,folder,atomic}){
 const index=worldIndex();
 if(!index.directory)throw Error('请先关联要检查的 Java 版存档');
 if(!supportedMinecraft(targetVersion))throw Error('目标版本超出当前检查范围');
 if(index.minecraft===targetVersion)throw Error('请选择和当前存档不同的版本');
 const catalog=new Map(),converters=new Map(),versions=new Map();
 const scope={terrain_chunks:0,entity_chunks:0,poi_chunks:0,data_files:0,block_entities:0};
 function record(kind,id,reason,sample,count=1){
  const key=JSON.stringify([kind,id,reason]);
  let issue=catalog.get(key);
  if(!issue){issue={kind,id,reason,count:0,samples:[]};catalog.set(key,issue);}
  issue.count+=count;
  if(issue.samples.length<5&&!issue.samples.includes(sample))issue.samples.push(sample);
 }
 function checkRegistry(name,kind,id,location){
  if(typeof id==='string'&&id&&!registryContains(targetVersion,name,namespaced(id)))
   record(kind,namespaced(id),'目标版本缺少此标识',location);
 }
 function dataTags(value,location,kind){
  if(kind==='item'&&typeof value==='string'){
   if(/^[a-z0-9_.-]+:[a-z0-9_/.\-]+$/.test(value))checkRegistry('item','item',value,location);
   return;
  }
  if(!value||typeof value!=='object'||Buffer.isBuffer(value))return;
  if(Array.isArray(value)){
   for(const entry of value)dataTags(entry,location,kind);
   return;
  }
  const id=value.id;
  if(kind==='entity')checkRegistry('entity_type','entity',id,location);
  if(typeof id==='string'&&(typeof value.Count==='number'||typeof value.count==='number'||kind==='item'))
   checkRegistry('item','item',id,location);
  for(const [key,entry] of Object.entries(value)){
   if(key==='sections'||key==='Sections'||key==='Heightmaps')continue;
   const nested=/^(?:Entities|entities|Passengers|RootVehicle|Entity)$/.test(key)?'entity':
    /^(?:Items|Inventory|EnderItems|HandItems|ArmorItems|Item|item|RecordItem)$/.test(key)?'item':undefined;
   dataTags(entry,location,nested);
  }
 }
 function blocks(chunk,x,z,location){
  const source=releases.get(chunk.DataVersion);
  if(!source){record('unreadable',String(chunk.DataVersion),'区块数据版本没有官方正式版对照表',location);return;}
  let transform=converters.get(source);
  if(!transform){
   const results=new Map(),convert=blockConverter(source,targetVersion);
   transform=value=>{if(!results.has(value))results.set(value,convert(value));return results.get(value);};
   converters.set(source,transform);
  }
  for(const section of chunk.sections??[]){
   const palette=section.block_states?.palette;
   if(!palette?.length)continue;
   const mismatches=new Map();
   for(const [index,entry] of palette.entries()){
    const id=stateName(entry),result=transform(id);
    if(result.kind!=='exact')mismatches.set(index,{id:id??'无法识别的方块',result,count:0,first:undefined});
   }
   if(!mismatches.size)continue;
   const cells=sectionIndices(section);
   if(!cells){record('unreadable',location,'区段方块索引不完整',location+' · 区段 '+section.Y);continue;}
   for(let i=0;i<cells.length;i++){
    const affected=mismatches.get(cells[i]);
    if(!affected)continue;
    affected.count++;
    affected.first??=[x*16+i%16,section.Y*16+(i>>8),z*16+((i>>4)&15)].join(', ');
   }
   for(const {id,result,count,first} of mismatches.values())if(count){
    const kind=result.state?'adapted_block':'incompatible_block';
    record(kind,id,result.state?'转换为 '+result.state:result.reason,location+' · '+first,count);
   }
  }
 }

 const {files,roots}=saveFiles(index.directory,record);
 const initial=new Map(files.map(({file})=>[file,stamp(file)]));
 function stamp(file){const info=fs.statSync(file);return [info.size,info.mtimeMs].join('/');}
 for(const {file,relative} of files){
  if(file.endsWith('.mcc'))continue;
  if(file.endsWith('.dat')){
   scope.data_files++;
   const data=readLevelNbt(file);
   if(!data){record('unreadable',relative,'NBT 文件无法读取',relative);continue;}
   dataTags(data,relative);
   continue;
  }
  const type=path.basename(path.dirname(file));
  try{
   for(const {x,z,chunk,error} of readAnvilRegion(file)){
    const location=relative+' · 区块 '+x+', '+z;
    if(error){record('unreadable',relative,error,location);continue;}
    const version=chunk.DataVersion??'未记录';
    versions.set(version,(versions.get(version)??0)+1);
    if(type==='region'){
     scope.terrain_chunks++;
     blocks(chunk,x,z,location);
     for(const entity of chunk.block_entities??[]){
      scope.block_entities++;
      checkRegistry('block_entity_type','block_entity',entity.id,relative+' · '+[entity.x,entity.y,entity.z].join(', '));
     }
    }else if(type==='entities')scope.entity_chunks++;
    else scope.poi_chunks++;
    dataTags(chunk,location);
   }
  }catch(error){record('unreadable',relative,error.message,relative);}
 }
 record('check_data','level.dat','存档元数据、维度与数据包仍需按目标版本处理','level.dat');
 if(scope.block_entities)record('check_data','方块实体 NBT','需要核对容器、告示牌及其他状态结构',index.world,scope.block_entities);
 const final=saveFiles(index.directory,()=>{}).files;
 if(initial.size!==final.length||final.some(({file})=>initial.get(file)!==stamp(file))||
    worldIndex().revision!==index.revision)throw Error('存档在扫描过程中发生变化，请保存并关闭游戏或停服后重新检查');
 const issues=[...catalog.values()].sort((a,b)=>Object.keys(groups).indexOf(a.kind)-Object.keys(groups).indexOf(b.kind)||b.count-a.count||a.id.localeCompare(b.id));
 const counts=Object.fromEntries(Object.keys(groups).map(kind=>[kind,issues.filter(item=>item.kind===kind).reduce((sum,item)=>sum+item.count,0)]));
 const report={source_world:index.world,source_version:index.minecraft,source_data_version:index.data_version,
  target_version:targetVersion,target_data_version:javaReleases[targetVersion],roots,scope,region_data_versions:Object.fromEntries(versions),counts,issues};
 const prefix='world-version-'+createHash('sha256').update(JSON.stringify(report)).digest('hex').slice(0,20);
 const output=folder('exports'),reportPath=path.join(output,prefix+'.json'),markdownPath=path.join(output,prefix+'.md');
 if(!fs.existsSync(reportPath))atomic(reportPath,report);
 const text=['# 世界存档版本差异','',`存档 ${report.source_world} · ${report.source_version} → ${targetVersion}`,'',
  `已读取 ${scope.terrain_chunks} 个地形区块、${scope.entity_chunks} 个实体区块、${scope.poi_chunks} 个兴趣点区块和 ${scope.data_files} 个 NBT 文件。`,
  '',
  ...Object.entries(groups).flatMap(([kind,title])=>{
   const entries=issues.filter(issue=>issue.kind===kind);
   if(!entries.length)return [];
   return ['## '+title,'',...entries.map(issue=>`- ${issue.id} · ${issue.count} 处 · ${issue.reason}。位置样例 ${issue.samples.join(' / ')}`),''];
  })
 ].join('\n');
 try{fs.writeFileSync(markdownPath,text,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
 return {...report,issues:issues.slice(0,30),issue_count:issues.length,report_path:markdownPath,json_path:reportPath};
}
