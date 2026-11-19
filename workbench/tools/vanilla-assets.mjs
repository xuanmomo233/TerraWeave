import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PROJECT} from './workspace-paths.mjs';
import {visitZipEntries} from './render-packs.mjs';

const size = 23028853;
const sha1 = '0c3ec587af28e5a785c0b4a7b8a30f9a8f78f838';
const url = 'https://piston-data.mojang.com/v1/objects/' + sha1 + '/client.jar';
const assets = path.join(PROJECT, 'assets');
const destination = path.join(assets, 'minecraft');
const available = () => ['models/block/stone.json','textures/block/stone.png','blockstates/stone.json'].every(name=>fs.existsSync(path.join(destination,name)));

async function vanillaArchive() {
 const appData = process.env.APPDATA;
 if (appData) {
  const local = path.join(appData, '.minecraft/versions/1.20.1/1.20.1.jar');
  if (fs.statSync(local,{throwIfNoEntry:false})?.size === size) {
   const bytes = fs.readFileSync(local);
   if (createHash('sha1').update(bytes).digest('hex') === sha1) return bytes;
  }
 }
 const response = await fetch(url,{redirect:'error',signal:AbortSignal.timeout(35000)});
 if (!response.ok || Number(response.headers.get('content-length')) !== size) throw Error('原版资源下载失败');
 const bytes = Buffer.from(await response.arrayBuffer());
 if (bytes.length !== size || createHash('sha1').update(bytes).digest('hex') !== sha1) throw Error('原版资源校验失败');
 return bytes;
}

let preparing;
export async function ensureVanillaAssets() {
 if (available()) return;
 if (preparing) return preparing;
 preparing = (async () => {
  const staging = path.join(assets, '.vanilla-' + randomUUID());
  try {
   const bytes = await vanillaArchive();
   const count = visitZipEntries(bytes, name => /^assets\/minecraft\/(?:(?:models|blockstates)\/[a-z0-9_/-]+\.json|textures\/[a-z0-9_/-]+\.png)$/.test(name), (name,data) => {
    const file = path.join(staging,name.slice('assets/minecraft/'.length));
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,data);
   });
   if (!count) throw Error('原版资源为空');
   if (!available()) fs.renameSync(staging,destination);
  } catch (error) {
   if (!available()) throw Error('无法准备 1.20.1 原版三维资源。请检查网络，或通过官方启动器安装对应版本。' + error.message);
  } finally {
   fs.rmSync(staging,{recursive:true,force:true});
  }
 })();
 try {await preparing;} finally {preparing = undefined;}
}

