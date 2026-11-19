import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {AsyncLocalStorage} from 'node:async_hooks';
import {PROJECT,ROOT} from './workspace-paths.mjs';
import {worldSource,saveWorldSource,relocateWorldSource,worldLinkForBackup} from './world-source.mjs';
import {backupProject,restoreProjectBackup} from './project-backup.mjs';
import {createProject,currentProject,listProjects,primaryRoot,primaryWorld,projectFor,projectLocations,renameProject} from './project-catalog.mjs';
import {writeVoidWorld} from './void-world.mjs';
import {planBounds,planningFocusY} from './planning-core.mjs';
import {savedDetailSnapshot,savedBlocks} from './render-context.mjs';
import {normalizeBlockState} from './block-states.mjs';
import {DESIGN_TOOLS,designService} from './design-service.mjs';
import {projectStore} from './project-store.mjs';
import {planningService,PLANNING_TOOLS} from './planning-service.mjs';
import {mapService,MAP_TOOLS} from './map-service.mjs';
import {worldIndex} from './world-surface.mjs';
import {readRenderSettings,saveRenderSettings} from './render-packs.mjs';
import {checkIrisSupport,nativeIrisSources,savedIrisInputs} from './iris-runtime.mjs';
import {ensureVanillaAssets} from './vanilla-assets.mjs';
import {snapshotDelta} from '../snapshot-delta.js';

