import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const digest=value=>createHash('sha256').update(value).digest('hex');
const valid=id=>typeof id==='string'&&/^[a-zA-Z0-9-]{1,99}$/.test(id);
const time=r=>r.updated_at??r.captured_at??r.created_at??'';
const shape=r=>JSON.stringify([r.world_uuid,r.label,r.bounds,r.loaded_bounds]);
const signature=r=>JSON.stringify([r.snapshot_hash,r.label,r.notes??'',r.bounds,r.loaded_bounds,r.source]);
function inCoordinateOrder(keys){
 let lastX=0,lastY=-Infinity,lastZ=0;
 for(const key of keys){
  const first=key.indexOf(','),second=key.indexOf(',',first+1);
  if(first<0||second<0)return false;
  const x=Number(key.slice(0,first)),y=Number(key.slice(first+1,second)),z=Number(key.slice(second+1));
  if(!Number.isFinite(x+y+z)||y<lastY||y===lastY&&(z<lastZ||z===lastZ&&x<lastX))return false;
  lastX=x;lastY=y;lastZ=z;
 }
 return true;
}
function orderedBlocks(blocks){
 const keys=Object.keys(blocks);
 if(inCoordinateOrder(keys))return blocks;
 const coordinates=keys.map(key=>key.split(',').map(Number));
 const order=keys.map((_,i)=>i).sort((i,j)=>{
  const a=coordinates[i],b=coordinates[j];
  return a[1]-b[1]||a[2]-b[2]||a[0]-b[0];
 });
 return Object.fromEntries(order.map(i=>[keys[i],blocks[keys[i]]]));
}

