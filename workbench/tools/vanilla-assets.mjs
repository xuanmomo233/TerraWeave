import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PROJECT} from './workspace-paths.mjs';
import {animationMetadata,visitZipEntries} from './render-packs.mjs';
import {baselineMinecraft,supportedMinecraft} from '../minecraft-version.js';

const size = 23028853;
const sha1 = '0c3ec587af28e5a785c0b4a7b8a30f9a8f78f838';
const url = 'https://piston-data.mojang.com/v1/objects/' + sha1 + '/client.jar';
const assets = path.join(PROJECT, 'assets');
const available = destination => {
 const have=name=>fs.existsSync(path.join(destination,name));
 return ['models/block/stone.json','textures/block/stone.png','blockstates/stone.json'].every(have)
  &&(['textures/environment/sun.png','textures/environment/moon_phases.png'].every(have)
   ||['textures/environment/celestial/sun.png','textures/environment/celestial/moon/full_moon.png'].every(have));
};
const preparing=new Map();
const retryMetadataAfter=new Map();

async function versionDownload(version,signal){
 if(version===baselineMinecraft)return {sha1,size,url};
 const metadataHost='piston-meta.mojang.com';
 const response=await fetch('https://'+metadataHost+'/mc/game/version_manifest_v2.json',{redirect:'error',signal});
 if(!response.ok)throw Error('无法读取 Mojang 版本清单');
 const entry=(await response.json()).versions.find(v=>v.id===version&&v.type==='release');
 if(!entry||new URL(entry.url).hostname!==metadataHost||!entry.url.startsWith('https://'))throw Error('找不到对应的正式版资源');
 const metadata=await fetch(entry.url,{redirect:'error',signal});
 if(!metadata.ok)throw Error('无法读取 Mojang 版本资料');
 const bytes=Buffer.from(await metadata.arrayBuffer());
 if(createHash('sha1').update(bytes).digest('hex')!==entry.sha1)throw Error('Mojang 版本资料校验失败');
 const client=JSON.parse(bytes).downloads?.client;
 if(!client||!/^https:\/\/piston-data\.mojang\.com\/v1\/objects\/[a-f0-9]{40}\/client\.jar$/.test(client.url)
   ||!Number.isSafeInteger(client.size)||client.size<1||client.size>100_000_000||!client.url.includes('/'+client.sha1+'/'))
  throw Error('无效的客户端资源指纹');
 return client;
}

async function vanillaArchive(version,signal) {
 const {size,sha1,url}=await versionDownload(version,signal);
 const launcher=process.env.TERRAWEAVE_MINECRAFT_HOME??(process.env.APPDATA&&path.join(process.env.APPDATA,'.minecraft'));
 if (launcher) {
  const local = path.join(launcher, 'versions', version, version+'.jar');
  if (fs.statSync(local,{throwIfNoEntry:false})?.size === size) {
   const bytes = fs.readFileSync(local);
   if (createHash('sha1').update(bytes).digest('hex') === sha1) return bytes;
  }
 }
 const response = await fetch(url,{redirect:'error',signal});
 if (!response.ok || Number(response.headers.get('content-length')) !== size) throw Error('原版资源下载失败');
 const bytes = Buffer.from(await response.arrayBuffer());
 if (bytes.length !== size || createHash('sha1').update(bytes).digest('hex') !== sha1) throw Error('原版资源校验失败');
 return bytes;
}

export async function ensureVanillaAssets(version=baselineMinecraft) {
 if(!supportedMinecraft(version))throw Error('不支持的原版资源版本：'+version);
 const parent=version===baselineMinecraft?assets:path.join(assets,'vanilla',version),destination=path.join(parent,'minecraft');
 const existing=available(destination),marker=path.join(destination,'.animation-metadata');
 if(existing&&(fs.existsSync(marker)||Date.now()<(retryMetadataAfter.get(version)??0)))return;
 if (preparing.has(version)) return preparing.get(version);
 const job = (async () => {
  const staging = path.join(assets, '.vanilla-' + randomUUID());
  try {
   const bytes = await vanillaArchive(version,AbortSignal.timeout(existing?8000:90000));
   const count=visitZipEntries(bytes,name=>animationMetadata.test(name)||!existing&&/^assets\/minecraft\/(?:(?:models|blockstates)\/[a-z0-9_/-]+\.json|textures\/[a-z0-9_/-]+\.png)$/.test(name),(name,data)=>{
    const file = path.join(staging,name.slice('assets/minecraft/'.length));
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,data);
   });
   if(!count||!existing&&!available(staging))throw Error('原版资源不完整');
   fs.mkdirSync(parent,{recursive:true});
   if(existing||!available(destination)){
    if(fs.existsSync(destination))fs.cpSync(staging,destination,{recursive:true,force:false});
    else fs.renameSync(staging,destination);
   }
   fs.writeFileSync(marker,'1');
  } catch (error) {
   if (!available(destination)) throw Error('无法准备 '+version+' 原版三维资源：' + error.message);
   retryMetadataAfter.set(version,Date.now()+60_000);
  } finally {
   fs.rmSync(staging,{recursive:true,force:true});
  }
 })();
 preparing.set(version,job);
 try {await job;} finally {preparing.delete(version);}
}

