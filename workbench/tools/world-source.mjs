import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PROJECT,ROOT} from './workspace-paths.mjs';

const settings=path.join(ROOT,'world-source.json');
export function identifyWorld(directory){
 const absolute=fs.realpathSync(path.resolve(ROOT,directory));
 if(!fs.statSync(path.join(absolute,'region'),{throwIfNoEntry:false})?.isDirectory()||
  !fs.statSync(path.join(absolute,'level.dat'),{throwIfNoEntry:false})?.isFile())throw Error('请选择包含 level.dat 和 region 的世界存档目录');
 const uid=path.join(absolute,'uid.dat');
 const bytes=fs.existsSync(uid)?fs.readFileSync(uid):null;
 if(bytes&&bytes.length!==16)throw Error('存档 uid.dat 无效');
 const hex=bytes?.toString('hex');
 const uuid=hex?hex.match(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/).slice(1).join('-'):
  'local-'+createHash('sha256').update(absolute.replaceAll('\\','/').toLowerCase()).digest('hex').slice(0,32);
 return {directory:absolute,world_uuid:uuid,world:path.basename(absolute)};
}
export function worldSource(){
 let directory;
 try{
  directory=fs.existsSync(settings)?JSON.parse(fs.readFileSync(settings,'utf8')).directory:null;
  if(!directory&&process.env.TERRAWEAVE_WORLD)directory=path.resolve(PROJECT,process.env.TERRAWEAVE_WORLD);
  return directory?identifyWorld(directory):null;
 }catch(error){
  return {directory:typeof directory==='string'?path.resolve(ROOT,directory):undefined,error:error.message};
 }
}
export function saveWorldSource(directory,expectedUuid){
 if(typeof directory!=='string'||!directory.trim())throw Error('请填写存档目录');
 const source=identifyWorld(directory.trim());
 if(expectedUuid&&source.world_uuid!==expectedUuid)throw Error('此工程已有另一个世界的规划或草稿，请为该存档打开独立工程目录');
 fs.mkdirSync(ROOT,{recursive:true});
 const backup=settings+'.previous';
 if(fs.existsSync(settings))fs.copyFileSync(settings,backup);
 const pending=settings+'.pending-'+randomUUID();
 fs.writeFileSync(pending,JSON.stringify({directory:path.relative(ROOT,source.directory)}),{flag:'wx'});
 fs.renameSync(pending,settings);
 return source;
}