export {PROJECT,ROOT};
const store=projectStore(ROOT);
const planning=planningService(ROOT,()=>store.listRegions(),()=>worldSource()?.world_uuid);
const invocation=new AsyncLocalStorage();
const metadataWrites=new Set([...PLANNING_TOOLS.filter(t=>!t.annotations?.readOnlyHint).map(t=>t.name),'save_map_view','save_workspace','update_draft','backup_project','relocate_world_source']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const valid=id=>typeof id==='string'&&/^[a-zA-Z0-9-]{1,99}$/.test(id);
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const pending=file+'.pending-'+randomUUID();fs.writeFileSync(pending,JSON.stringify(value),{flag:'wx'});fs.renameSync(pending,file);}
function folder(name){const p=path.join(ROOT,name);fs.mkdirSync(p,{recursive:true});return p;}
function publicRegion(r){const {diff,...rest}=r;return {...rest,...(diff?{changed_positions:diff.length}:{})};}
export function validateEdits(blocks,maximum=16384){
 if(!Array.isArray(blocks)||blocks.length>maximum)throw Error('Too many block edits');
 const seen=new Set();
 for(const b of blocks){if(!b||Object.keys(b).some(k=>!['x','y','z','state','before'].includes(k))||typeof b.state!=='string'||b.before!==undefined&&typeof b.before!=='string')throw Error('Invalid block edit');validateBounds([b.x,b.y,b.z,b.x,b.y,b.z]);const k=[b.x,b.y,b.z].join(',');if(seen.has(k))throw Error('Duplicate edit coordinate');seen.add(k);}
}
export function validateBounds(b){
 if(!Array.isArray(b)||b.length!==6||!b.every(Number.isSafeInteger))throw Error('Six integer bounds required');
 let n=1;for(let i=0;i<3;i++){if(b[i]>b[i+3])throw Error('Reversed bounds');n*=b[i+3]-b[i]+1;}
 if(b[1]<-64||b[4]>319||[b[0],b[2],b[3],b[5]].some(x=>Math.abs(x)>30000000)||n>147456)throw Error('Region exceeds world limits or 147456 positions');return n;
}
function inside(b,p){return p.every((v,i)=>v>=b[i]&&v<=b[i+3]);}
function region(id){
 if(id===undefined){const current=read(path.join(ROOT,'current-region.json'));id=current.id;}
 if(!valid(id))throw Error('Invalid region identity');return store.decorate(read(path.join(folder('regions'),store.resolve(id)+'.json')));
}
export function loadRegionData(id){
 const r=region(id);if(!valid(r.snapshot_id))throw Error('Invalid snapshot identity');const bytes=fs.readFileSync(path.join(folder('snapshots'),r.snapshot_id+'.json'));
 if(hash(bytes)!==r.snapshot_hash)throw Error('Saved region snapshot changed');
 const s=JSON.parse(bytes);validateBounds(r.bounds);if(!inside(s.bounds,r.bounds.slice(0,3))||!inside(s.bounds,r.bounds.slice(3)))throw Error('Selection outside snapshot');
 return {region:r,snapshot:s};
}
function desktopStatus(root=ROOT){
 let app=null;try{app=read(path.join(root,'heartbeat.json'));}catch{}
 let alive=false;if(app?.pid){try{process.kill(app.pid,0);alive=true;}catch{}}
 return {running:alive&&Date.now()-Number(app.at_ms)<10000,...(app?{pid:app.pid}:{})};
}
function workbenchStatus(){
 let current=null;try{current=region();}catch{}
 const state=planning.read(),selected=state.objects.find(p=>p.id===state.selected_id);return {desktop:desktopStatus(),source:worldSource(),planning_context:{world_uuid:state.world_uuid,revision:state.revision,selected_plan:selected??null,layer:selected?state.layers.find(l=>l.id===selected.layer_id):null},current_region:current?publicRegion(current):null};
}
async function ensureWorkbench(root){
 if(desktopStatus(root).running)return;
 const candidates=process.platform==='darwin'
  ? ['bin/织境工坊.app/Contents/MacOS/terraweave','bin/TerraWeave.app/Contents/MacOS/terraweave','native-build/release/terraweave','native-build/debug/terraweave']
  : ['织境工坊.exe','../织境工坊.exe','bin/TerraWeave.exe','native-build/debug/terraweave.exe'];
 const app=[process.env.TERRAWEAVE_DESKTOP_EXE,...candidates.map(file=>path.join(PROJECT,file))]
  .find(file=>file&&fs.existsSync(file));
 if(!app)throw Error('Build the desktop workbench first');
 fs.mkdirSync(root,{recursive:true});
 const env={...process.env,TERRAWEAVE_STATE:root,TERRAWEAVE_PRIMARY_STATE:primaryRoot,MAP_WORKBENCH_TEST_HIDDEN:'1'};
 if(primaryWorld)env.TERRAWEAVE_PRIMARY_WORLD=primaryWorld;
 if(root!==ROOT){
  delete env.TERRAWEAVE_WORLD;
  if(root===primaryRoot&&primaryWorld)env.TERRAWEAVE_WORLD=primaryWorld;
 }
 const log=fs.openSync(path.join(root,'desktop.log'),'a');
 try{
  const child=spawn(app,[],{cwd:PROJECT,env,stdio:['ignore',log,log],windowsHide:true,detached:true});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();
 }finally{fs.closeSync(log);}
 for(const deadline=Date.now()+60000;Date.now()<deadline;){await sleep(100);if(desktopStatus(root).running)return;}
 throw Error('工程窗口未能启动，请查看该工程的 desktop.log');
}
export async function desktopRequest(request,{start=true,timeout=120000,root=ROOT}={}){
 if(start)await ensureWorkbench(root);
 else if(!desktopStatus(root).running)return null;
 const id=Date.now()+'-'+randomUUID();
 const queued=path.join(root,'requests',id+'.json'),deadline=Date.now()+timeout;
 atomic(queued,{...request,id,expires_at_ms:deadline});
 if(request.kind==='show')fs.writeFileSync(path.join(root,'wake-window'),'');
 const response=path.join(root,'responses',id+'.json');
 while(Date.now()<deadline){
  if(fs.existsSync(response)){const r=read(response);fs.unlinkSync(response);if(!r.ok)throw Error(r.error??'Desktop operation failed');return {...r.result,desktop_acknowledged:true,request_id:id};}
  await sleep(25);
 }
 try{fs.unlinkSync(queued);}catch(error){if(error.code!=='ENOENT')throw error;}
 throw Error('桌面请求已超时 '+id);
}
function saveSnapshot(snapshot){return store.saveSnapshot(snapshot);}
async function displayRegion(r,kind='display',navigation_id,preparedSnapshot){
 const request={kind,region_id:r.id,snapshot_hash:r.snapshot_hash,navigation_id,view_metadata:{entity_id:r.entity_id,is_current_revision:r.is_current_revision,revision_count:r.revision_count,last_verified_at:r.last_verified_at}};
 let previous;
 if(kind==='display'&&r.transient){
  try{previous=region();}catch{}
 }
 let shortcut;
 if(previous?.snapshot_hash===r.snapshot_hash)shortcut={...request,kind:'display_cached'};
 else if(previous&&preparedSnapshot&&previous.world_uuid===r.world_uuid){
  let oldSnapshot;
  try{oldSnapshot=loadRegionData(previous.id).snapshot;}
  catch(error){if(error.code!=='ENOENT'&&error.message!=='Saved region snapshot changed')throw error;}
  const delta=snapshotDelta(oldSnapshot,preparedSnapshot);
  if(delta){
   const snapshot_delta={...delta,from_hash:previous.snapshot_hash};
   if(Buffer.byteLength(JSON.stringify(snapshot_delta))<=32000)shortcut={...request,kind:'display_delta',snapshot_delta};
  }
 }
 let ack;
 if(shortcut){
  try{ack=await desktopRequest(shortcut);}
  catch(error){
   // An already open desktop from before the update may not support this request.
   if(error.message!=='Error: 未知工作台请求')throw error;
  }
 }
 if(!ack||ack.cache_miss)ack=await desktopRequest(request);
 if(ack.cancelled)return ack;
 if(ack.snapshot_hash!==r.snapshot_hash||ack.region_id!==r.id)throw Error('Desktop acknowledged a different region');
 atomic(path.join(ROOT,'current-region.json'),{id:r.id});return {...publicRegion(r),...ack};
}
async function loadSaved(bounds,label='地图区域',selection=bounds,metadata={}){
 validateBounds(bounds);if(bounds.some((v,i)=>i<3&&bounds[i+3]-v>=128))throw Error('Preview spans at most 128 blocks along each axis');
 if(typeof label!=='string'||label.length>120)throw Error('Region label must be at most 120 characters');
 const snapshot=savedDetailSnapshot(bounds,worldIndex());
 const pins=saveSnapshot(snapshot),r={id:randomUUID(),label,notes:metadata.notes??'',bounds:selection,loaded_bounds:bounds,...pins,world:snapshot.world,world_uuid:snapshot.uuid,minecraft:snapshot.minecraft,source:snapshot.source,world_revision:snapshot.world_revision,environment_revision:snapshot.environment_revision,unknown_chunks:snapshot.unknown_chunks,block_entity_count:snapshot.block_entity_count,block_entity_positions:snapshot.block_entity_positions,captured_at:new Date().toISOString()};
 return displayRegion(store.commit(r,metadata.entity_id,true));
}
function entries(data,air=true){return Object.entries(data.snapshot.blocks).filter(([key,state])=>inside(data.region.bounds,key.split(',').map(Number))&&(air||!/^minecraft:(air|cave_air|void_air)$/.test(state)));}
function inspect(id){
 const d=loadRegionData(id),rows=entries(d),states={};for(const [,state]of rows)states[state]=(states[state]??0)+1;
 const tiles=d.region.source==='design_draft'?null:(d.region.block_entity_positions??d.snapshot.block_entity_positions)?.filter(p=>inside(d.region.bounds,p)).length??(JSON.stringify(d.region.bounds)===JSON.stringify(d.snapshot.bounds)?d.region.block_entity_count??d.snapshot.block_entity_count:null);
  return {region:publicRegion(d.region),positions:rows.length,expected_positions:validateBounds(d.region.bounds),non_air:rows.filter(([,s])=>!/^minecraft:(air|cave_air|void_air)$/.test(s)).length,block_states:states,block_entity_count:tiles,capture_scope:d.region.source==='design_draft'?'Saved design draft, not yet the live world. Images pin this exact draft snapshot.':d.region.source==='saved_anvil_detail'?'Exact block states from the last saved Anvil data. The test server was offline when this preview opened.':'Exact saved server block states at captured_at. Images use this same snapshot; entities, NBT, game lighting and unsupported models have separate limits.'};
}
const integer={type:'integer'},bounds={type:'array',items:integer,minItems:6,maxItems:6};
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const regionId={type:'string'};
export const TOOLS=[
 {name:'workspace_status',description:'Read project name, logical region items, content-addressed storage usage and retention settings.',inputSchema:schema({}),annotations:{readOnlyHint:true}},
 {name:'save_workspace',description:'Save project metadata and optional project name. Does not duplicate snapshots.',inputSchema:schema({label:{type:'string'}})},
 {name:'list_region_versions',description:'List retained internal versions for one logical region, separate from the region tree.',inputSchema:schema({region_id:regionId}) ,annotations:{readOnlyHint:true}},
 {name:'save_checkpoint',description:'Pin a meaningful region revision so automatic cache cleanup retains it.',inputSchema:schema({region_id:regionId,label:{type:'string'}})},
 {name:'compact_storage',description:'Reclaim old working snapshots and preview versions. Optional explicit cleanup can purge archived test objects, old capture batches, retired backups and obsolete imported fixtures.',inputSchema:schema({keep_versions:{type:'integer'},preview_versions:{type:'integer'},remove_backups:{type:'boolean'},remove_legacy_imports:{type:'boolean'},purge_archived:{type:'boolean'},remove_old_captures:{type:'boolean'}})},
 {name:'workbench_status',description:'Read desktop, configured save and planning status.',inputSchema:schema({}),annotations:{readOnlyHint:true}},
 {name:'show_workbench',description:'Show the existing workbench window, or start it once if absent.',inputSchema:schema({})},
 {name:'load_region',description:'Read exact saved Anvil block states for inclusive bounds, display them and save a marked region. Up to 147456 positions.',inputSchema:schema({bounds,label:{type:'string'}},['bounds'])},
 {name:'set_selection',description:'Mark inclusive bounds within a displayed snapshot and persist the region for discussion and screenshots.',inputSchema:schema({bounds,region_id:regionId,label:{type:'string'}},['bounds'])},
 {name:'list_regions',description:'List stable logical region items, not every internal refresh version.',inputSchema:schema({include_archived:{type:'boolean'}}),annotations:{readOnlyHint:true}},
 {name:'archive_region',description:'Archive or restore a region item without deleting its saved data.',inputSchema:schema({region_id:regionId,archived:{type:'boolean'}},['region_id'])},
 {name:'open_region',description:'Display an exact persisted marked region and its pinned snapshot.',inputSchema:schema({region_id:regionId},['region_id'])},
 {name:'refresh_region',description:'Read the marked region from the configured save again, retaining its bounds, title and planning notes.',inputSchema:schema({region_id:regionId})},
 {name:'update_region',description:'Save the region title and planning notes without changing its pinned block snapshot.',inputSchema:schema({region_id:regionId,label:{type:'string'},notes:{type:'string'}})},
 {name:'inspect_region',description:'Get exact marked-region identity, snapshot SHA256, bounds and material counts. Defaults to the user current saved region.',inputSchema:schema({region_id:regionId}),annotations:{readOnlyHint:true}},
 {name:'read_region_blocks',description:'Read exact saved block states and coordinates, including air by default. Report inspected pages, not an unperformed building review.',inputSchema:schema({region_id:regionId,offset:integer,limit:integer,include_air:{type:'boolean'}}),annotations:{readOnlyHint:true}},
 {name:'capture_views',description:'Return actual workbench PNG images from north/south/east/west/top/isometric views of a marked region, with world camera coordinates and snapshot hash. Supports Y cutaways, selection outline and custom cameras. These are rendered previews, not Minecraft-client screenshots.',inputSchema:schema({region_id:regionId,angles:{type:'array',items:{type:'string',enum:['north','south','east','west','top','isometric']}},width:integer,height:integer,min_y:integer,max_y:integer,show_selection:{type:'boolean'},views:{type:'array',items:schema({name:{type:'string'},position:{type:'array',items:{type:'number'},minItems:3,maxItems:3},target:{type:'array',items:{type:'number'},minItems:3,maxItems:3}},['name','position','target'])}})},
 {name:'list_captures',description:'List saved preview captures, region identities and view metadata.',inputSchema:schema({}),annotations:{readOnlyHint:true}},
 {name:'read_capture',description:'Return the actual PNG image content for a saved capture, checking the original image hashes.',inputSchema:schema({capture_id:{type:'string'}},['capture_id']),annotations:{readOnlyHint:true}},
 ...DESIGN_TOOLS,
 ...PLANNING_TOOLS,...MAP_TOOLS,
];
TOOLS.find(t=>t.name==='capture_views').inputSchema.properties.show_grid={type:'boolean'};
TOOLS.find(t=>t.name==='capture_views').inputSchema.properties.show_plans={type:'boolean'};
TOOLS.find(t=>t.name==='capture_views').inputSchema.properties.show_invisible={type:'boolean'};
TOOLS.find(t=>t.name==='capture_views').inputSchema.properties.display_mode={type:'string',enum:['scene','editor']};
function liveContext(r){return r.source==='design_draft'&&r.base_region_id?loadRegionData(r.base_region_id).region:r;}
function refreshTransient(r){
 const [minX,minY,minZ,maxX,maxY,maxZ]=r.loaded_bounds;
 const [x,y,z]=r.focus_position??[(minX+maxX)/2,Math.ceil((minY+maxY)/2),(minZ+maxZ)/2];
 return maps.browse({
  x:Math.floor(x),z:Math.floor(z),y,
  plan_id:r.detail_for_plan_id,view_id:r.view_id,label:r.label,keep_camera:true
 });
}
function readSavedPositions(uuid,keys){
 const world=worldIndex();
 if(world.world_uuid!==uuid)throw Error('草稿属于另一个存档');
 return savedBlocks(keys,world);
}
const designs=designService({folder,atomic,read,readRegion:loadRegionData,readRegionMetadata:region,currentRegion:()=>{try{return region();}catch{return null;}},saveSnapshot,savePreview:store.savePreview,displayRegion,readSavedPositions,normalizeState:normalizeBlockState,prepareBlockAssets:ensureVanillaAssets,validateBounds,validateEdits,planning,captureDetail:args=>maps.browse(args)});
const maps=mapService({root:ROOT,planning,desktopRequest,saveSnapshot,savePreview:store.savePreview,displayRegion});
TOOLS.push({name:'world_source',description:'Read the configured local Anvil save.',inputSchema:schema({}),annotations:{readOnlyHint:true}});
TOOLS.push(
 {name:'read_editor_state',description:'Read the workspace session and pending form edits.',inputSchema:schema({}),annotations:{readOnlyHint:true}},
 {name:'save_editor_state',description:'Store a recoverable workspace session separately from saved designs.',inputSchema:schema({state:{type:'object'}},['state'])}
);
TOOLS.push(
 {name:'list_projects',description:'List separate workbench projects and their running windows.',inputSchema:schema({}),annotations:{readOnlyHint:true}},
 {name:'create_project',description:'Create a separate project with a blank map, a void world, or a selected save.',inputSchema:schema({name:{type:'string'},type:{type:'string'},directory:{type:'string'}},['name','type'])},
 {name:'project_locations',description:'Read the project folder and its separately linked world folder.',inputSchema:schema({id:{type:'string'}},['id']),annotations:{readOnlyHint:true}},
 {name:'rename_project',description:'Rename a project while preserving its identity and data.',inputSchema:schema({id:{type:'string'},name:{type:'string'}},['id','name'])},
 {name:'open_project',description:'Show the desktop window for a project.',inputSchema:schema({id:{type:'string'}},['id'])}
);
TOOLS.push({name:'save_world_source',description:'Set the local read-only Anvil save directory for this project.',inputSchema:schema({directory:{type:'string'}},['directory'])});
TOOLS.push(
 {name:'backup_project',description:'Copy the current project to a verified backup folder.',inputSchema:schema({directory:{type:'string'}},['directory'])},
 {name:'restore_project_backup',description:'Restore a verified backup as an independent project.',inputSchema:schema({directory:{type:'string'}},['directory'])},
 {name:'relocate_world_source',description:'Reconnect the same world at a new path while preserving its existing project identity.',inputSchema:schema({directory:{type:'string'},confirm_legacy:{type:'boolean'}},['directory'])}
);
TOOLS.push({name:'create_void_world',description:'Create a local empty world for a project without a linked world, retaining its planning overlays.',inputSchema:schema({name:{type:'string'}},['name'])});
TOOLS.push({name:'ui_snapshot',description:'Read editor panels in one consistent lightweight response.',inputSchema:schema({}),annotations:{readOnlyHint:true}});
TOOLS.push({name:'render_settings',description:'List the offline workbench resource pack stack and available shader profiles.',inputSchema:schema({}),annotations:{readOnlyHint:true}});
TOOLS.push({name:'save_render_settings',description:'Set the workbench resource pack stack from low to high priority and choose an offline shader profile.',inputSchema:schema({pack_order:{type:'array',items:{type:'string'}},shader:{type:'string'}},['pack_order','shader'])});
TOOLS.push({name:'iris_pack_source',description:'Read shader programs after static compatibility checks.',inputSchema:schema({shader:{type:'string'}},['shader']),annotations:{readOnlyHint:true}});
TOOLS.push({name:'offline_iris_inputs',description:'Read a local Iris ZIP and saved-world light, weather and biome data for resident chunks.',inputSchema:schema({shader:{type:'string'},revision:regionId,environment_revision:regionId,chunk_positions:{type:'array',items:{type:'array',items:integer}}},['shader']),annotations:{readOnlyHint:true}});
TOOLS.push({name:'capture_current_view',description:'Capture exactly the current 3D viewport, including the saved-world background, live or draft window, materials and overlays. Preserve the current camera and document.',inputSchema:schema({width:{type:'integer'},height:{type:'integer'}})});
function captureRecord(id){if(!valid(id))throw Error('Invalid capture identity');const dir=path.join(folder('captures'),id),r=read(path.join(dir,'capture.json'));return {...r,capture_id:id,images:r.images.map((img,i)=>({...img,path:path.join(dir,'view-'+i+'.png')}))};}
function captureWithOwner(r){if(r.source==='minecraft_client_stream')return {...r,document_title:'客户端光影'};if(r.source==='workbench_composite_render'&&!r.region_id)return {...r,document_title:'当前完整实景'};if(['saved_anvil_volume_render','saved_anvil_textured_render'].includes(r.source))return {...r,document_title:'全景三维'};if(['saved_world_surface_and_planning','saved_world_slice_and_planning'].includes(r.source))return {...r,document_title:'地图总览'};let owner;try{owner=region(r.region_id);}catch{}return {...r,document_title:owner?.label,entity_id:owner?.entity_id};}
const needsVanilla = new Set(['load_region','open_region','browse_world','open_plan_detail','open_world_scene','capture_world_scene','capture_views','preview_draft','world_model_tile']);
const emptySceneTools = new Set(['browse_world','open_plan_detail','open_world_scene']);
async function projectWorlds(){
 const plan=fs.existsSync(path.join(ROOT,'planning.json'))?planning.read():null;
 return new Set([...store.listRegions(true).map(r=>r.world_uuid),
  ...(await designs.execute('list_drafts',{include_archived:true})).map(d=>d.world_uuid),
  ...(plan?.objects.length?[plan.world_uuid]:[])].filter(Boolean));
}
async function execute(name,args){
 if(name==='read_editor_state'){
  let state=null;
  try{state=read(path.join(ROOT,'editor-state.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
  return {key:hash(ROOT).slice(0,24),state};
 }
 if(name==='save_editor_state'){
  const state=args.state,file=path.join(ROOT,'editor-state.json');
  if(!state||state.version!==1||!Number.isSafeInteger(state.updated_at)||!Array.isArray(state.tabs)||
   !state.forms||typeof state.forms!=='object'||Array.isArray(state.forms)||
   state.tabs.length>100||Buffer.byteLength(JSON.stringify(state))>1_500_000)throw Error('工程会话数据无效或过大');
  if(fs.existsSync(file)&&read(file).updated_at>state.updated_at)return {saved:false};
  atomic(file,state);
  return {saved:true};
 }
 if(name==='list_projects')return listProjects(desktopStatus);
 if(name==='project_locations')return projectLocations(args.id);
 if(name==='rename_project')return renameProject(args.id,args.name);
 if(name==='create_project')return createProject(args);
 if(name==='open_project'){
  const project=projectFor(args.id);
  return {...await desktopRequest({kind:'show'},{root:project.root}),id:project.id,name:project.name};
 }
 if(needsVanilla.has(name)){
  const index=worldIndex();
  if(!(emptySceneTools.has(name)&&index.pristine_void))await ensureVanillaAssets(index.minecraft);
 }
 if(name==='world_source')return worldSource();
 if(name==='restore_project_backup')return restoreProjectBackup(args.directory);
 if(name==='backup_project'){
  let identity;
  if(worldSource()?.error){
   const worlds=await projectWorlds().catch(()=>new Set());
   if(worlds.size===1)[identity]=worlds;
  }
  return backupProject(currentProject(),args.directory,worldLinkForBackup(identity));
 }
 if(name==='relocate_world_source'){
  const worlds=await projectWorlds();
  if(worlds.size>1)throw Error('工程内有多个存档身份，请先拆分工程数据');
  const [identity]=worlds;
  return relocateWorldSource(args.directory,identity,args.confirm_legacy);
 }
 if(name==='save_world_source'){
  const worlds=await projectWorlds();
  if(worlds.size>1)throw Error('工程内有多个存档身份，请先拆分工程数据');
  return saveWorldSource(args.directory,[...worlds][0]);
 }
 if(name==='create_void_world'){
  const label=typeof args.name==='string'?args.name.trim():'';
  if(!label||label.length>64||/[\u0000-\u001f\u007f]/u.test(label))throw Error('世界名称须为 1 至 64 个字，且不能含控制符');
  const source=worldSource();
  if((source&&!source.error)||(await projectWorlds()).size)throw Error('当前工程已关联世界，原有世界不会被替换');
  const state=planning.read();
  const plan=state.objects.find(p=>p.id===state.selected_id)??state.objects[0];
  const bounds=plan?planBounds(plan):[0,0,0,0];
  const spawn=[Math.floor((bounds[0]+bounds[2])/2),Math.floor(plan?planningFocusY(plan)??64:64),Math.floor((bounds[1]+bounds[3])/2)];
  return {...saveWorldSource(writeVoidWorld(ROOT,label,spawn)),plan_id:plan?.id};
 }
 if(name==='render_settings'||name==='save_render_settings'){
  let minecraft;
  try{minecraft=worldIndex().minecraft;}catch{}
  const assets=path.join(PROJECT,'assets');
  return name==='render_settings'?readRenderSettings(assets,minecraft):saveRenderSettings(assets,args,minecraft);
 }
 if(name==='iris_pack_source'||name==='offline_iris_inputs'){
  const pack=nativeIrisSources(path.join(PROJECT,'assets'),args.shader,worldIndex().minecraft),issues=checkIrisSupport(pack);
  if(issues.length)throw Error(issues.join(' · '));
  return name==='iris_pack_source'?pack:{pack,world:savedIrisInputs(path.join(ROOT,'volume-cache'),args)};
 }
 if(name==='capture_current_view'){
  const width=args.width??1280,height=args.height??800;
  if(![width,height].every(n=>Number.isInteger(n)&&n>=256&&n<=1920))throw Error('Capture dimensions must be 256..1920');
  const r=await desktopRequest({kind:'capture_viewport',width,height});
  if(r.region_id&&loadRegionData(r.region_id).region.snapshot_hash!==r.snapshot_hash)throw Error('Viewport snapshot changed');
  const dir=path.dirname(r.images[0].path),geometry=JSON.stringify(r.scene_geometry),plans=JSON.stringify(r.planning_snapshot);
  fs.writeFileSync(path.join(dir,'scene-geometry.json'),geometry);fs.writeFileSync(path.join(dir,'planning.json'),plans);
  delete r.scene_geometry;delete r.planning_snapshot;r.scene_geometry_sha256=hash(geometry);r.planning_snapshot_hash=hash(plans);
  fs.writeFileSync(path.join(dir,'capture.json'),JSON.stringify(r));return r;
 }
 if(name==='ui_snapshot'){
  const {id,name:projectName}=currentProject();
  return {project:{id,name:projectName},backend_pid:process.pid,regions:store.listRegions(true).map(publicRegion),drafts:await designs.execute('list_drafts',{include_archived:true}),history:await designs.execute('list_history',{}),captures:await execute('list_captures',{}),status:workbenchStatus(),workspace:store.summary(),planning:planning.execute('planning_state',{})};
 }
 if(MAP_TOOLS.some(t=>t.name===name))return maps.execute(name,args);
 if(PLANNING_TOOLS.some(t=>t.name===name)){const result=planning.execute(name,args);if(name==='inspect_plan')result.designs=(await designs.execute('list_drafts',{})).filter(d=>d.plan_id===result.plan.id||!d.plan_id&&result.plan.detail_entity_id&&d.base_entity_id===result.plan.detail_entity_id);if(!PLANNING_TOOLS.find(t=>t.name===name).annotations?.readOnlyHint&&invocation.getStore()?.origin!=='desktop'){await desktopRequest({kind:'planning_update'});}return result;}
 if(name==='workspace_status')return store.summary();
 if(name==='save_workspace')return store.saveWorkspace(args.label);
 if(name==='compact_storage'){
  store.retention(args.keep_versions,args.preview_versions);const assets=args.purge_archived||args.remove_old_captures?store.cleanupAssets(args.purge_archived,args.remove_old_captures):{freed_bytes:0};const result=store.compact();result.freed_bytes+=assets.freed_bytes;if(assets.removed_assets)result.removed_assets=assets.removed_assets;
  if(args.remove_backups||args.remove_legacy_imports){const targets=[...(args.remove_backups?[path.join(PROJECT,'project-state/config-backups'),path.resolve(PROJECT,'../../.codex-tmp/terraweave-before-editor-workspace'),path.resolve(PROJECT,'../../.codex-tmp/terraweave-retired-binaries'),'D:\\Temp\\TerraWeave-retired-20261117']:[]),...(args.remove_legacy_imports?[path.join(PROJECT,'project-state/imported'),path.join(PROJECT,'project-state/designs')]:[])];const removed=[];let bytes=0;
   if(args.remove_backups)targets.push(path.resolve(PROJECT,'../../.codex-tmp/terraweave-before-map-workflow'));
   const size=p=>fs.lstatSync(p).isSymbolicLink()?0:fs.statSync(p).isDirectory()?fs.readdirSync(p).reduce((n,f)=>n+size(path.join(p,f)),0):fs.statSync(p).size;
   for(const target of targets)if(fs.existsSync(target)){const resolved=fs.realpathSync.native(target);if(path.resolve(resolved).toLowerCase()!==path.resolve(target).toLowerCase())throw Error('Refusing redirected backup cleanup target');bytes+=size(resolved);fs.rmSync(resolved,{recursive:true,force:true});removed.push(resolved);}
   result.removed_backups=removed;result.freed_bytes+=bytes;
  }
  return result;
 }
 if(name==='save_checkpoint'){const r=region(args.region_id);return store.checkpoint(r.id,args.label);}
 if(name==='list_region_versions'){const r=region(args.region_id);return store.revisions(r.id).map(publicRegion);}
 if(DESIGN_TOOLS.some(t=>t.name===name)){
  const result=await designs.execute(name,args);
  if(name==='delete_draft'){
   try{await desktopRequest({kind:'draft_deleted',draft_id:result.id},{start:false,timeout:3000});}
   catch(error){result.desktop_sync_error=error.message;}
  }else if(name==='update_draft'&&args.visible!==undefined&&invocation.getStore()?.origin!=='desktop'){
   await desktopRequest({kind:'planning_update'});
  }
  return result;
 }
 if(name==='workbench_status')return workbenchStatus();
 if(name==='show_workbench')return desktopRequest({kind:'show'});
 if(name==='load_region')return loadSaved(args.bounds,args.label);
 if(name==='list_regions')return store.listRegions(args.include_archived).map(publicRegion);
 if(name==='archive_region')return store.archive(args.region_id,args.archived??true);
 if(name==='open_region')return displayRegion(loadRegionData(args.region_id).region);
 if(name==='refresh_region'){const r=liveContext(loadRegionData(args.region_id).region);if(r.transient)return refreshTransient(r);return loadSaved(r.loaded_bounds,r.label,r.bounds,{notes:r.notes,entity_id:r.entity_id});}
 if(name==='update_region'){
  const old=loadRegionData(args.region_id).region,label=args.label??old.label,notes=args.notes??old.notes??'';
  if(typeof label!=='string'||!label.trim()||label.length>120||typeof notes!=='string'||notes.length>10000)throw Error('Invalid region title or planning notes');
  const r={...old,id:randomUUID(),label,notes,updated_at:new Date().toISOString()};return displayRegion(r.source==='design_draft'?store.savePreview(r):store.commit(r,old.entity_id),'select');
 }
 if(name==='set_selection'){
  const old=loadRegionData(args.region_id);validateBounds(args.bounds);
  if(!inside(old.snapshot.bounds,args.bounds.slice(0,3))||!inside(old.snapshot.bounds,args.bounds.slice(3)))throw Error('Selection outside displayed snapshot');
  const r={...old.region,id:randomUUID(),label:args.label??old.region.label,bounds:args.bounds};return displayRegion(r.source==='design_draft'?store.savePreview(r):store.commit(r,old.region.entity_id),'select');
 }
 if(name==='inspect_region')return inspect(args.region_id);
 if(name==='read_region_blocks'){
  const d=loadRegionData(args.region_id),offset=args.offset??0,limit=args.limit??256;
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>512||args.include_air!==undefined&&typeof args.include_air!=='boolean')throw Error('Invalid block page');
  const rows=entries(d,args.include_air??true);if(offset>rows.length)throw Error('Offset exceeds position count');
  return {region:publicRegion(d.region),total:rows.length,offset,next_offset:offset+limit<rows.length?offset+limit:null,blocks:rows.slice(offset,offset+limit).map(([k,state])=>({coordinate:k.split(',').map(Number),state}))};
 }
 if(name==='capture_views'){
  const r=loadRegionData(args.region_id).region,width=args.width??1024,height=args.height??768;
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<256||height<256||width>1920||height>1920)throw Error('Capture dimensions must be integers from 256 to 1920');
  const angles=args.angles??['north','south','east','west','top','isometric'];
  if(!Array.isArray(angles)||angles.length>6||angles.some(a=>!['north','south','east','west','top','isometric'].includes(a)))throw Error('Invalid capture angles');
  const views=args.views??[];if(!Array.isArray(views)||views.length>8||views.some(v=>!v||typeof v.name!=='string'||v.name.length>80||['position','target'].some(k=>!Array.isArray(v[k])||v[k].length!==3||!v[k].every(Number.isFinite))))throw Error('Invalid custom cameras');
  if(!(views.length||angles.length))throw Error('At least one view required');
  for(const key of ['min_y','max_y'])if(args[key]!==undefined&&(!Number.isSafeInteger(args[key])||args[key]<r.loaded_bounds[1]||args[key]>r.loaded_bounds[4]))throw Error('Cutaway is outside loaded height');
  if(args.min_y!==undefined&&args.max_y!==undefined&&args.min_y>args.max_y)throw Error('Reversed cutaway');
  if(args.show_selection!==undefined&&typeof args.show_selection!=='boolean')throw Error('show_selection must be true or false');
  const display_mode=args.display_mode??(r.preview_mode==='diff'?'editor':'scene');if(!['scene','editor'].includes(display_mode))throw Error('Unknown scene display mode');
  let planningSnapshot;if(args.show_plans){planningSnapshot=planning.publicState(planning.read());await desktopRequest({kind:'planning_update'});}
  const result=await desktopRequest({kind:'capture',region_id:r.id,snapshot_hash:r.snapshot_hash,view_metadata:{entity_id:r.entity_id,is_current_revision:r.is_current_revision,revision_count:r.revision_count,last_verified_at:r.last_verified_at},width,height,angles:views.length?[]:angles,views,min_y:args.min_y??r.loaded_bounds[1],max_y:args.max_y??r.loaded_bounds[4],show_selection:args.show_selection??true,show_grid:args.show_grid??false,show_plans:args.show_plans??false,show_invisible:args.show_invisible??false,display_mode});
  if(result.region_id!==r.id||result.snapshot_hash!==r.snapshot_hash)throw Error('Capture belongs to a different region');if(planningSnapshot){if(result.planning_revision!==planningSnapshot.revision)throw Error('3D planning overlay revision mismatch');const folder=path.dirname(result.images[0].path),bytes=JSON.stringify(planningSnapshot);fs.writeFileSync(path.join(folder,'planning.json'),bytes);result.planning_snapshot_hash=hash(bytes);fs.writeFileSync(path.join(folder,'capture.json'),JSON.stringify(result));}return result;
 }
 if(name==='list_captures')return fs.readdirSync(folder('captures'),{withFileTypes:true}).filter(e=>e.isDirectory()&&fs.existsSync(path.join(ROOT,'captures',e.name,'capture.json'))).map(e=>captureWithOwner(captureRecord(e.name))).reverse().slice(0,50);
 if(name==='read_capture'){const r=captureRecord(args.capture_id);for(const img of r.images)if(hash(fs.readFileSync(img.path))!==img.sha256)throw Error('Saved capture image changed');return r;}
 throw Error('Unknown workbench tool');
}
export async function callTool(name,args={},context={}){return invocation.run(context,()=>invokeTool(name,args));}
async function invokeTool(name,args={}){
 const tool=TOOLS.find(t=>t.name===name);if(!tool)throw Error('Unknown workbench tool');
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!(k in tool.inputSchema.properties)))throw Error('Invalid tool arguments');
 for(const key of tool.inputSchema.required)if(!(key in args))throw Error('Missing '+key);
 for(const key of ['archived','include_archived','visible','refresh','keep_camera','allow_saved','forget_history','remove_backups','remove_legacy_imports','purge_archived','remove_old_captures','show_grid','show_plans','show_invisible','show_selection','reset'])if(args[key]!==undefined&&typeof args[key]!=='boolean')throw Error(key+' must be a boolean');
 if(args.navigation_id!==undefined&&!valid(args.navigation_id))throw Error('Invalid navigation ID');
 if(args.physics!==undefined&&typeof args.physics!=='boolean')throw Error('Physics must be true or false');
 if(name==='load_region'){validateBounds(args.bounds);if(args.bounds.some((v,i)=>i<3&&args.bounds[i+3]-v>=128))throw Error('Preview spans at most 128 blocks along each axis');}
 if(tool.annotations?.readOnlyHint)return execute(name,args);
 if(['create_project','open_project','rename_project','save_editor_state','restore_project_backup'].includes(name))return execute(name,args);
 fs.mkdirSync(ROOT,{recursive:true});const lock=path.join(ROOT,'operation.lock');let fd;
 const deadline=Date.now()+170000;
 while(fd===undefined){try{fd=fs.openSync(lock,'wx');}catch(error){if(error.code!=='EEXIST')throw error;let owner;try{owner=fs.readFileSync(lock,'utf8');}catch{}if(/^\d+$/.test(owner??'')){let alive=true;try{process.kill(Number(owner),0);}catch(e){if(e.code==='ESRCH')alive=false;}if(!alive){try{if(fs.readFileSync(lock,'utf8')===owner)fs.unlinkSync(lock);}catch{}continue;}}if(Date.now()>deadline)throw Error('工作台操作仍未结束，请稍后重试');await sleep(100);}}
 try{fs.writeSync(fd,String(process.pid));store.initialize();const result=await execute(name,args);if(!metadataWrites.has(name))try{store.compact();}catch(e){if(result&&!Array.isArray(result))result.storage_warning=e.message;}return result;}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
