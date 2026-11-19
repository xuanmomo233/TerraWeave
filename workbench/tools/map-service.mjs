import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {worldIndex,surfaceTile,sampleSurface,savedWorldCamera} from './world-surface.mjs';
import {planBounds,planningFocusY} from './planning-core.mjs';
import {cachedVolumeSceneInfo,volumeSceneInfo,volumeTile} from './world-volume.mjs';
import {modelTile} from './world-models.mjs';
import {savedDetailSnapshot} from './render-context.mjs';

const n={type:'number'},i={type:'integer'},id={type:'string'},schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const camera=schema({x:n,z:n,scale:n,rotation:n,slice_y:{type:['integer','null']}},['x','z','scale','rotation']);
export const MAP_TOOLS=[
 {name:'world_map_info',description:'Read generated world extent and terrain source for the whole map, independent of local block windows.',inputSchema:schema({}),annotations:{readOnlyHint:true}},
 {name:'world_map_tile',description:'Read a saved-world surface tile or an exact horizontal Y slice. Missing terrain is explicit.',inputSchema:schema({x:i,z:i,level:i,slice_y:i},['x','z','level']),annotations:{readOnlyHint:true}},
 {name:'world_surface_at',description:'Read the actual saved top block and height at a world X/Z coordinate.',inputSchema:schema({x:i,z:i},['x','z']),annotations:{readOnlyHint:true}},
 {name:'world_scene_info',description:'Read the whole-world volumetric extent and source revision. Preview mode uses chunk headers to start rendering large saves without a full scan.',inputSchema:schema({preview:{type:'boolean'}}),annotations:{readOnlyHint:true}},
 {name:'get_scene_view',description:'Read the actual current camera position, viewing direction, navigation mode and source identity shown to the user.',inputSchema:schema({}),annotations:{readOnlyHint:true}},
 {name:'world_model_tile',description:'Read complete saved block states and exposed faces for rendering their actual Minecraft models and textures; no LOD replacement.',inputSchema:schema({x:i,z:i,world_revision:id},['x','z']),annotations:{readOnlyHint:true}},
 {name:'world_volume_tile',description:'Read a bounded 3D voxel LOD mesh containing exterior, side and underside faces, without generating world chunks.',inputSchema:schema({x:i,z:i,level:i,world_revision:id},['x','z','level']),annotations:{readOnlyHint:true}},
 {name:'open_world_scene',description:'Open the saved world with complete Minecraft block models and textures and a freely movable camera. Visible scenery is not replaced with coarse voxels.',inputSchema:schema({refresh:{type:'boolean'},view_id:id,label:id})},
 {name:'capture_world_scene',description:'Return panoramic 3D PNGs and freeze rendered volumetric mesh, world cameras and planning revision. Not a Minecraft-client screenshot.',inputSchema:schema({width:i,height:i,angles:{type:'array',items:{type:'string'}},views:{type:'array',items:schema({name:id,position:{type:'array',items:n},target:{type:'array',items:n}},['name','position','target'])},plan_id:id,show_plans:{type:'boolean'},show_invisible:{type:'boolean'}})},
 {name:'open_map',description:'Open the complete world planning overview with rotation, layers and map-scale objects.',inputSchema:schema({refresh:{type:'boolean'}})},
 {name:'save_map_view',description:'Remember map center, zoom and arbitrary rotation. Reuses one view-settings file.',inputSchema:schema({view:camera},['view'])},
 {name:'browse_world',description:'Read a local 3D window at a world position from the configured save.',inputSchema:schema({x:i,z:i,y:n,plan_id:id,keep_camera:{type:'boolean'},allow_saved:{type:'boolean'},navigation_id:id,view_id:id,label:id},['x','z'])},
 {name:'open_plan_detail',description:'Enter saved-world 3D at a selected planning object.',inputSchema:schema({plan_id:id,allow_saved:{type:'boolean'},navigation_id:id,view_id:id,y:n},['plan_id'])},
 {name:'capture_map',description:'Return a real PNG of the world overview and visible planning layers at an exact center/scale/rotation. Pins the planning revision and records terrain tile revisions.',inputSchema:schema({view:camera,plan_id:id,width:i,height:i})},
 {name:'inspect_captured_plans',description:'Read the exact saved planning geometry associated with a map image, even after subsequent planning edits.',inputSchema:schema({capture_id:id,plan_id:id},['capture_id']),annotations:{readOnlyHint:true}},
 {name:'inspect_captured_scene',description:'Verify a panoramic PNG capture\'s frozen volumetric geometry and list its exact tile bounds, LODs and revisions.',inputSchema:schema({capture_id:id},['capture_id']),annotations:{readOnlyHint:true}},
];
export function mapService(ctx){
 const {root,planning,desktopRequest,saveSnapshot,savePreview,displayRegion}=ctx;
 const viewFile=path.join(root,'map-view.json');
 const info=()=>{const index=worldIndex();const {regions,chunks,directory,...publicIndex}=index;let view=null;try{view=JSON.parse(fs.readFileSync(viewFile,'utf8'));}catch{}return {...publicIndex,view};};
 function sceneInfo(index=worldIndex(),preview=false){
  const volumeCache=path.join(root,'volume-cache');
  const common={environment_revision:index.environment_revision,representation:'minecraft_block_models',
   limits:'Actual saved block states and textures; lighting, animation, entities and some block entities have separate limitations.'};
  const progressive_loading=preview&&index.chunk_count>256;
  const cached=progressive_loading?cachedVolumeSceneInfo(volumeCache,index):null;
  if(progressive_loading&&!cached){
   const [x,z,maxX,maxZ]=index.bounds;
   return {...common,world:index.world,world_uuid:index.world_uuid,revision:index.revision,
    bounds:[x,-64,z,maxX,319,maxZ],generated_bounds:index.bounds,chunk_count:index.chunk_count,
    occupied_chunks:index.chunks,helper_chunks:[],preview_index:true,progressive_loading,source:'saved_anvil_volume'};
  }
  const data=cached??volumeSceneInfo(volumeCache,index);
  return {...data,...common,progressive_loading,unreadable_chunks:undefined,unreadable_chunk_count:data.unreadable_chunks.length};
 }
 function validateView(view){
  if(!view||!['x','z','scale','rotation'].every(k=>Number.isFinite(view[k]))||view.scale<.025||view.scale>2048||Math.abs(view.x)>30000000||Math.abs(view.z)>30000000)throw Error('Invalid map view');
  if(view.slice_y!=null&&(!Number.isInteger(view.slice_y)||view.slice_y< -64||view.slice_y>319))throw Error('地图切片高度须在 Y -64 至 319 内');
  return {...view,rotation:(view.rotation%360+360)%360};
 }
 function sceneTab(args){
  const {view_id,label}=args;
  if(view_id!==undefined&&(typeof view_id!=='string'||!/^[a-zA-Z0-9-]{1,64}$/.test(view_id)))throw Error('无效的三维视图标识');
  if(label!==undefined&&(typeof label!=='string'||!label.trim()||label.length>120))throw Error('无效的三维视图名称');
  return {view_id,label};
 }
 async function browse(args){
  const {x,z}=args;if(!Number.isSafeInteger(x)||!Number.isSafeInteger(z)||Math.abs(x)>30000000||Math.abs(z)>30000000)throw Error('Invalid world position');
  const tab=sceneTab(args);
  if(args.y!==undefined&&(!Number.isFinite(args.y)||args.y< -64||args.y>319))throw Error('三维取点高度须在 Y -64 至 319 内');
  const index=worldIndex(),cx=Math.floor(x/16),cz=Math.floor(z/16),region=index.regions.find(r=>r.x===Math.floor(cx/32)&&r.z===Math.floor(cz/32));if(!region&&!index.void_world)throw Error('该位置尚无已保存地形；可以规划，但不能把未知数据当实况预览');
  const surface=sampleSurface(x,z,true,index.directory,index.void_world);if(!surface)throw Error('该位置的方块数据不可读取，请选择已生成区域');
  const focus=Number.isFinite(args.y)?args.y:surface.y??index.void_world?.spawn[1]??64,minY=Math.max(-64,Math.min(256,Math.floor(focus)-32));
  const bounds=[cx*16-16,minY,cz*16-16,cx*16+31,minY+63,cz*16+31];
  const snapshot=savedDetailSnapshot(bounds,index);
  const pins=saveSnapshot(snapshot);
  const label=tab.label??(tab.view_id?'三维 '+x+' / '+Math.floor(focus)+' / '+z:'三维场景');
  const r={id:'world-view-'+randomUUID(),view_id:tab.view_id,label,bounds,loaded_bounds:bounds,world:snapshot.world,world_uuid:snapshot.uuid,minecraft:snapshot.minecraft,source:snapshot.source,world_revision:index.revision,environment_revision:index.environment_revision,transient:true,surface_y:surface.y,focus_position:[x+.5,focus,z+.5],unknown_chunks:snapshot.unknown_chunks??[],block_entity_count:snapshot.block_entity_count,block_entity_positions:snapshot.block_entity_positions,detail_for_plan_id:args.plan_id,keep_camera:args.keep_camera??false,captured_at:new Date().toISOString(),...pins};
  if(index.void_world) Object.assign(r,{construction_y:Math.floor(focus),pristine_void:index.pristine_void});
  savePreview(r);
  return args.capture_only?r:displayRegion(r,'display',args.navigation_id);
 }
 async function execute(name,args){
  if(name==='world_map_info')return info();
  if(name==='get_scene_view')return desktopRequest({kind:'scene_view'});
  if(name==='inspect_captured_scene'){if(!/^[a-zA-Z0-9-]{1,99}$/.test(args.capture_id))throw Error('Invalid scene capture ID');const folder=path.join(root,'captures',args.capture_id),metadata=JSON.parse(fs.readFileSync(path.join(folder,'capture.json'))),bytes=fs.readFileSync(path.join(folder,'scene-geometry.json'));if(createHash('sha256').update(bytes).digest('hex')!==metadata.scene_geometry_sha256)throw Error('Saved scene geometry changed');const scene=JSON.parse(bytes);return {...scene,models:undefined,atlas_png:undefined,model_count:Object.keys(scene.models??{}).length,tiles:scene.tiles.map(t=>({...t,groups:undefined,quads:undefined,quad_count:t.quads?.length,visible_blocks:t.visible_blocks})),scope:scene.representation?.startsWith('minecraft_block_models')?'Frozen actual block models, exposed faces, texture atlas and world coordinates used for this image.':'Historical voxel LOD capture.'};}
  if(name==='world_scene_info')return sceneInfo(worldIndex(),args.preview===true);
  if(name==='world_model_tile'){const index=worldIndex();if(args.world_revision&&index.revision!==args.world_revision)throw Error('世界存档已变化，请刷新实景');return modelTile(args.x,args.z,path.join(root,'model-cache'),index);}
  if(name==='world_volume_tile'){const index=worldIndex();if(args.world_revision&&index.revision!==args.world_revision)throw Error('世界存档已变化，请刷新全景三维');return volumeTile(args.x,args.z,args.level,path.join(root,'volume-cache'),index);}
  if(name==='open_world_scene'){
   const tab=sceneTab(args),index=worldIndex();
   if(index.pristine_void){const [x,y,z]=index.void_world.spawn;return browse({x,y,z,...tab,label:tab.label??index.world});}
   const scene=sceneInfo(index,true),initial_camera=savedWorldCamera(index);
   if(scene.progressive_loading)delete scene.occupied_chunks;
   return desktopRequest({kind:'world_scene',scene:{...scene,initial_camera},...tab});
  }
  if(name==='capture_world_scene'){
   const width=args.width??1280,height=args.height??800,angles=args.angles??[],views=args.views??[],current_view=args.angles===undefined&&args.views===undefined;
   if(![width,height].every(v=>Number.isInteger(v)&&v>=256&&v<=1920))throw Error('3D PNG dimensions must be 256..1920');
   if(!Array.isArray(angles)||angles.length>6||angles.some(a=>!['north','south','east','west','top','isometric'].includes(a))||!Array.isArray(views)||views.length>8||views.some(v=>!v||typeof v.name!=='string'||v.name.length>80||['position','target'].some(k=>!Array.isArray(v[k])||v[k].length!==3||!v[k].every(n=>Number.isFinite(n)&&Math.abs(n)<=30000000)))||!current_view&&!views.length&&!angles.length)throw Error('Invalid panoramic cameras');
   const scene=sceneInfo(),state=planning.publicState(planning.read());let focus;
   if(!scene.bounds)throw Error('No saved world content to preview');if(args.plan_id){const {plan}=planning.object(args.plan_id),b=planBounds(plan);focus=[b[0],plan.min_y??scene.bounds[1],b[1],b[2],plan.max_y??scene.bounds[4],b[3]];}
   const result=await desktopRequest({kind:'capture_scene',scene,width,height,angles:views.length?[]:angles,views,current_view,focus,show_plans:args.show_plans??false,show_invisible:args.show_invisible??false,planning_revision:state.revision});
   if(result.world_revision!==scene.revision||worldIndex().revision!==scene.revision)throw Error('世界存档在截图期间发生变化，请刷新重试');
   if(result.planning_revision!==state.revision)throw Error('Planning revision changed during panoramic capture');
   const folder=path.dirname(result.images[0].path),geometry=JSON.stringify(result.scene_geometry),plans=JSON.stringify(state);fs.writeFileSync(path.join(folder,'scene-geometry.json'),geometry);fs.writeFileSync(path.join(folder,'planning.json'),plans);delete result.scene_geometry;result.scene_geometry_sha256=createHash('sha256').update(geometry).digest('hex');result.planning_snapshot_hash=createHash('sha256').update(plans).digest('hex');fs.writeFileSync(path.join(folder,'capture.json'),JSON.stringify(result));return result;
  }
  if(name==='world_map_tile')return surfaceTile(args.x,args.z,args.level,path.join(root,'map-cache'),worldIndex(),args.slice_y??null);
  if(name==='world_surface_at')return {x:args.x,z:args.z,surface:sampleSurface(args.x,args.z),source:'saved_anvil_surface'};
  if(name==='save_map_view'){const view=validateView(args.view),temp=viewFile+'.pending-'+process.pid;fs.writeFileSync(temp,JSON.stringify(view));fs.renameSync(temp,viewFile);return view;}
  if(name==='open_map'){return desktopRequest({kind:'map'});}
  if(name==='browse_world')return browse(args);
  if(name==='open_plan_detail'){
   const {plan}=planning.object(args.plan_id),b=planBounds(plan);
   return browse({x:Math.floor((b[0]+b[2])/2),z:Math.floor((b[1]+b[3])/2),y:planningFocusY(plan)??args.y,
    plan_id:plan.id,allow_saved:args.allow_saved,navigation_id:args.navigation_id,view_id:args.view_id,label:args.view_id?plan.name:undefined});
  }
  if(name==='inspect_captured_plans'){if(!/^[a-zA-Z0-9-]{1,99}$/.test(args.capture_id))throw Error('Invalid map capture ID');const folder=path.join(root,'captures',args.capture_id),metadata=JSON.parse(fs.readFileSync(path.join(folder,'capture.json'))),bytes=fs.readFileSync(path.join(folder,'planning.json'));if(createHash('sha256').update(bytes).digest('hex')!==metadata.planning_snapshot_hash)throw Error('Saved planning snapshot changed');const state=JSON.parse(bytes);return args.plan_id?{revision:state.revision,plan:state.objects.find(p=>p.id===args.plan_id),layers:state.layers}:state;}
  if(name==='capture_map'){
   const width=args.width??1280,height=args.height??800;if(!Number.isInteger(width)||!Number.isInteger(height)||width<256||height<256||width>2048||height>2048)throw Error('Map PNG dimensions must be 256..2048');
   const map=info();let view=args.view??map.view;
   if(args.plan_id){const b=planBounds(planning.object(args.plan_id).plan);view={x:(b[0]+b[2])/2,z:(b[1]+b[3])/2,scale:Math.max(.025,(b[2]-b[0]+32)/width,(b[3]-b[1]+32)/height),rotation:view?.rotation??0,slice_y:view?.slice_y};}
   if(!view){const b=map.bounds;view={x:(b[0]+b[2])/2,z:(b[1]+b[3])/2,scale:Math.max((b[2]-b[0])/width,(b[3]-b[1])/height)*1.1,rotation:0};}
   const state=planning.publicState(planning.read()),result=await desktopRequest({kind:'capture_map',view:validateView(view),width,height,planning_revision:state.revision,world_revision:map.revision});if(result.planning_revision!==state.revision)throw Error('Map image planning revision mismatch');const folder=path.dirname(result.images[0].path),bytes=JSON.stringify(state);fs.writeFileSync(path.join(folder,'planning.json'),bytes);result.planning_snapshot_hash=createHash('sha256').update(bytes).digest('hex');result.world_uuid=map.world_uuid;fs.writeFileSync(path.join(folder,'capture.json'),JSON.stringify(result));return result;
  }
  throw Error('Unknown world map tool');
 }
 return {execute,browse,info};
}