export function snapshotBytes(snapshot){
 const canonical={schema:1,minecraft:snapshot.minecraft,world:snapshot.world,uuid:snapshot.uuid,bounds:snapshot.bounds,blocks:orderedBlocks(snapshot.blocks)};
 if(snapshot.context_blocks)canonical.context_blocks=orderedBlocks(snapshot.context_blocks);
 return JSON.stringify(canonical);
}
export function projectStore(root){
 const manifest=path.join(root,'workspace.json');
 const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
 function folder(name){const p=path.join(root,name);fs.mkdirSync(p,{recursive:true});return p;}
 function atomic(file,value){const pending=file+'.pending-'+randomUUID();fs.writeFileSync(pending,JSON.stringify(value),{flag:'wx'});fs.renameSync(pending,file);}
 function files(name){const p=path.join(root,name);return fs.existsSync(p)?fs.readdirSync(p).filter(n=>n.endsWith('.json')&&valid(n.slice(0,-5))):[];}
 function region(id){if(!valid(id))throw Error('Invalid region identity');return read(path.join(root,'regions',id+'.json'));}
 function synthesized(){
  const regions={};
  for(const filename of files('regions')){
   const r=read(path.join(root,'regions',filename));if(r.source==='design_draft'||r.transient)continue;
   const key=shape(r),id='region-'+digest(key).slice(0,24);
   if(!regions[id])regions[id]={id,label:r.label,world_uuid:r.world_uuid,identity_keys:[key],head:r.id,versions:[],revision_count:0,updated_at:time(r)};
   regions[id].versions.push(r.id);
  }
  for(const entity of Object.values(regions)){
   entity.versions.sort((a,b)=>time(region(b)).localeCompare(time(region(a))));entity.head=entity.versions[0];entity.revision_count=entity.versions.length;
  }
  return {schema:2,id:randomUUID(),label:'织境工坊',regions,checkpoints:[],retention:{region_versions:1,preview_versions:3},created_at:new Date().toISOString()};
 }
 const state=()=>fs.existsSync(manifest)?read(manifest):synthesized();
 function initialize(){fs.mkdirSync(root,{recursive:true});if(!fs.existsSync(manifest)){const data=synthesized();atomic(manifest,data);}return state();}
 function entityFor(r,data=state()){
  if(r.source==='design_draft'||r.transient)return null;
  if(r.entity_id&&data.regions[r.entity_id])return data.regions[r.entity_id];
  return Object.values(data.regions).find(e=>e.head===r.id||e.versions.includes(r.id)||e.identity_keys.includes(shape(r)))??null;
 }
 function decorate(r){const e=entityFor(r);return e?{...r,entity_id:e.id,archived:e.archived??false,revision_count:e.revision_count,is_current_revision:e.head===r.id,last_verified_at:e.head===r.id?e.last_verified_at:r.captured_at}:r;}
 function resolve(id){const data=state();return data.regions[id]?.head??id;}
 function saveSnapshot(snapshot){
  const bytes=snapshotBytes(snapshot),hash=digest(bytes),file=path.join(folder('snapshots'),hash+'.json');
  if(!fs.existsSync(file))fs.writeFileSync(file,bytes,{flag:'wx'});
  return {snapshot_id:hash,snapshot_hash:hash};
 }
 function commit(input,entityId,verified=false){
  const data=initialize(),existing=entityId?data.regions[entityId]:entityFor(input,data),e=existing??{id:'region-'+randomUUID(),versions:[],identity_keys:[],revision_count:0};
  let r=input;
  if(existing){const head=region(e.head);if(signature(head)===signature(input))r=head;}
  if(!e.versions.includes(r.id)){
   r={...r,entity_id:e.id};atomic(path.join(folder('regions'),r.id+'.json'),r);e.versions.unshift(r.id);e.revision_count++;
  }
  e.head=r.id;e.label=r.label;e.world_uuid=r.world_uuid;e.updated_at=new Date().toISOString();if(verified)e.last_verified_at=e.updated_at;else e.last_verified_at??=r.captured_at;
  if(!e.identity_keys.includes(shape(r)))e.identity_keys.push(shape(r));
  e.versions=e.versions.slice(0,data.retention.region_versions);data.regions[e.id]=e;atomic(manifest,data);return {...r,entity_id:e.id,revision_count:e.revision_count,last_verified_at:e.last_verified_at};
 }
 function savePreview(r){atomic(path.join(folder('regions'),r.id+'.json'),r);return r;}
 function listRegions(includeArchived=false){const data=state();return Object.values(data.regions).filter(e=>includeArchived||!e.archived).map(e=>decorate(region(e.head))).sort((a,b)=>(b.last_verified_at??time(b)).localeCompare(a.last_verified_at??time(a)));}
 function archive(id,archived=true){const data=initialize(),r=region(resolve(id)),e=entityFor(r,data);if(!e)throw Error('Region item not found');e.archived=archived;atomic(manifest,data);return decorate(r);}
 function revisions(id){const data=state(),r=region(resolve(id)),e=entityFor(r,data);if(!e)return [r];const saved=data.checkpoints.filter(c=>entityFor(region(c.region_id),data)?.id===e.id);return [...new Set([...e.versions,...saved.map(c=>c.region_id)])].map(id=>({...decorate(region(id)),pinned:saved.some(c=>c.region_id===id)}));}
 function checkpoint(id,label){
  const data=initialize(),r=region(resolve(id)),existing=data.checkpoints.find(c=>c.region_id===r.id);
  if(existing)return existing;
  const saved={id:randomUUID(),label:label||r.label,region_id:r.id,created_at:new Date().toISOString()};data.checkpoints.push(saved);atomic(manifest,data);return saved;
 }
 function saveWorkspace(label){const data=initialize();if(label!==undefined){if(typeof label!=='string'||!label.trim()||label.length>120)throw Error('Invalid project name');data.label=label.trim();}data.saved_at=new Date().toISOString();atomic(manifest,data);return {label:data.label,saved_at:data.saved_at};}
 function cleanupAssets(purgeArchived=false,oldCaptures=false){
  const data=initialize(),allDrafts=files('drafts').map(n=>read(path.join(root,'drafts',n))),draftIds=new Set(allDrafts.map(d=>d.id)),archivedEntities=new Set(Object.values(data.regions).filter(e=>e.archived).map(e=>e.id)),archivedDrafts=new Set(allDrafts.filter(d=>d.archived).map(d=>d.id));
  const captureRoot=path.join(root,'captures'),captures=[];
  if(fs.existsSync(captureRoot))for(const entry of fs.readdirSync(captureRoot,{withFileTypes:true}))if(entry.isDirectory()&&valid(entry.name)){
   const file=path.join(captureRoot,entry.name,'capture.json');if(!fs.existsSync(file))continue;const capture=read(file),owner=capture.region_id?region(capture.region_id):null,entity=owner?entityFor(owner,data):null;captures.push({id:entry.name,key:owner?(owner.draft_id?'draft:'+owner.draft_id:entity?.id??shape(owner)):'world-map',retired:!!owner&&(owner.draft_id&&!draftIds.has(owner.draft_id)||archivedDrafts.has(owner.draft_id)||archivedEntities.has(entity?.id))});
  }
  for(const item of captures)if(item.key==='world-map'&&['saved_anvil_volume_render','saved_anvil_textured_render','workbench_composite_render'].includes(read(path.join(captureRoot,item.id,'capture.json')).source))item.key='world-scene';
  captures.sort((a,b)=>b.id.localeCompare(a.id));const seen=new Set(),remove=[];
  for(const c of captures){if(purgeArchived&&c.retired||oldCaptures&&seen.has(c.key))remove.push(path.join(captureRoot,c.id));else seen.add(c.key);}
  if(purgeArchived){for(const id of archivedDrafts)remove.push(path.join(root,'drafts',id+'.json'));for(const id of archivedEntities)delete data.regions[id];data.checkpoints=data.checkpoints.filter(c=>!archivedEntities.has(entityFor(region(c.region_id))?.id));}
  let current;try{current=region(read(path.join(root,'current-region.json')).id);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(purgeArchived&&current&&(archivedDrafts.has(current.draft_id)||archivedEntities.has(entityFor(current)?.id))){const next=Object.values(data.regions).find(e=>!e.archived);if(next)atomic(path.join(root,'current-region.json'),{id:next.head});else fs.unlinkSync(path.join(root,'current-region.json'));}
  const size=p=>fs.lstatSync(p).isSymbolicLink()?0:fs.statSync(p).isDirectory()?fs.readdirSync(p).reduce((n,f)=>n+size(path.join(p,f)),0):fs.statSync(p).size;
  let bytes=0;for(const file of remove){bytes+=size(file);fs.rmSync(file,{recursive:true,force:true});}atomic(manifest,data);return {removed_assets:remove.length,freed_bytes:bytes};
 }
 function retention(versions,previews){const data=initialize();if(versions!==undefined){if(!Number.isInteger(versions)||versions<1||versions>20)throw Error('Keep 1..20 region versions');data.retention.region_versions=versions;}if(previews!==undefined){if(!Number.isInteger(previews)||previews<0||previews>20)throw Error('Keep 0..20 temporary views');data.retention.preview_versions=previews;}atomic(manifest,data);}
 function summary(){
  const data=state(),counts={};
  for(const name of ['regions','snapshots','drafts','history']){const names=files(name);counts[name]={count:names.length,bytes:names.reduce((n,f)=>n+fs.statSync(path.join(root,name,f)).size,0)};}
  for(const name of ['map-cache','volume-cache','model-cache']){const dir=path.join(root,name),names=fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).filter(f=>f.isFile()):[];counts[name]={count:names.length,bytes:names.reduce((n,f)=>n+fs.statSync(path.join(dir,f.name)).size,0)};}
  const planningFile=path.join(root,'planning.json');counts.planning={count:fs.existsSync(planningFile)?1:0,bytes:fs.existsSync(planningFile)?fs.statSync(planningFile).size:0};
  const captureRoot=path.join(root,'captures');if(fs.existsSync(captureRoot)){const dirs=fs.readdirSync(captureRoot,{withFileTypes:true}).filter(e=>e.isDirectory()&&valid(e.name));counts.captures={count:dirs.length,bytes:dirs.reduce((n,e)=>n+fs.readdirSync(path.join(captureRoot,e.name),{withFileTypes:true}).filter(f=>f.isFile()).reduce((s,f)=>s+fs.statSync(path.join(captureRoot,e.name,f.name)).size,0),0)};}
  return {schema:data.schema,label:data.label,region_items:Object.values(data.regions).filter(e=>!e.archived).length,archived_regions:Object.values(data.regions).filter(e=>e.archived).length,checkpoints:data.checkpoints.length,retention:data.retention,files:counts};
 }
 function compact(){
  const data=initialize(),keep=new Set(),pending=[];
  for(const e of Object.values(data.regions)){e.versions=e.versions.slice(0,data.retention.region_versions);pending.push(e.head,...e.versions);}
  try{pending.push(read(path.join(root,'current-region.json')).id);}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const filename of files('drafts')){const d=read(path.join(root,'drafts',filename));pending.push(d.base_region_id,d.preview_region_id);}
  for(const c of data.checkpoints)pending.push(c.region_id);
  const captureRoot=path.join(root,'captures');
  if(fs.existsSync(captureRoot))for(const entry of fs.readdirSync(captureRoot,{withFileTypes:true}))if(entry.isDirectory()&&valid(entry.name)){
   const file=path.join(captureRoot,entry.name,'capture.json');if(fs.existsSync(file))pending.push(read(file).region_id);
  }
  const previews=files('regions').map(n=>({name:n,record:read(path.join(root,'regions',n))})).filter(x=>(x.record.source==='design_draft'||x.record.transient)&&(!x.record.draft_id||fs.existsSync(path.join(root,'drafts',x.record.draft_id+'.json')))).sort((a,b)=>fs.statSync(path.join(root,'regions',b.name)).mtimeMs-fs.statSync(path.join(root,'regions',a.name)).mtimeMs);
  pending.push(...previews.slice(0,data.retention.preview_versions).map(x=>x.record.id));
  const snapshots=new Set();
  while(pending.length){const id=pending.pop();if(!id||keep.has(id))continue;const r=region(id);keep.add(id);snapshots.add(r.snapshot_id);if(r.base_region_id)pending.push(r.base_region_id);}
  const remove=[];
  for(const file of files('regions'))if(!keep.has(file.slice(0,-5)))remove.push(path.join(root,'regions',file));
  for(const file of files('snapshots'))if(!snapshots.has(file.slice(0,-5)))remove.push(path.join(root,'snapshots',file));
  // Reference discovery completes before any unlink. Draft bases, images and explicit checkpoints remain pinned.
  let bytes=0;for(const file of remove){bytes+=fs.statSync(file).size;fs.unlinkSync(file);}
  atomic(manifest,data);return {removed_files:remove.length,freed_bytes:bytes,...summary()};
 }
 return {initialize,decorate,resolve,entityFor,saveSnapshot,commit,savePreview,listRegions,revisions,checkpoint,saveWorkspace,archive,retention,cleanupAssets,summary,compact};
}
