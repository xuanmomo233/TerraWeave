import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {isDeepStrictEqual} from 'node:util';
import {checkIrisSupport,nativeIrisSources} from './iris-runtime.mjs';

export const animationMetadata=/^assets\/minecraft\/textures\/[a-z0-9_/-]+\.png\.mcmeta$/;
const resource=/^assets\/minecraft\/(?:blockstates\/[a-z0-9_/-]+\.json|models\/[a-z0-9_/-]+\.json|textures\/[a-z0-9_/-]+\.png(?:\.mcmeta)?)$/;
const read=(file,fallback)=>{
 try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}
};
const entries=dir=>fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}):[];
const compatibility=new Map();
function shaderEntry(assets,id,minecraft){
 const file=path.join(assets,'shaderpacks',id),stamp=fs.statSync(file),options=fs.statSync(file+'.txt',{throwIfNoEntry:false});
 const key=[minecraft,stamp.size,stamp.mtimeMs,options?.size,options?.mtimeMs].join(':');
 const previous=compatibility.get(file);
 if(previous?.key===key&&!fs.existsSync(file+'.inputs'))return previous.entry;
 let issues;
 try{issues=checkIrisSupport(nativeIrisSources(assets,id,minecraft));}catch(error){issues=[error.message];}
 const entry={id,name:id,format:'iris_zip',supported:issues.length===0,issues};
 compatibility.set(file,{key,entry});
 return entry;
}

export function readRenderSettings(assets,minecraft){
 const config=read(path.join(assets,'render-settings.json'),{pack_order:['流云琼阁启动器材质包.zip'],shader:'off',roots:[]});
 const packs=entries(path.join(assets,'resourcepacks')).filter(e=>e.isDirectory()||e.isFile()&&e.name.toLowerCase().endsWith('.zip')).map(e=>e.name);
 const shaders=entries(path.join(assets,'shaderpacks'))
  .filter(e=>e.isFile()&&e.name.toLowerCase().endsWith('.zip'))
  .map(e=>shaderEntry(assets,e.name,minecraft));
 const selected=shaders.find(entry=>entry.id===config.shader);
 const shader=selected?.supported?config.shader:'off';
 return {pack_order:config.pack_order,shader,packs,shaders,shader_error:selected&&!selected.supported?selected.issues.join(' · '):undefined};
}

// Index the ZIP central directory, then extract only the supported asset paths.
export function visitZipEntries(bytes,accept,visit){
 let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){
  if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
 }
 if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6))throw Error('不支持此 ZIP 格式');
 const count=bytes.readUInt16LE(end+10);
 if(count===65535)throw Error('资源包 ZIP 过大');
 let offset=bytes.readUInt32LE(end+16),total=0,imported=0;
 for(let i=0;i<count;i++){
  if(offset+46>end||bytes.readUInt32LE(offset)!==0x02014b50)throw Error('资源包 ZIP 目录不完整');
  const flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10);
  const size=bytes.readUInt32LE(offset+24),compressed=bytes.readUInt32LE(offset+20),at=bytes.readUInt32LE(offset+42);
  const nameLength=bytes.readUInt16LE(offset+28);
  const name=bytes.toString('utf8',offset+46,offset+46+nameLength);
  offset+=46+nameLength+bytes.readUInt16LE(offset+30)+bytes.readUInt16LE(offset+32);
  if(!accept(name)||name.split('/').some(part=>part==='..'||part==='.')||size>2_000_000)continue;
  if(flags&1||at+30>bytes.length||bytes.readUInt32LE(at)!==0x04034b50)throw Error('资源包 ZIP 条目无效');
  const start=at+30+bytes.readUInt16LE(at+26)+bytes.readUInt16LE(at+28);
  if(start+compressed>bytes.length||![0,8].includes(method))throw Error('资源包 ZIP 压缩方式不受支持');
  const data=method===8?inflateRawSync(bytes.subarray(start,start+compressed),{maxOutputLength:2_000_000}):bytes.subarray(start,start+compressed);
  if(data.length!==size||(total+=data.length)>256_000_000)throw Error('资源包解压超出限制');
  visit(name,data);imported++;
 }
 return imported;
}

