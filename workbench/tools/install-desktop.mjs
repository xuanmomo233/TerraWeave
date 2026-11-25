import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const project=fileURLToPath(new URL('../',import.meta.url));
const source=path.join(project,'native-build/debug/terraweave.exe');
const binary=fs.readFileSync(source);
const pe=binary.readUInt32LE(0x3c);
if(binary.toString('ascii',0,2)!=='MZ'||binary.readUInt32LE(pe)!==0x4550||binary.readUInt16LE(pe+24+68)!==2){
 throw Error('桌面构建产物必须使用 Windows 图形子系统。');
}
const parent=path.dirname(path.resolve(project));
const checkout=path.basename(path.resolve(project))==='workbench'&&fs.existsSync(path.join(parent,'.git'));
const destinations=[path.join(project,'bin/TerraWeave.exe'),path.join(checkout?parent:project,'织境工坊.exe')];
const stamp=randomUUID();
const files=destinations.map(file=>({file,staged:file+'.new-'+stamp,previous:file+'.old-'+stamp}));
try{
 for(const entry of files){
  fs.mkdirSync(path.dirname(entry.file),{recursive:true});
  if(fs.existsSync(entry.file))fs.closeSync(fs.openSync(entry.file,'r+'));
  fs.writeFileSync(entry.staged,binary,{flag:'wx'});
 }
 for(const entry of files){
  if(fs.existsSync(entry.file)){
   fs.renameSync(entry.file,entry.previous);
   entry.saved=true;
  }
  fs.renameSync(entry.staged,entry.file);
  entry.installed=true;
 }
}catch(error){
 for(const entry of [...files].reverse()){
  if(entry.installed)fs.unlinkSync(entry.file);
  if(entry.saved)fs.renameSync(entry.previous,entry.file);
 }
 throw new Error('无法更新本地启动程序，请关闭正在使用这些文件的工坊窗口后重试。',{cause:error});
}finally{
 for(const entry of files)fs.rmSync(entry.staged,{force:true});
}
for(const entry of files)if(entry.saved)fs.unlinkSync(entry.previous);
console.log(destinations.join('\n'));