async function handle(q){
 if(q.id===undefined)return null;const ok=result=>({jsonrpc:'2.0',id:q.id,result});
 if(q.method==='initialize')return ok({protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'TerraWeave',version:'0.7.2'},instructions:'TerraWeave offline map planning and saved-world preview. Use export_draft to hand off an immutable revision to the separate world writer MCP. open_world_scene renders complete block models and textures with a free camera; do not replace visible scenery with colored voxels. get_scene_view reads the actual user camera. capture_world_scene defaults to that observed view and freezes block states, model geometry and texture atlas; explicit angles/custom cameras remain available. inspect_captured_scene verifies its exact source. show_invisible reveals barrier glyphs without changing world blocks. planning_state and inspect_plan provide selected map geometry and notes; save_plan supports areas/routes/markers independent of chunk size. Hide/show is separate from deletion. capture_map freezes map planning geometry. browse_world/open_plan_detail enter a saved-world detail view; create_draft with plan_id supports sparse world-scale designs. capture_views supports precise cameras and cutaways. Distinguish saved-world renders, live blocks, planning and drafts; workbench lighting/animation differs from Minecraft-client screenshots. Repeated navigation reuses bounded caches.'});
 if(q.method==='ping')return ok({});if(q.method==='tools/list')return ok({tools:TOOLS});
 if(q.method==='tools/call')try{
  const r=await callTool(q.params.name,q.params.arguments??{}),content=[{type:'text',text:JSON.stringify(r)}];
  if(['capture_views','read_capture','capture_map','capture_world_scene','capture_current_view'].includes(q.params.name))for(const img of r.images)content.push({type:'image',mimeType:'image/png',data:fs.readFileSync(img.path).toString('base64')});
  return ok({content,isError:false});
 }catch(e){return ok({content:[{type:'text',text:JSON.stringify({error:e.message})}],isError:true});}
 return {jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'Method not found'}};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 if(process.argv[2]==='--stdio'){
  let pending='',chain=Promise.resolve();process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{pending+=chunk;if(pending.length>4*1024*1024){process.stdin.destroy();process.exitCode=1;return;}let n;while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);if(!line.trim())continue;chain=chain.then(async()=>{try{const r=await handle(JSON.parse(line));if(r)process.stdout.write(JSON.stringify(r)+'\n');}catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}})+'\n');}});}});
 }else{
  try{let q;if(process.argv[2]==='--json'){let input='';process.stdin.setEncoding('utf8');for await(const chunk of process.stdin)input+=chunk;q=JSON.parse(input);}else q={tool:process.argv[2]??'workbench_status',args:JSON.parse(process.argv[3]??'{}')};process.stdout.write(JSON.stringify(await callTool(q.tool,q.args??{}))+'\n');}catch(e){process.stdout.write(JSON.stringify({error:e.message})+'\n');process.exitCode=1;}
 }
}