function extractPack(bytes,target){
 const imported=visitZipEntries(bytes,name=>resource.test(name),(name,data)=>{
  const to=path.join(target,name.slice(7));
  fs.mkdirSync(path.dirname(to),{recursive:true});
  fs.writeFileSync(to,data,{flag:'wx'});
 });
 if(!imported)throw Error('未找到可导入的 Minecraft 方块资源');
 fs.writeFileSync(path.join(target,'.animation-metadata'),'1');
}

// Backfill only derived files for previously imported ZIPs. Keep the selected stack and the source ZIP untouched.
export function ensurePackAnimationMetadata(assets){
 const {roots=[],pack_order:order=[]}=read(path.join(assets,'render-settings.json'),{});
 for(const [i,relative] of roots.entries()){
  if(!/^render-pack-cache\/[a-f0-9]{64}$/.test(relative))continue;
  const destination=path.join(assets,relative),marker=path.join(destination,'.animation-metadata'),name=order[i];
  if(fs.existsSync(marker)||typeof name!=='string'||path.basename(name)!==name)continue;
  const archive=path.join(assets,'resourcepacks',name),stat=fs.statSync(archive,{throwIfNoEntry:false});
  if(!stat?.isFile()||stat.size>256_000_000||!fs.existsSync(destination))continue;
  const bytes=fs.readFileSync(archive);
  if(createHash('sha256').update(bytes).digest('hex')!==path.basename(relative))continue;
  visitZipEntries(bytes,entry=>animationMetadata.test(entry),(entry,data)=>{
   const target=path.join(destination,entry.slice(7));
   if(!fs.existsSync(target.slice(0,-7))||fs.existsSync(target))return;
   const pending=target+'.pending-'+randomUUID();
   fs.writeFileSync(pending,data,{flag:'wx'});
   try{fs.renameSync(pending,target);}
   catch(error){if(!fs.existsSync(target)||!fs.readFileSync(target).equals(data))throw error;}
   finally{if(fs.existsSync(pending))fs.unlinkSync(pending);}
  });
  fs.writeFileSync(marker,'1');
 }
}

export function saveRenderSettings(assets,args,minecraft){
 const catalog=readRenderSettings(assets,minecraft),order=args.pack_order;
 if(!Array.isArray(order)||order.length>20||new Set(order).size!==order.length||order.some(n=>!catalog.packs.includes(n)))throw Error('无效的材质包顺序');
 if(args.shader!=='off'&&!catalog.shaders.some(s=>s.id===args.shader&&s.supported))throw Error('请选择工作台支持的光影配置');
 const roots=order.map(name=>{
  const file=path.join(assets,'resourcepacks',name);
  if(fs.lstatSync(file).isDirectory())return 'resourcepacks/'+name+'/assets';
  if(fs.statSync(file).size>256_000_000)throw Error('资源包 ZIP 超出大小限制');
  const bytes=fs.readFileSync(file),hash=createHash('sha256').update(bytes).digest('hex'),id='render-pack-cache/'+hash,dest=path.join(assets,id);
  if(!fs.existsSync(dest)){
   const stage=dest+'.pending-'+randomUUID();
   fs.mkdirSync(stage,{recursive:true});
   try{extractPack(bytes,stage);fs.renameSync(stage,dest);}
   catch(e){fs.rmSync(stage,{recursive:true,force:true});throw e;}
  }
  return id;
 });
 const out=path.join(assets,'render-settings.json'),previous=read(out,null);
 if(previous?.shader===args.shader&&isDeepStrictEqual(previous.pack_order,order)&&isDeepStrictEqual(previous.roots,roots))return catalog;
 const config={pack_order:order,roots,shader:args.shader},pending=out+'.pending-'+randomUUID();
 fs.writeFileSync(pending,JSON.stringify(config),{flag:'wx'});
 fs.renameSync(pending,out);
 return readRenderSettings(assets,minecraft);
}

export function assetRoots(assets){
 const {roots}=read(path.join(assets,'render-settings.json'),{roots:['liuyun-textures']});
 return [...roots].reverse().map(root=>path.join(assets,root));
}
