import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readIrisArchive,colorAttachments} from './iris-shaderpack.mjs';
import {volumeSceneInfo} from './world-volume.mjs';
import {readLevelNbt,readWorldChunk,worldIndex} from './world-surface.mjs';
import {baselineMinecraft,supportedMinecraft} from '../minecraft-version.js';
import {assetRoots} from './render-packs.mjs';

const aliases={gcolor:0,gdepth:1,gnormal:2,composite:3,gaux1:4,gaux2:5,gaux3:6,gaux4:7};
function attachment(name){
 const match=/^colortex(\d+)$/.exec(name);
 if(match&&Number(match[1])<=15)return Number(match[1]);
 return Object.hasOwn(aliases,name)?aliases[name]:undefined;
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

function readOverrides(file){
 const settings=file+'.txt',stat=fs.statSync(settings,{throwIfNoEntry:false});
 if(!stat)return new Map();
 if(!stat.isFile()||stat.size>64*1024)throw Error('光影参数文件过大或不可读取');
 const pairs=fs.readFileSync(settings,'utf8').matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*([\w.+-]+)\s*$/gm);
 return new Map(Array.from(pairs,match=>match.slice(1)));
}

function applyOverrides(source,options){
 if(!options.size)return source;
 const allowed=(description,value)=>/\[([^\]]+)\]/.exec(description)?.[1].trim().split(/\s+/).includes(value);
 return source.replace(/^([ \t]*)(\/\/[ \t]*)?#define[ \t]+([A-Za-z_]\w*)(?:[ \t]+([\w.+-]+))?[ \t]*(\/\/[^\r\n]*)?$/gm,
  (original,indent,comment,name,value,description='')=>{
   if(!options.has(name))return original;
   const next=options.get(name);
   if(value===undefined&&['true','false'].includes(next))return indent+(next==='false'?'//':'')+'#define '+name+' '+description;
   if(value!==undefined&&allowed(description,next))return indent+'#define '+name+' '+next+' '+description;
   return original;
  }).replace(/^([ \t]*const[ \t]+(?:int|float)[ \t]+([A-Za-z_]\w*)[ \t]*=[ \t]*)([-+\d.eE]+)([ \t]*;[ \t]*(\/\/[^\r\n]*))$/gm,
  (original,prefix,name,_,suffix,description)=>{
   const next=options.get(name);
   if(next!==undefined&&allowed(description,next)&&Number.isFinite(Number(next)))return prefix+next+suffix;
   return original;
  });
}

