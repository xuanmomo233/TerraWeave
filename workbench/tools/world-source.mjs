import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PROJECT,ROOT} from './workspace-paths.mjs';
import {readVoidWorld} from './void-world.mjs';
import {readLevelNbt} from './nbt.mjs';

const localId=directory=>'local-'+createHash('sha256').update(directory.replaceAll('\\','/').toLowerCase()).digest('hex').slice(0,32);
const localUuid=/^local-[a-f0-9]{32}$/;
const formatUuid=bytes=>bytes.toString('hex').match(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/).slice(1).join('-');
function paperUuid(directory,regionDirectory){
 const metadata=path.join(path.dirname(regionDirectory),'data','paper','metadata.dat');
 if(fs.existsSync(metadata)){
  const parts=readLevelNbt(metadata)?.data?.uuid;
  if(!Array.isArray(parts)||parts.length!==4||parts.some(value=>!Number.isInteger(value)||value< -0x80000000||value>0x7fffffff))
   throw Error('Paper 主世界 metadata.dat 的 UUID 无法读取');
  const bytes=Buffer.alloc(16);
  parts.forEach((value,index)=>bytes.writeInt32BE(value,index*4));
  return formatUuid(bytes);
 }
 const uid=path.join(directory,'uid.dat');
 if(!fs.existsSync(uid))return;
 const bytes=fs.readFileSync(uid);
 if(bytes.length!==16)throw Error('存档 uid.dat 无效');
 return formatUuid(bytes);
}
function linkFile(root){return path.join(root,'world-source.json');}
function readLink(root){
 const settings=linkFile(root);
 return fs.existsSync(settings)?JSON.parse(fs.readFileSync(settings,'utf8')):null;
}
function levelHash(directory){return createHash('sha256').update(fs.readFileSync(path.join(directory,'level.dat'))).digest('hex');}
export function overworldRegionDirectory(directory){
 for(const relative of ['dimensions/minecraft/overworld/region','region']){
  const candidate=path.join(directory,relative);
  if(fs.statSync(candidate,{throwIfNoEntry:false})?.isDirectory())return candidate;
 }
 return null;
}
export function identifyWorld(directory,root=ROOT){
 const absolute=fs.realpathSync(path.resolve(root,directory));
 const region_directory=overworldRegionDirectory(absolute);
 if(!region_directory||!fs.statSync(path.join(absolute,'level.dat'),{throwIfNoEntry:false})?.isFile())
  throw Error('请选择包含 level.dat 和主世界区块的存档目录');
 const uuid=paperUuid(absolute,region_directory)??localId(absolute);
 const voidWorld=readVoidWorld(absolute);
 return {directory:absolute,region_directory,world_uuid:uuid,world:voidWorld?.name??path.basename(absolute),...(voidWorld?{void_world:voidWorld}:{})};
}
export function worldSource(root=ROOT,override=root===ROOT?process.env.TERRAWEAVE_WORLD:undefined){
 let directory;
 try{
  const link=readLink(root);
  directory=link?.directory;
  if(!directory&&override)directory=path.resolve(PROJECT,override);
  if(!directory)return null;
  const source=identifyWorld(directory,root);
  if(link?.paper_world_uuid&&source.world_uuid!==link.paper_world_uuid)throw Error('存档的 Paper 世界 UUID 已变化');
  if(localUuid.test(link?.world_uuid)){
   if(!localUuid.test(source.world_uuid))source.paper_world_uuid=source.world_uuid;
   source.world_uuid=link.world_uuid;
  }
  return source;
 }catch(error){
  return {directory:typeof directory==='string'?path.resolve(root,directory):undefined,error:error.message};
 }
}
export function saveWorldSource(directory,expectedUuid,root=ROOT){
 if(typeof directory!=='string'||!directory.trim())throw Error('请填写存档目录');
 const source=identifyWorld(directory.trim(),root);
 const current=worldSource(root);
 const linked=current?.directory===source.directory&&!current.error?current:source;
 if(expectedUuid&&linked.world_uuid!==expectedUuid)throw Error('此工程已有另一个世界的规划或草稿，请为该存档打开独立工程目录');
 return writeLink(root,linked);
}
function writeLink(root,source){
 fs.mkdirSync(root,{recursive:true});
 const settings=linkFile(root);
 const backup=settings+'.previous';
 if(fs.existsSync(settings))fs.copyFileSync(settings,backup);
 const pending=settings+'.pending-'+randomUUID();
 fs.writeFileSync(pending,JSON.stringify({directory:path.relative(root,source.directory),world_uuid:source.world_uuid,paper_world_uuid:source.paper_world_uuid,
  level_sha256:levelHash(source.directory)}),{flag:'wx'});
 fs.renameSync(pending,settings);
 return source;
}

export function worldLinkForBackup(expectedUuid,root=ROOT){
 const current=worldSource(root);
 if(!current?.directory)return null;
 if(!current.error)return {directory:current.directory,world_uuid:current.world_uuid,paper_world_uuid:current.paper_world_uuid,level_sha256:levelHash(current.directory)};
 const link=readLink(root);
 const id=expectedUuid??link?.world_uuid??localId(current.directory);
 return {directory:current.directory,world_uuid:id,paper_world_uuid:link?.paper_world_uuid,level_sha256:link?.level_sha256};
}

export function relocateWorldSource(directory,expectedUuid,confirmLegacy,root=ROOT){
 if(typeof directory!=='string'||!directory.trim())throw Error('请填写迁移后的存档目录');
 const source=identifyWorld(directory.trim(),root);
 const old=worldLinkForBackup(expectedUuid,root);
 if(!old)throw Error('当前工程没有已关联的存档，请使用正常的读取入口');
 const established=expectedUuid??old.world_uuid;
 if(source.world_uuid===established)return writeLink(root,source);
 if(localUuid.test(established)&&source.world_uuid===old.paper_world_uuid)
  return writeLink(root,{...source,world_uuid:established,paper_world_uuid:old.paper_world_uuid});
 if(!localUuid.test(established)||!localUuid.test(source.world_uuid))throw Error('目标存档的世界标识不同，请在新工程打开');
 const matches=old.level_sha256&&old.level_sha256===levelHash(source.directory);
 if(!matches){
  if(old.level_sha256)throw Error('目标存档的 level.dat 与原存档指纹不同，请检查迁移路径或在新工程打开');
  if(confirmLegacy!==true)throw Error('旧工程缺少存档指纹，请核对路径后确认这是同一个存档');
 }
 return writeLink(root,{...source,world_uuid:established});
}
