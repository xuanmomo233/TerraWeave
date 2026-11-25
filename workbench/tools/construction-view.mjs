import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {worldSource} from './world-source.mjs';
import {readGeneratedConstruction} from './generated-construction.mjs';

const id=/^[a-zA-Z0-9-]{1,99}$/;
const operation=/^[0-9a-f-]{36}\.json$/;
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const optional=file=>{try{return read(file);}catch(error){if(error.code!=='ENOENT')throw error;}};
const files=dir=>{try{return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isFile()).map(e=>e.name).sort();}catch(error){if(error.code==='ENOENT')return [];throw error;}};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tileOf=(x,z)=>Math.floor(x/32)+','+Math.floor(z/32);

function atomic(file,value){
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const temp=file+'.pending-'+randomUUID();
 fs.writeFileSync(temp,JSON.stringify(value),{flag:'wx'});
 try{fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}

export function registerConstructionSource(exportPath,design,directory){
 const exports=path.dirname(exportPath),root=path.dirname(exports);
 if(path.basename(exports)!=='exports'||!id.test(design?.draft_id??''))return;
 const draft=optional(path.join(root,'drafts',design.draft_id+'.json'));
 if(!draft||!(design.plan_id??draft.plan_id))return;
 if(draft.world_uuid!==design.world_uuid){
  const source=worldSource(root,null);
  if(source?.world_uuid!==draft.world_uuid||source?.paper_world_uuid!==design.world_uuid)return;
 }
 const src=fs.realpathSync(directory);
 atomic(path.join(root,'construction-sources',hash(src)+'.json'),{directory:src});
}

function sources(root){
 const links=path.join(root,'construction-sources');
 const directories=new Set([path.join(root,'authoring','writer-state')]);
 for(const name of files(links))if(/^[0-9a-f]{64}\.json$/.test(name)){
  const record=optional(path.join(links,name));
  if(record?.directory&&path.isAbsolute(record.directory))directories.add(record.directory);
 }
 return [...directories].flatMap(directory=>files(directory).filter(name=>operation.test(name)).map(name=>{
  const file=path.join(directory,name),stat=fs.statSync(file,{throwIfNoEntry:false});
  return {directory,file,mtime:stat?.mtimeMs,size:stat?.size};
 })).filter(entry=>entry.size!==undefined);
}

function legacyOwners(root){
 const owners=new Map();
 for(const name of ['construction.json','expanded-construction.json']){
  const data=optional(path.join(root,'authoring',name));
  for(const part of Object.values(data?.parts??{}))
   if(part.draft_id&&part.plan_id)owners.set(part.draft_id,part.plan_id);
 }
 return owners;
}

export function effectiveConstructionState(actual,history,hidden,base=state=>state){
 if(!history)return base(actual);
 if(actual!==history[1])return actual;
 for(let i=history.length-2;i>=2;i-=2)if(!hidden.has(history[i]))return history[i+1];
 return base(history[0]);
}

function appendChange(previous,change,record,plan){
 const history=previous?.[1]===change.before?previous:[change.before,change.before];
 if(record.kind==='undo'){
  const last=history.length-3;
  if(last>=2&&history[last]===record.parent&&(last===2?history[0]:history[last-1])===change.after){
   history.splice(last,3);
   history[1]=change.after;
   return history;
  }
  return [change.after,change.after];
 }
 history[1]=change.after;
 history.push(record.parent??record.id,plan,change.after);
 return history;
}

function compactHistory(history){
 const result=[history[0],history[1]];
 for(let i=2;i<history.length;i+=3)result.push(history[i+1],history[i+2]);
 return result;
}

const cachedManifests=new Map(),cachedViews=new Map();
function constructionIndex(root,worldUuid,paperWorldUuid){
 const receipts=sources(root);
 if(!receipts.length)return null;
 const owners=legacyOwners(root);
 const idPart=path.join(root,'drafts');
 const worlds=paperWorldUuid?[worldUuid,paperWorldUuid]:worldUuid;
 const revision=hash([2,worlds,receipts.map(r=>[r.file,r.mtime,r.size]),[...owners]]);
 const active=cachedManifests.get(root);
 if(active?.revision===revision)return active;
 const directory=path.join(root,'construction-cache',revision),manifestFile=path.join(directory,'index.json');
 const existing=optional(manifestFile);
 if(existing){
  const result={...existing,revision,directory};
  cachedManifests.set(root,result);return result;
 }

 const coords=new Map(),seen=new Set(),draftPlans=new Map();
 const catalogs=Map.groupBy(receipts,r=>r.directory);
 const sequences=[...catalogs.values()].map(entries=>entries.map(({file,mtime})=>({data:optional(file),mtime}))
  .filter(r=>r.data&&(r.data.world_uuid===worldUuid||paperWorldUuid&&r.data.world_uuid===paperWorldUuid)&&Array.isArray(r.data.batches))
  .sort((a,b)=>a.data.order-b.data.order));
 const next=sequences.map(()=>0);
 // Preserve each writer's committed order, even when more than one catalog is linked.
 for(;;){
  let best=-1;
  for(let i=0;i<sequences.length;i++)if(next[i]<sequences[i].length&&(best<0||sequences[i][next[i]].mtime<sequences[best][next[best]].mtime))best=i;
  if(best<0)break;
  const {data:record}=sequences[best][next[best]++];
  if(seen.has(record.id))continue;
  seen.add(record.id);
  if(!['apply','undo','redo'].includes(record.kind)||!id.test(record.draft_id??''))continue;
  if(!draftPlans.has(record.draft_id))draftPlans.set(record.draft_id,optional(path.join(idPart,record.draft_id+'.json'))?.plan_id??owners.get(record.draft_id));
  const plan=record.plan_id??draftPlans.get(record.draft_id)??null;
  for(const batch of record.batches)for(const change of batch.changes??[]){
   const {x,y,z,before,after}=change;
   if(![x,y,z].every(Number.isSafeInteger)||y< -64||y>319||Math.abs(x)>30000000||Math.abs(z)>30000000||
      typeof before!=='string'||typeof after!=='string'||before===after)continue;
   const key=x+','+y+','+z;
   coords.set(key,appendChange(coords.get(key),change,record,plan));
  }
 }
 const tiles=new Map(),planTiles=Object.create(null),modelTiles=Object.create(null);
 for(const [key,full] of coords){
  const history=compactHistory(full);
  if(!history.some((value,i)=>i>=2&&i%2===0&&value))continue;
  const position=key.split(',').map(Number),tile=tileOf(position[0],position[2]);
  if(!tiles.has(tile))tiles.set(tile,[]);
  tiles.get(tile).push([...position,history]);
  for(let i=2;i<history.length;i+=2)if(history[i]){
   (planTiles[history[i]]??=new Set()).add(tile);
   const affected=modelTiles[history[i]]??=new Set();
   const [x,,z]=position;
   // Face occlusion and fluid corners sample one block beyond the tile boundary.
   for(let tz=Math.floor((z-1)/32);tz<=Math.floor((z+1)/32);tz++)
    for(let tx=Math.floor((x-1)/32);tx<=Math.floor((x+1)/32);tx++)affected.add(tx+','+tz);
  }
 }
 for(const [tile,rows] of tiles)atomic(path.join(directory,tile+'.json'),rows);
 const lists=sets=>Object.fromEntries(Object.entries(sets).map(([plan,keys])=>[plan,[...keys].sort()]));
 const manifest={plan_tiles:lists(planTiles),model_tiles:lists(modelTiles),tiles:[...tiles.keys()]};
 atomic(manifestFile,manifest);
 const result={...manifest,revision,directory};cachedManifests.set(root,result);return result;
}

export function constructionView(root,worldUuid,planning,paperWorldUuid){
 const hiddenIds=planning.objects.filter(p=>p.visible===false||planning.layers.find(l=>l.id===p.layer_id)?.visible===false)
  .map(p=>p.id).sort();
 if(!hiddenIds.length)return null;
 const index=constructionIndex(root,worldUuid,paperWorldUuid);
 const source=readGeneratedConstruction(root,worldUuid);
 const hidden=new Set(hiddenIds.filter(plan=>Object.hasOwn(index?.plan_tiles??{},plan)||source?.planTiles.has(plan)));
 if(!hidden.size)return null;
 const revisions=[index?.revision,source?.revision],visibility_revision=hash([...revisions,[...hidden]]);
 if(cachedViews.get(root)?.visibility_revision===visibility_revision)return cachedViews.get(root);
 const generated=source?.project(hidden);
 const affected=new Map(),mapTiles=new Map(),exact=new Set(),loaded=new Map(),columns=new Map(),emptyColumn=new Map();
 const add=(tiles,key,plan)=>{
  if(!tiles.has(key))tiles.set(key,new Set());
  tiles.get(key).add(plan);
 };
 for(const plan of hidden){
  for(const key of index?.model_tiles[plan]??[])add(affected,key,plan);
  const generatedTiles=source?.planTiles.get(plan)??[];
  for(const key of generatedTiles){
   const [x,z]=key.split(',').map(Number);
   for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++)add(affected,(x+dx)+','+(z+dz),plan);
  }
  for(const key of new Set([...(index?.plan_tiles[plan]??[]),...generatedTiles])){
   exact.add(key);
   const [x,z]=key.split(',').map(Number);
   for(let level=0;level<=10;level++){
    const span=2**(level+1);
    add(mapTiles,level+':'+Math.floor(x/span)+','+Math.floor(z/span),plan);
   }
  }
 }
 const signatures=tiles=>Object.fromEntries([...tiles].map(([key,plans])=>[key,hash([...revisions,[...plans]])]));
 const visibility_tiles=signatures(affected),visibility_map_tiles=signatures(mapTiles);
 const tileRows=(x,z)=>{
  const key=tileOf(x,z);
  if(!index||!exact.has(key))return [];
  if(!loaded.has(key))loaded.set(key,optional(path.join(index.directory,key+'.json'))??[]);
  return loaded.get(key);
 };
 function column(x,z){
  const tile=tileOf(x,z);
  if(!exact.has(tile))return;
  if(!columns.has(tile)){
   const byColumn=new Map();
   for(const [px,y,pz,history] of tileRows(x,z)){
    const key=px+','+pz;
    if(!byColumn.has(key))byColumn.set(key,new Map());
    byColumn.get(key).set(y,history);
   }
   columns.set(tile,byColumn);
  }
  return columns.get(tile).get(x+','+z)??(generated?.affected.has(tile)?emptyColumn:undefined);
 }
 const resolve=(x,y,z,actual,history)=>effectiveConstructionState(actual,history,hidden,
  generated?state=>generated.block(x,y,z,state):undefined);
 const result={visibility_revision,visibility_tiles,visibility_map_tiles,generated,
  mapTileKey:(x,z,level)=>visibility_map_tiles[level+':'+x+','+z]??'',
  tileKey:(x,z)=>visibility_tiles[x+','+z]??'',exactChunks:[...exact].flatMap(key=>{
   const [x,z]=key.split(',').map(Number);
   return [[x*2,z*2],[x*2+1,z*2],[x*2,z*2+1],[x*2+1,z*2+1]];
  }),
  column,block:(x,y,z,actual)=>resolve(x,y,z,actual,column(x,z)?.get(y)),
  chunk(cx,cz){
   return tileRows(cx*16,cz*16).filter(([x,,z])=>Math.floor(x/16)===cx&&Math.floor(z/16)===cz)
    .map(([x,y,z,history])=>[x,y,z,actual=>resolve(x,y,z,actual,history)]);
  }
 };
 cachedViews.set(root,result);
 return result;
}