function normalizeShaderHeader(source){
 const header=/^((?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*)?(#version[ \t][^\n]*)(?:\n|$)/.exec(source);
 if(!header)return source;
 return header[2].trimEnd()+'\n'+(header[1]??'')+source.slice(header[0].length);
}

function properties(source){
 return [...source.matchAll(/^([\w.]+)\s*=\s*([^\r\n#]+)$/gm)]
  .map(match=>[match[1],match[2].trim()]);
}

function computeSchedule(source){
 const values=(name,type)=>(new RegExp('\\bconst '+type+' '+name+'\\s*=\\s*'+type+'\\(([^)]+)\\)\\s*;').exec(source)?.[1]??'')
  .split(',').filter(Boolean).map(s=>Number(s.trim()));
 const groups=values('workGroups','ivec3'),relative=values('workGroupsRender','vec2');
 if(groups.length===1)groups.push(groups[0],groups[0]);
 if(relative.length===1)relative.push(relative[0]);
 if(groups.length&&(groups.length!==3||groups.some(n=>!Number.isInteger(n)||n<1||n>65535)))
  throw Error('光影 workGroups 需要有效的三个组数');
 if(relative.length&&(relative.length!==2||relative.some(n=>!Number.isFinite(n)||n<=0||n>4)))
  throw Error('光影 workGroupsRender 需要有效的两个比例');
 return {groups:groups.length?groups:undefined,relative:relative.length?relative:[1,1]};
}

function customInputs(assets,archive,file,props,minecraft){
 const images=[],textures=[],storage=[];
 const issues=[];
 for(const [key,value] of props){
  const buffer=/^bufferObject\.([0-8])$/.exec(key);
  if(buffer){
   const [bytes,...options]=value.split(/\s+/);
   const relative=options[0]==='true'&&options.length===3?options.slice(1).map(Number):undefined;
   const seed=options.length===1?archive.files.get('shaders/'+options[0].replace(/^\//,'')):undefined;
   if(!/^\d+$/.test(bytes)||Number(bytes)<1||Number(bytes)>128*1024*1024||
    options.length&&!relative&&!seed||seed&&seed.length>Number(bytes)||
    relative?.some(n=>!Number.isFinite(n)||n<=0||n>4)){
    issues.push('无效的光影存储缓冲 '+key);continue;
   }
   storage.push({binding:Number(buffer[1]),bytes:Number(bytes),relative,seed:seed?.toString('base64')});
   continue;
  }
  if(key.startsWith('image.')){
   const image=key.slice(6),[sampler,layout,format,type,clear,relative,...size]=value.split(/\s+/);
   if(size.length!==2||!['true','false'].includes(clear)||!['true','false'].includes(relative)
     ||!['red','rg','rgba'].includes(layout?.toLowerCase())||!['float','unsigned_byte','half_float','unsigned_short'].includes(type?.toLowerCase())){
    issues.push('未接入此自定义图像格式 '+image);continue;
   }
   images.push({image,sampler,format:format.toUpperCase(),clear:clear==='true',relative:relative==='true',size:size.map(Number)});
   continue;
  }
  const texture=/^texture\.(?:(\w+)\.)?(\w+)$/.exec(key),custom=/^customTexture\.(\w+)$/.exec(key);
  if(!texture&&!custom)continue;
  const stage=texture?.[1]??null,sampler=key==='texture.noise'?'noisetex':custom?.[1]??texture[2],name=value.split(/\s+/)[0];
  if(name!==value||!/^([\w.-]+:)?[a-zA-Z0-9_./-]+\.png$/.test(name)||name.split('/').includes('..')){
   issues.push('未接入此纹理输入 '+key);continue;
  }
  let data;
  if(!name.includes(':'))data=archive.files.get('shaders/'+name.replace(/^\//,''));
  else{
   const [namespace,resource]=name.split(':');
   const snapshot=file+'.inputs';
   const vanilla=minecraft===baselineMinecraft?assets:path.join(assets,'vanilla',minecraft);
   const dirs=namespace==='minecraft'?[...assetRoots(assets),vanilla]:[path.join(snapshot,'assets')];
   for(const dir of dirs){
    if(!fs.existsSync(dir))continue;
    const root=fs.realpathSync(dir),candidate=path.join(root,namespace,resource);
    if(!fs.statSync(candidate,{throwIfNoEntry:false})?.isFile())continue;
    const image=fs.realpathSync(candidate);
    if(!image.startsWith(root+path.sep)||fs.statSync(image).size>2_000_000)continue;
    data=fs.readFileSync(image);break;
   }
  }
  if(!data){issues.push('缺少光影纹理 '+name);continue;}
  textures.push({stage,sampler,png:'data:image/png;base64,'+data.toString('base64')});
 }
 return {images,textures,storage,issues};
}

export function nativeIrisSources(assets,id,minecraft=baselineMinecraft){
 if(typeof id!=='string'||!id.toLowerCase().endsWith('.zip')||/[\\/:]/.test(id)||id==='..')throw Error('无效的原版光影文件');
 if(!supportedMinecraft(minecraft))throw Error('无法为存档版本生成光影宏');
 const [major,minor,patch=0]=minecraft.split('.').map(Number);
 const versionMacro=major*10000+minor*100+patch;
 const file=path.join(assets,'shaderpacks',id);
 if(!fs.lstatSync(file).isFile())throw Error('光影必须是目录中的 ZIP 文件');
 const archive=readIrisArchive(file),programs=[],formats=Array(16).fill('RGBA8'),persistent=new Set();
 const overrides=readOverrides(file);
 const props=archive.files.get('shaders/shaders.properties')?.toString('utf8')??'';
 const inputs=customInputs(assets,archive,file,properties(props),minecraft);
 const settings=applyOverrides((archive.files.get('shaders/shaders.settings')?.toString('utf8')??'').replaceAll('\r\n','\n'),overrides);
 const value=(source,name,backup)=>Number(new RegExp('\\b'+name+'\\s*=\\s*(-?[0-9.]+)\\s*;').exec(source)?.[1]??backup);
 let attachmentCount=8;
 const load=stage=>{
  const source=normalizeShaderHeader(applyOverrides(archive.expand(stage),overrides));
  return minecraft===baselineMinecraft?source:source.replace(/^#version[^\n]*\n/,line=>line+'#undef MC_VERSION\n#define MC_VERSION '+versionMacro+'\n');
 };
 for(const [name,stages] of archive.programs('world0')){
  // Distant Horizons supplies its own meshes and enables these only when loaded.
  if(name.startsWith('dh_'))continue;
  if(stages.csh){
   const group=name.replace(/_[a-z]$/,'');
   if(!/^(?:(?:setup|begin|prepare|deferred|composite)\d{0,2}|final)$/.test(group))
    throw Error('未接入此计算阶段 '+name);
   const compute=load(stages.csh);
   for(const [,slot] of compute.matchAll(/\bcolorimg(1[0-5]|\d)\b/g))attachmentCount=Math.max(attachmentCount,Number(slot)+1);
   programs.push({name:name+'.csh',group,compute,...computeSchedule(compute),vertex:'',fragment:'',targets:[],mipmaps:[],blend:false,alpha_test:0});
  }
  if(!stages.vsh&&!stages.fsh&&Object.keys(stages).length===1&&stages.csh)continue;
  if(!stages.vsh||!stages.fsh||Object.keys(stages).some(stage=>!['vsh','fsh','csh'].includes(stage)))throw Error('暂不支持光影阶段 '+name+' 的着色器组合');
  const vertex=load(stages.vsh),fragment=load(stages.fsh);
  const targets=colorAttachments(name,fragment);
  const references=[...targets,...(vertex+'\n'+fragment).matchAll(/\bcolortex(?:1[0-5]|[0-9])(?=\b|Format|Clear|MipmapEnabled)/g)].map(value=>attachment(typeof value==='string'?value:value?.[0]));
  for(const slot of references)if(slot!==undefined)attachmentCount=Math.max(attachmentCount,slot+1);
  for(const [,buffer,format] of fragment.matchAll(/\bconst\s+int\s+(\w+)Format\s*=\s*(\w+)\s*;/g)){
   const n=attachment(buffer);if(n!==undefined)formats[n]=format;
  }
  for(const [,buffer] of fragment.matchAll(/\bconst\s+bool\s+(\w+)Clear\s*=\s*false\s*;/g)){
   const n=attachment(buffer);if(n!==undefined)persistent.add(n);
  }
  const mipmaps=[...fragment.matchAll(/\bconst\s+bool\s+(\w+)MipmapEnabled\s*=\s*true\s*;/g)]
   .map(m=>attachment(m[1])).filter(n=>n!==undefined);
  const alpha=new RegExp('^alphaTest\\.'+name+'=GREATER\\s+([0-9.]+)','m').exec(props);
  programs.push({name,vertex,fragment,targets,mipmaps,
   blend:name==='gbuffers_water'&&!props.includes('blend.'+name+'=off'),
   alpha_test:alpha?Number(alpha[1]):name.startsWith('gbuffers_')?.1:0});
 }
 const shaders=settings+'\n'+programs.map(p=>p.fragment).join('\n');
 const required=properties(props).find(([key])=>key==='iris.features.required')?.[1].split(/\s+/)??[];
 for(const feature of required)if(!['COMPUTE_SHADERS','CUSTOM_IMAGES','SSBO'].includes(feature))inputs.issues.push('缺少光影所需功能 '+feature);
 const hash=overrides.size||minecraft!==baselineMinecraft||inputs.textures.length
  ?createHash('sha256').update(JSON.stringify([archive.hash,minecraft,[...overrides].sort(),inputs.textures])).digest('hex'):archive.hash;
 const pack={name:id,hash,archive_sha256:archive.hash,programs,...inputs,formats:formats.slice(0,attachmentCount),persistent:[...persistent],
  shadow_size:value(shaders,'shadowMapResolution',1024),noise_size:value(shaders,'noiseTextureResolution',256),
  shadow_translucent:!/^shadowTranslucent=false/m.test(props),
  shadow_distance:value(shaders,'shadowDistance',80),sun_path_rotation:value(shaders,'sunPathRotation',0),
  block_rules:blockRules(archive.files.get('shaders/block.properties')?.toString('utf8')??'')};
 return pack;
}
export function checkIrisSupport(pack){
 const supportedFormats=new Set(['RGBA','RGBA8','RGBA16','RGBA16F','RGBA32F','R11F_G11F_B10F',
  'R8','RG8','RGB8','R16','RG16','RGB16','R16F','RG16F','RGB16F','R32F','RG32F','RGB32F','RGB10_A2']);
 const unsupported=[...new Set(pack.formats.filter(f=>!supportedFormats.has(f)))];
 const stages=pack.programs.map(p=>p.name);
 const incompatible=stages.filter(s=>s.startsWith('shadowcomp'));
 const missing=['shadow','gbuffers_skybasic','gbuffers_skytextured','gbuffers_terrain','gbuffers_water','final'].filter(s=>!stages.includes(s));
 const issues=[...(pack.issues??[])];
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
 const meta=readLevelNbt(path.join(index.directory,'level.dat'))?.Data;
 const modern=index.data_version>=4786;
 const clocks=modern?readLevelNbt(path.join(index.directory,'data/minecraft/world_clocks.dat'))?.data?.clocks:null;
 const weather=modern?readLevelNbt(path.join(index.directory,'dimensions/minecraft/overworld/data/minecraft/weather.dat'))?.data:meta;
 const ticks=clocks?.['minecraft:overworld']?.total_ticks??meta?.DayTime??(modern?0:undefined);
 if(ticks===undefined)throw Error('存档缺少日照时间数据');
 const time=BigInt(ticks),day=((time%24000n)+24000n)%24000n;
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
  raining:!!weather?.raining,thundering:!!weather?.thundering,chunks:chips};
}
