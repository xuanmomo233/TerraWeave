import fs from 'node:fs';
import {copyFile,stat,mkdir,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRestoredProject,projectLocations} from './project-catalog.mjs';

const manifestName='terraweave-backup.json';
const dataFiles=new Set(['workspace.json','planning.json','current-region.json','map-view.json','editor-state.json']);
const dataFolders=new Set(['regions','snapshots','drafts','history','captures','exports','worlds']);
const format='terraweave-project-backup';
function portablePath(relative){
 if(typeof relative!=='string')throw Error('备份含无效的工程路径');
 const parts=relative.split('/');
 if(parts.some(part=>!part||/[<>:"\\|?*\u0000-\u001f]|[. ]$/u.test(part)||
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))||
    !(dataFolders.has(parts[0])||parts.length===1&&dataFiles.has(parts[0])))throw Error('备份含不支持的工程路径');
 return parts;
}
function checkedPath(root,relative){
 let target=root;
 for(const part of portablePath(relative)){
  target=path.join(target,part);
  if(fs.lstatSync(target).isSymbolicLink())throw Error('备份中含有符号链接：'+relative);
 }
 return target;
}
async function checksum(file){
 const hash=createHash('sha256');
 for await(const bytes of fs.createReadStream(file))hash.update(bytes);
 return hash.digest('hex');
}
async function copyVerified(source,target,relative){
 const before=await stat(source);
 await mkdir(path.dirname(target),{recursive:true});
 await copyFile(source,target,fs.constants.COPYFILE_EXCL);
 const after=await stat(source);
 if(before.mtimeMs!==after.mtimeMs||before.size!==after.size)throw Error('文件在备份期间发生变化：'+relative);
 return {path:relative,size:before.size,sha256:await checksum(target)};
}

export async function backupProject(project,directory,worldRecord){
 const parent=fs.realpathSync(directory);
 if(!(await stat(parent)).isDirectory())throw Error('请选择保存备份的文件夹');
 const relative=path.relative(project.root,parent).split(path.sep)[0];
 if(dataFolders.has(relative))throw Error('请选择工程数据文件夹以外的位置来保存备份');
 const name='织境工程备份-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,6);
 const target=path.join(parent,name),stage=target+'.pending';
 await mkdir(stage);
 const files=[],directories=[];
 async function visit(relative){
  const original=checkedPath(project.root,relative);
  const destination=path.join(stage,...portablePath(relative)),info=await stat(original);
  if(info.isDirectory()){
   await mkdir(destination,{recursive:true});
   directories.push(relative);
   for(const child of fs.readdirSync(original).sort())await visit(relative+'/'+child);
  }else if(info.isFile())files.push(await copyVerified(original,destination,relative));
  else throw Error('工程中含有不可复制的文件：'+relative);
 }
 try{
  for(const relative of [...dataFiles,...dataFolders])if(fs.existsSync(path.join(project.root,relative)))await visit(relative);
  const details=projectLocations(project.id);
  const source=worldRecord?{...worldRecord,directory:details.source_kind==='project-world'
   ?path.relative(project.root,details.directory).split(path.sep).join('/'):worldRecord.directory,owned:details.source_kind==='project-world'}:null;
  await writeFile(path.join(stage,manifestName),JSON.stringify({format,version:1,name:project.name,created_at:new Date().toISOString(),
   files,directories,source},null,2),{flag:'wx'});
  await rename(stage,target);
  return {directory:target,files:files.length,bytes:files.reduce((sum,file)=>sum+file.size,0)};
 }catch(error){await rm(stage,{recursive:true,force:true});throw error;}
}

export async function restoreProjectBackup(directory){
 const root=fs.realpathSync(directory),manifest=path.join(root,manifestName),info=fs.lstatSync(manifest,{throwIfNoEntry:false});
 if(!info?.isFile()||info.size>20_000_000)throw Error('请选择包含 '+manifestName+' 的备份文件夹');
 const data=JSON.parse(fs.readFileSync(manifest,'utf8'));
 if(data.format!==format||data.version!==1||typeof data.name!=='string'||!Array.isArray(data.files)||!Array.isArray(data.directories))throw Error('工程备份格式无效');
 const name=data.name.slice(0,57)+' · 恢复';
 return createRestoredProject(name,async target=>{
  const added=new Set();
  for(const entry of data.directories){
   if(!(await stat(checkedPath(root,entry))).isDirectory())throw Error('备份目录缺失：'+entry);
   await mkdir(path.join(target,...portablePath(entry)),{recursive:true});
  }
  for(const file of data.files){
   const name=file.path;
   if(added.has(name)||!Number.isSafeInteger(file.size)||file.size<0||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('备份文件清单无效');
   added.add(name);
   const original=checkedPath(root,name);
   if(!(await stat(original)).isFile())throw Error('备份文件缺失：'+name);
   const copied=await copyVerified(original,path.join(target,...portablePath(name)),name);
   if(copied.size!==file.size||copied.sha256!==file.sha256)throw Error('备份文件校验失败：'+name);
  }
  if(data.source){
   const {owned,directory,world_uuid,paper_world_uuid,level_sha256}=data.source;
   if(typeof directory!=='string'||typeof world_uuid!=='string'||!(/^(?:local-[a-f0-9]{32}|[a-f0-9-]{36})$/i.test(world_uuid)))throw Error('备份中的存档关联无效');
   if(paper_world_uuid!==undefined&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(paper_world_uuid))throw Error('备份中的 Paper 世界 UUID 无效');
   let link=directory;
   if(owned){
    const pieces=portablePath(directory);
    if(pieces[0]!=='worlds'||!fs.existsSync(path.join(target,...pieces,'level.dat')))throw Error('备份中的工程世界不完整');
    link=path.join(...pieces);
   }else if(!path.isAbsolute(directory))throw Error('备份的外部存档路径无效');
   await writeFile(path.join(target,'world-source.json'),JSON.stringify({directory:link,world_uuid,paper_world_uuid,level_sha256}),{flag:'wx'});
  }
 });
}
