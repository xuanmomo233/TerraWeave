import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {visitZipEntries} from './render-packs.mjs';

const includePattern=/^\s*#include\s+"([^"\r\n]+)"\s*(?:\/\/[^\r\n]*)?$/gm;
const supportedFile=/^shaders\/[a-zA-Z0-9_./-]+$/;
const programPattern=/^([a-z_][a-z_0-9]*)\.(vsh|fsh|gsh|csh|tcs|tes)$/;

export function readIrisArchive(file){
 if(fs.statSync(file).size>128_000_000)throw Error('光影 ZIP 超出大小限制');
 const bytes=fs.readFileSync(file),files=new Map();
 visitZipEntries(bytes,name=>supportedFile.test(name)&&!name.endsWith('/'),(name,data)=>{
  if(files.has(name))throw Error('光影 ZIP 有重复文件：'+name);
  files.set(name,data);
 });
 if(!files.size)throw Error('光影 ZIP 中没有 shaders 目录');
 function expand(file,parents=[],budget={remaining:4_000_000}){
  if(parents.includes(file)||parents.length>=32)throw Error('光影 include 循环或过深：'+file);
  const data=files.get(file);
  if(!data)throw Error('光影缺少文件：'+file);
  if((budget.remaining-=data.length)<0)throw Error('光影 include 展开后过大');
  const shader=data.toString('utf8').replaceAll('\r\n','\n');
  return shader.replace(includePattern,(_line,reference)=>{
   const next=path.posix.normalize(reference.startsWith('/')
    ?'shaders'+reference:path.posix.join(path.posix.dirname(file),reference));
   if(!supportedFile.test(next))throw Error('无效的光影 include 路径：'+reference);
   return expand(next,[...parents,file],budget);
  });
 }
 // Overworld programs override the root programs, which remain the fallback.
 function programs(dimension=''){
  if(dimension&&!/^world-?\d+$/.test(dimension))throw Error('无效的光影维度目录');
  const result=new Map();
  for(const prefix of dimension?['shaders/','shaders/'+dimension+'/']:['shaders/']){
   for(const file of files.keys()){
    if(!file.startsWith(prefix))continue;
    const parsed=programPattern.exec(file.slice(prefix.length));
    if(!parsed)continue;
    const [,program,stage]=parsed;
    if(!result.has(program))result.set(program,{});
    result.get(program)[stage]=file;
   }
  }
  return result;
 }
 return {hash:createHash('sha256').update(bytes).digest('hex'),files,expand,programs};
}

export function colorAttachments(pass,fragment){
 if(pass==='final')return ['screen'];
 const match=/\/\*\s*(DRAWBUFFERS|RENDERTARGETS)\s*:\s*([^*]+)\*\//.exec(fragment);
 const prefix=pass==='shadow'?'shadowcolor':'colortex';
 if(!match)return [prefix+'0'];
 const values=match[1]==='DRAWBUFFERS'?[...match[2].trim()]:match[2].trim().split(/\s*,\s*/);
 return values.map(n=>{
  if(n==='N')return null;
  if(!/^\d+$/.test(n)||Number(n)>15)throw Error('无效的光影颜色附件：'+n);
  return prefix+Number(n);
 });
}

export function inspectIrisArchive(pack){
 const passes=[],uniforms=new Set(),buffers=new Set(),issues=[];
 for(const [name,stages] of pack.programs('world0')){
  let source='',targets=[];
  try{
   const expanded=Object.fromEntries(Object.entries(stages).map(([stage,file])=>[stage,pack.expand(file)]));
   source=Object.values(expanded).join('\n');
   if(expanded.fsh)targets=colorAttachments(name,expanded.fsh);
  }
  catch(error){issues.push({pass:name,error:error.message});}
  for(const match of source.matchAll(/^\s*uniform\s+(?:\w+\s+)?(\w+)\s*(?:;|\[)/gm)){
   uniforms.add(match[1]);
   if(/^(?:colortex|depthtex|shadow(?:tex|color)|gaux)\d+$/.test(match[1]))buffers.add(match[1]);
  }
  passes.push({name,stages:Object.keys(stages),targets});
 }
 return {hash:pack.hash,passes,buffers:[...buffers].sort(),uniforms:[...uniforms].sort(),issues};
}
