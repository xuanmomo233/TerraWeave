import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {readIrisArchive,colorAttachments} from './iris-shaderpack.mjs';
import {volumeSceneInfo} from './world-volume.mjs';
import {parseNbt,readWorldChunk,worldIndex} from './world-surface.mjs';

const aliases={gcolor:0,gdepth:1,gnormal:2,composite:3,gaux1:4,gaux2:5,gaux3:6,gaux4:7};
function attachment(name){
 return /^colortex[0-7]$/.test(name)?Number(name.at(-1)):aliases[name];
}
function blockRules(source){
 const result=[];
 let modern=true;
 for(const line of source.split(/\r?\n/)){
  if(/^\s*#if\s+MC_VERSION/.test(line)){modern=true;continue;}
  if(/^\s*#else/.test(line)){modern=false;continue;}
  if(/^\s*#endif/.test(line)){modern=true;continue;}
  if(!modern)continue;
  const match=/^block\.(\d+)\s*=([^#]*)/.exec(line.trim());
  if(!match)continue;
  for(const token of match[2].trim().split(/\s+/).filter(Boolean)){
   const [name,...properties]=token.replace(/^minecraft:/,'').split(':');
   result.push({name:'minecraft:'+name,id:Number(match[1]),properties});
  }
 }
 return result;
}

export function nativeIrisSources(assets,id){
 if(typeof id!=='string'||!id.toLowerCase().endsWith('.zip')||/[\\/:]/.test(id)||id==='..')throw Error('无效的原版光影文件');
 const file=path.join(assets,'shaderpacks',id);
 if(!fs.lstatSync(file).isFile())throw Error('光影必须是目录中的 ZIP 文件');
 const archive=readIrisArchive(file),programs=[],formats=Array(8).fill('RGBA8'),persistent=new Set();
 const props=archive.files.get('shaders/shaders.properties')?.toString('utf8')??'';
 const settings=archive.files.get('shaders/shaders.settings')?.toString('utf8')??'';
 const value=(source,name,backup)=>Number(new RegExp('\\b'+name+'\\s*=\\s*(-?[0-9.]+)\\s*;').exec(source)?.[1]??backup);
 for(const [name,stages] of archive.programs('world0')){
  if(!stages.vsh||!stages.fsh||Object.keys(stages).length!==2)throw Error('暂不支持光影阶段 '+name+' 的着色器组合');
  const vertex=archive.expand(stages.vsh),fragment=archive.expand(stages.fsh);
  for(const [,buffer,format] of fragment.matchAll(/\bconst\s+int\s+(\w+)Format\s*=\s*(\w+)\s*;/g)){
   const n=attachment(buffer);if(n!==undefined)formats[n]=format;
  }
  for(const [,buffer] of fragment.matchAll(/\bconst\s+bool\s+(\w+)Clear\s*=\s*false\s*;/g)){
   const n=attachment(buffer);if(n!==undefined)persistent.add(n);
  }
  const mipmaps=[...fragment.matchAll(/\bconst\s+bool\s+(\w+)MipmapEnabled\s*=\s*true\s*;/g)]
   .map(m=>attachment(m[1])).filter(n=>n!==undefined);
  const alpha=new RegExp('^alphaTest\\.'+name+'=GREATER\\s+([0-9.]+)','m').exec(props);
  programs.push({name,vertex,fragment,targets:colorAttachments(name,fragment),mipmaps,
   blend:name==='gbuffers_water'&&!props.includes('blend.'+name+'=off'),
   alpha_test:alpha?Number(alpha[1]):name.startsWith('gbuffers_')?.1:0});
 }
 const shaders=programs.map(p=>p.fragment).join('\n')+'\n'+settings;
 const pack={name:id,hash:archive.hash,programs,formats,persistent:[...persistent],
  shadow_size:value(settings,'shadowMapResolution',1024),noise_size:value(shaders,'noiseTextureResolution',256),
  shadow_translucent:!/^shadowTranslucent=false/m.test(props),
  shadow_distance:value(settings,'shadowDistance',80),sun_path_rotation:value(settings,'sunPathRotation',0),
  block_rules:blockRules(archive.files.get('shaders/block.properties')?.toString('utf8')??'')};
 return pack;
}
export function checkIrisSupport(pack){
 const supportedFormats=new Set(['RGBA','RGBA8','RGBA16','RGBA16F','RGBA32F','R11F_G11F_B10F']);
 const unsupported=[...new Set(pack.formats.filter(f=>!supportedFormats.has(f)))];
 const stages=pack.programs.map(p=>p.name);
 const incompatible=stages.filter(s=>/^(?:deferred|prepare|begin|setup|shadowcomp|dh_)/.test(s));
 const missing=['shadow','gbuffers_skybasic','gbuffers_skytextured','gbuffers_terrain','gbuffers_water','composite','final'].filter(s=>!stages.includes(s));
 const issues=[];
 if(unsupported.length)issues.push('颜色缓冲 '+unsupported.join(', '));
 if(incompatible.length)issues.push('未接入阶段 '+incompatible.join(', '));
 if(missing.length)issues.push('缺少阶段 '+missing.join(', '));
 if(pack.shadow_size<256||pack.shadow_size>4096||pack.noise_size<1||pack.noise_size>512)issues.push('阴影或噪声纹理尺寸超出当前渲染范围');
 return issues;
}

function packed(values,index,bits){
 const per=Math.floor(64/bits),v=values?.[Math.floor(index/per)];
 return v===undefined?0:Number((BigInt.asUintN(64,v)>>BigInt(index%per*bits))&((1n<<BigInt(bits))-1n));
}
export function savedIrisInputs(volumeCache,{revision,environment_revision,chunk_positions}={}){
 const index=worldIndex();
 if(!index.directory)throw Error('请先配置世界存档');
 if(revision&&revision!==index.revision||environment_revision&&environment_revision!==index.environment_revision)throw Error('存档修订已变化，请刷新预览');
 const positions=chunk_positions??volumeSceneInfo(volumeCache,index).occupied_chunks;
 if(!Array.isArray(positions)||positions.length>2000||
  positions.some(p=>!Array.isArray(p)||p.length<2||p.slice(0,2).some(n=>!Number.isSafeInteger(n)||Math.abs(n)>1875000)))throw Error('光影区块请求无效');
 const levelFile=path.join(index.directory,'level.dat');
 const meta=parseNbt(gunzipSync(fs.readFileSync(levelFile),{maxOutputLength:4_000_000})).Data;
 if(!meta||meta.DayTime===undefined)throw Error('存档缺少日照时间数据');
 const time=BigInt(meta.DayTime),day=((time%24000n)+24000n)%24000n;
 const chips=[];
 for(const [cx,cz] of positions){
  const n=readWorldChunk(cx,cz,index.directory);if(!n)continue;
  const height=n.Heightmaps?.WORLD_SURFACE??n.Heightmaps?.MOTION_BLOCKING;
  const sections=(n.sections??[]).map(s=>{
   const palette=s.biomes?.palette??[],bits=Math.max(1,Math.ceil(Math.log2(palette.length)));
   return {y:s.Y,block:s.BlockLight?.toString('base64'),sky:s.SkyLight?.toString('base64'),
    biomes:palette.length?Array.from({length:64},(_,i)=>palette[packed(s.biomes.data,i,bits)]??palette[0]):[]};
  });
  chips.push({x:cx,z:cz,top:height?Array.from({length:256},(_,i)=>packed(height,i,9)-64):null,sections});
 }
 if(worldIndex().environment_revision!==index.environment_revision)throw Error('读取光照时存档已变化，请刷新预览');
 return {world_uuid:index.world_uuid,world_revision:index.revision,environment_revision:index.environment_revision,day_time:Number(day),moon_phase:Number(((time/24000n)%8n+8n)%8n),
  raining:!!meta.raining,thundering:!!meta.thundering,chunks:chips};
}
