import {installViewportLook} from './viewport-look.js';
import {invoke} from '@tauri-apps/api/core';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {buildState,awaitTextures,invisibleMarkerMaterial,opaqueModel} from './model-terrain.js';
import {ChunkRenderer} from './chunk-renderer.js';
import {makeIndex,patchLocalIndex} from './chunk-index.js';
import {snapshotDelta,applySnapshotDelta,affectedChunkColumns} from './snapshot-delta.js';
import {mountWorkspaceUI} from './workspace-ui.js';
import {mountMapWorkspace} from './map-workspace.js';
import {TexturedWorld} from './textured-world.js';
import {PlanningOverlay} from './planning-overlay.js';
import {captureCamera,captureFrustum,renderCapture} from './capture-renderer.js';
import {PlanningSketch,planningPoint,pointLabel} from './planning-sketch.js';
import './scene.css';
import './editor-layout.css';
import './appearance.css';
import './panel-layout.css';
import {readWheelSensitivity,saveWheelSensitivity,wheelZoomFactor,wheelTravel} from './viewport-wheel.js';
import {callWorkbench} from './workbench-api.js';
import {mountRenderSettings} from './render-settings-ui.js';
import {OfflineIrisView} from './offline-iris-view.js';

const $=id=>document.getElementById(id),view=$('view'),scene=new THREE.Scene();
scene.background=new THREE.Color('#14171c');
const skyLight=new THREE.HemisphereLight(0xffffff,0x7a8390,2);
const sun=new THREE.DirectionalLight(0xffffff,1.6);
sun.position.set(-.55,.8,-.4);
scene.add(skyLight,sun,sun.target);
const camera=new THREE.PerspectiveCamera(50,1,.1,5000),renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));view.prepend(renderer.domElement);
installViewportLook(renderer.domElement, () => !capturing && !macro.active && sceneDrag === null, (dx,dy,event) => {
 if (fly) {
  const angles = new THREE.Euler().setFromQuaternion(camera.quaternion,'YXZ');
  angles.y -= dx * .004;
  angles.x = THREE.MathUtils.clamp(angles.x - dy * .004, -Math.PI / 2 + .01, Math.PI / 2 - .01);
  camera.quaternion.setFromEuler(angles);
  controls.target.copy(camera.position).addScaledVector(camera.getWorldDirection(new THREE.Vector3()),24);
 } else if(event.shiftKey) controls.pan(dx,dy);
 else {
  const factor = Math.PI * 2 * controls.rotateSpeed / Math.max(1,renderer.domElement.clientHeight);
  controls.rotateLeft(dx * factor); controls.rotateUp(dy * factor);
 }
 requestDraw();
});
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;
controls.mouseButtons={LEFT:null,MIDDLE:THREE.MOUSE.PAN,RIGHT:THREE.MOUSE.ROTATE};
const cache=new Map(),unsupported=new Map(),box=new THREE.BoxGeometry(1,1,1),pink=new THREE.MeshBasicMaterial({color:0xff00ff,wireframe:true});
async function parts(state,options={},showInvisible=!!settings.show_invisible){const key=state+'|'+showInvisible+'|'+JSON.stringify(options);if(!cache.has(key))cache.set(key,buildState(state,{...options,showInvisible}).catch(e=>{unsupported.set(state,String(e));return [{geometry:box,material:pink,placeholder:true}];}));return cache.get(key);}
const chunks=new ChunkRenderer(scene,parts,[0,0,0]);
let region=null,snapshot=null,outline=null,diffGroup=new THREE.Group(),working=false,polling=false,sceneChanging=false,capturing=false,marking=false,corner=null,renderQueue=Promise.resolve();
let tool='select',grid=null,blockOutline=null;
const sceneSketch=new PlanningSketch();
const getPlanSnap=()=>$('planning-snap').checked;
let scenePointer=null,sceneDrag=null,coordinatePin=null,planOverlayDirty=true,planTargetDirty=false,lastPlanHover=0;
function requestPlanOverlay(target=false){planOverlayDirty=true;planTargetDirty||=target;}
let residentGeometry=null,geometryBuilds=0;
let needsDraw=true,viewportFrames=0,needsCameraSync=true;
const drawnPosition=new THREE.Vector3(),drawnRotation=new THREE.Quaternion();
function requestDraw(){needsDraw=true;}
function resizeViewport(){
 const width=Math.max(1,view.clientWidth),height=Math.max(1,view.clientHeight);
 renderer.setPixelRatio(Math.min(devicePixelRatio,2));
 renderer.setSize(width,height,false);
 camera.aspect=width/height;
 camera.updateProjectionMatrix();
 requestDraw();
}
scene.add(diffGroup);
let settings={min_y:-64,max_y:319,show_selection:false,show_grid:false,show_plans:false,show_invisible:false,display_mode:'scene'};
const planningToggle=document.createElement('label');planningToggle.title='规划叠加';planningToggle.innerHTML='<input id="planning-overlay" type="checkbox" aria-label="规划叠加"><svg class="icon"><use href="#i-folder"/></svg>';$('detail-switches').prepend(planningToggle);
const invisibleToggle=document.createElement('label');invisibleToggle.title='显示屏障标识';invisibleToggle.innerHTML='<input id="invisible-blocks" type="checkbox" aria-label="显示屏障"><svg class="icon"><use href="#i-eye"/></svg>';$('detail-switches').prepend(invisibleToggle);
const openRenderSettings=mountRenderSettings({
 selected:sceneView,
 apply(_config,pose){
  sessionStorage.setItem('terraweave-render-restore',JSON.stringify(pose));
  location.reload();
 }
});
const ui=mountWorkspaceUI({getRegion:()=>region,getSnapshot:()=>snapshot,getView:()=>({...settings}),getCamera:()=>sceneView(),isCapturing:()=>capturing,setView,frame:name=>{if(region&&!capturing)frame(name);},setTool,undoSketch,cancelActiveSketch,clear:clearDocument,openRenderSettings});
const iris=new OfflineIrisView(view,ui.say,()=>requestPlanOverlay(true));
const api=callWorkbench;
const macro=mountMapWorkspace({editor:ui,canvas:renderer.domElement,getRegion:()=>region,getPlanSnap,sketchChanged:refreshPlanningControls,resumePanorama(){if(!region?.panorama||!ui.storedView(region)||!lod.meshes.size||lod.loading)return false;macro.showDetail();ui.setRegion(region);ui.setViewFields(settings);$('source-state').textContent='存档全景三维';$('source-status').textContent='完整模型与贴图 · 自由相机';cameraMode();requestDraw();return true;}});ui.bindMap(macro);
const sceneLoading=document.createElement('div');sceneLoading.id='scene-loading';sceneLoading.hidden=true;view.append(sceneLoading);
const panoramaButton=document.createElement('button');
panoramaButton.textContent='全景';
panoramaButton.title='查看整个世界的三维体块';
panoramaButton.onclick=()=>{
 if(capturing||sceneChanging)return;
 if(region?.panorama)frame('isometric');
 else ui.run(()=>api('open_world_scene'));
};
$('detail-controls').querySelector('.view-buttons').prepend(panoramaButton);
const lod=new TexturedWorld(scene,api,parts,(done,total)=>{sceneLoading.hidden=macro.active||done>=total;sceneLoading.textContent='正在加载完整模型与贴图 '+done+' / '+total;if(region?.panorama)$('render-stats').textContent=done+' / '+total+' · 完整材质';}),planOverlay=new PlanningOverlay(view);let fly=true,lastFrame=performance.now(),flyLook=null,lastAngles=0;const heldKeys=new Set();
const cameraDraft=new Map();let cameraDirty=false;const cameraFields=['camera-x','camera-y','camera-z','camera-yaw','camera-pitch'];
const speedField=document.createElement('label');speedField.innerHTML='移动速度 <input id="camera-speed" type="number" min="0.1" max="2048" value="20" aria-label="相机移动速度">';$('set-camera-angle').after(speedField);$('set-camera-angle').textContent='应用相机位置与朝向';
const wheelField=document.createElement('label');wheelField.innerHTML='滚轮灵敏度（%）<input id="wheel-sensitivity" type="number" min="1" max="100" step="1" aria-label="滚轮灵敏度">';speedField.after(wheelField);$('wheel-sensitivity').value=String(readWheelSensitivity());$('wheel-sensitivity').onchange=()=>{$('wheel-sensitivity').value=String(saveWheelSensitivity($('wheel-sensitivity').value));};
for(const id of cameraFields)$(id).addEventListener('input',()=>{cameraDirty=true;cameraDraft.set(id,$(id).value);});
function syncCameraFields(force=false){if(!snapshot||cameraDirty&&!force)return;const p=camera.position.toArray().map((n,i)=>n+snapshot.bounds[i]),direction=camera.getWorldDirection(new THREE.Vector3()),yaw=(THREE.MathUtils.radToDeg(Math.atan2(direction.x,-direction.z))+360)%360,pitch=THREE.MathUtils.radToDeg(Math.asin(direction.y));[...p,yaw,pitch].forEach((n,i)=>$(cameraFields[i]).value=String(Math.round(n*100)/100));if(force){cameraDirty=false;cameraDraft.clear();}}
function moveSpeed(){return THREE.MathUtils.clamp(Number($('camera-speed').value)||20,.1,2048);}
function resetNavigation(){heldKeys.clear();flyLook=null;}
function cameraMode(){controls.enabled=!fly&&!capturing;$('fly-toggle').classList.toggle('active',fly);$('fly-toggle').textContent=fly?'自由相机':'环绕相机';$('control-hint').textContent=fly?'右键转头 · WASD 移动 · 空格/E 上升 · Q/C 下降 · Shift 加速 · 中键平移':'右键环绕 · 中键平移 · 滚轮缩放';}
function atmosphere(){scene.background.set(settings.display_mode==='editor'?'#14171c':'#b8d4ed');if(grid)grid.visible=settings.show_grid;if(outline)outline.visible=settings.show_selection;diffGroup.visible=settings.display_mode==='editor';requestDraw();}
const usesIris=()=>iris.active&&settings.display_mode==='scene'&&!!snapshot&&!!region;
const sceneKey=()=>[region.snapshot_hash??region.id,region.environment_revision??lod.info?.environment_revision,geometryBuilds,lod.enabled?lod.signature:'',lod.meshes.size].join(':');
const displayedCamera=()=>!usesIris()||iris.canvas.hidden?camera:iris.presented?.key===sceneKey()?iris.presented.camera:null;
function drawViewport(){
 const shaded=usesIris();
 view.classList.toggle('iris-active',shaded);
 if(!shaded||iris.canvas.hidden)renderer.render(scene,camera);
 if(shaded&&(lod.meshes.size||chunks.meshes().length)){
  iris.show({lod,chunks,snapshot,region,camera,width:renderer.domElement.width,height:renderer.domElement.height,key:sceneKey()});
 }
}
function planningTool(){return sceneSketch.active;}
function setTool(name){
 if(sceneSketch.saving)return false;
 tool=name;
 marking=name==='box';
 corner=null;
 if(sceneSketch.mode!==(name.startsWith('plan-')?name.slice(5):null)){
  cancelSceneDrag();
  sceneSketch.setMode(name.startsWith('plan-')?name.slice(5):null);
 }
 controls.enabled=!fly&&!capturing;
 controls.mouseButtons.LEFT=name==='orbit'?THREE.MOUSE.ROTATE:null;
 renderer.domElement.style.cursor=planningTool()||['paint','erase','box'].includes(name)?'crosshair':'default';
 refreshPlanningControls();
 requestPlanOverlay(true);
}
function clearDocument(){
 resetNavigation();
 region=null;snapshot=null;residentGeometry=null;chunks.reset({chunks:[]},319);
 lod.enabled=false;lod.clear();sceneLoading.hidden=true;
 clearSceneSketch();
 planOverlay.draw(null,null);
 for(const mesh of [outline,grid,blockOutline])if(mesh){scene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();}
 outline=grid=blockOutline=null;
 clearDiff();requestDraw();
}
const currentSketch=()=>macro.active?macro.sketch:sceneSketch;
const planTitles={area:'框选规划',polygon:'多边形规划',route:'路线规划',marker:'地点标记'};
const startHints={area:'拖动框选，或依次点击两个角点',polygon:'沿边界逐点点击',route:'沿路线逐点点击',marker:'点击要标记的位置'};
function sketchGeometry(sketch){
 const geometry=sketch.geometry();
 return geometry&&macro.active?{...geometry,...macro.draftHeight()}:geometry;
}
function resetSketchHeight(){
 $('sketch-min-y').value='';
 $('sketch-max-y').value='';
}
function refreshPlanningControls(){
 const sketch=currentSketch(),mode=sketch.mode;
 let geometry,problem='';
 try{geometry=sketchGeometry(sketch);}catch(error){problem=error.message;}
 $('planning-gesture').hidden=!sketch.active||!macro.active&&!region;
 $('map-plan-height').hidden=!macro.active;
 if(!sketch.active)return;
 $('sketch-height-note').textContent=problem||'两项留空时沿用地图的显示高度。只填一项时，按该高度规划。';
 $('planning-gesture-title').textContent=planTitles[mode];
 const adjusting=geometry?'拖动控制点调整 · Enter 保存':sketch.points.length===1&&mode==='area'?'选择另一角点':startHints[mode];
 $('planning-gesture-hint').textContent=sketch.saving?'正在保存…':adjusting;
 const points=geometry?.points??sketch.points.map(p=>[p.x,p.z]);
 const xs=points.map(p=>p[0]),zs=points.map(p=>p[1]);
 const range=values=>values.length===1?String(values[0]):Math.min(...values)+'–'+Math.max(...values);
 $('planning-gesture-range').textContent=points.length?'X '+range(xs)+'  /  Z '+range(zs)+(geometry?.min_y==null?'':'  /  Y '+geometry.min_y+(geometry.max_y===geometry.min_y?'':'–'+geometry.max_y)):sketch.cursor?pointLabel(sketch.cursor):'';
 $('finish-planning-gesture').disabled=sketch.saving||!geometry;
 $('undo-planning-point').disabled=sketch.saving||sketch.editing||!sketch.past.length;
 $('cancel-planning-gesture').disabled=sketch.saving;
 $('cancel-planning-gesture').textContent=sketch.hasWork?'取消':'退出工具';
}
function redrawSketch(){
 if(macro.active)macro.redrawSketch();
 else{refreshPlanningControls();requestPlanOverlay();}
}
function undoSketch(redo=false){
 if(!currentSketch().undo(redo))return false;
 redrawSketch();
 return true;
}
function cancelActiveSketch(){
 const sketch=currentSketch();
 if(!sketch.active)return false;
 if(sketch.saving)return true;
 if(macro.active){resetSketchHeight();macro.chooseTool('select');}
 else ui.toolChanged('select');
 return true;
}
async function savePlanning(){
 const sketch=currentSketch();
 let geometry;
 try{geometry=sketchGeometry(sketch);}catch(error){ui.say(error.message);return;}
 if(!geometry||sketch.saving||capturing||sceneChanging)return;
 const world=region?.world_uuid;
 sketch.saving=true;
 refreshPlanningControls();
 try{
  const result=await macro.createPlanning(geometry);
  if(!result)return;
  sketch.reset();
  if(sketch===macro.sketch)resetSketchHeight();
  if(sketch===sceneSketch&&!macro.active&&region?.world_uuid===world){
   settings.show_plans=true;
   ui.setViewFields(settings);
  }
 }catch(error){ui.say(String(error));}
 finally{
  sketch.saving=false;
  redrawSketch();
 }
}
$('planning-snap').checked=localStorage.getItem('terraweave-plan-snap')!=='off';
$('planning-snap').onchange=()=>{
 localStorage.setItem('terraweave-plan-snap',getPlanSnap()?'on':'off');
 currentSketch().hover(null);
 redrawSketch();
};
$('finish-planning-gesture').onclick=savePlanning;
$('undo-planning-point').onclick=()=>undoSketch();
$('cancel-planning-gesture').onclick=cancelActiveSketch;
for(const id of ['sketch-min-y','sketch-max-y'])$(id).oninput=refreshPlanningControls;
$('locate-position').onclick=()=>{
 const near=coordinatePin??currentSketch().cursor;
 const focus=macro.active?macro.getView():null;
 const point=near??(focus?{x:Math.round(focus.x),z:Math.round(focus.z)}:region?{
  x:Math.round(controls.target.x+snapshot.bounds[0]),z:Math.round(controls.target.z+snapshot.bounds[2])
 }:null);
 $('locate-x').value=point?.x??'';
 $('locate-y').value=point?.blockY??'';
 $('locate-z').value=point?.z??'';
 $('locate-position-status').textContent='';
 $('clear-position-pin').disabled=!coordinatePin;
 $('locate-position-dialog').showModal();
};
$('close-position-dialog').onclick=()=>$('locate-position-dialog').close();
$('clear-position-pin').onclick=()=>{
 coordinatePin=null;
 macro.locate(null,false);
 requestPlanOverlay();
 $('locate-position-dialog').close();
};
$('locate-position-form').onsubmit=e=>{
 e.preventDefault();
 if(capturing||sceneChanging)return;
 const [x,z]=['locate-x','locate-z'].map(id=>Number($(id).value));
 const rawY=$('locate-y').value;
 let y=rawY===''?null:Number(rawY);
 if(!macro.active&&y===null)y=surfaceHeight(x,z);
 if(!macro.active&&(!region||y===null)){
  $('locate-position-status').textContent='请填写这里的 Y 高度';
  return;
 }
 const point=planningPoint(x,z,{height:y===null?null:y+.02,blockY:y,snap:false});
 if(!point)return;
 coordinatePin=point;
 macro.locate(point,macro.active);
 if(!macro.active){
  resetNavigation();
  controls.target.copy(local([point.x,y,point.z]));
  camera.position.copy(controls.target).add(new THREE.Vector3(0,36,0));
  camera.up.set(0,0,-1);
  camera.lookAt(controls.target);
  syncCameraFields(true);
  requestDraw();
 }
 requestPlanOverlay();
 $('locate-position-dialog').close();
};
function local(p){return new THREE.Vector3(...p.map((v,i)=>v-snapshot.bounds[i]));}
function clearDiff(){diffGroup.traverse(o=>{if(o.isInstancedMesh)o.dispose();if(o.material)o.material.dispose();});diffGroup.clear();}
function markers(){
 requestDraw();
 if(outline){scene.remove(outline);outline.geometry.dispose();outline.material.dispose();}
 const b=region.bounds,s=snapshot.bounds;
 const shape=new THREE.BoxGeometry(b[3]-b[0]+1,b[4]-b[1]+1,b[5]-b[2]+1),edges=new THREE.EdgesGeometry(shape);shape.dispose();
 outline=new THREE.LineSegments(edges,new THREE.LineBasicMaterial({color:0x35e9f7,depthTest:false}));outline.renderOrder=10;outline.visible=settings.show_selection;
 outline.position.set((b[0]+b[3]+1)/2-s[0],(b[1]+b[4]+1)/2-s[1],(b[2]+b[5]+1)/2-s[2]);scene.add(outline);
 clearDiff();if(region.preview_mode!=='diff')return;
 for(const [kind,color]of Object.entries({added:0x40e880,replaced:0xffb347,removed:0xff5555})){
  const changes=(region.diff??[]).filter(c=>c.kind===kind&&c.coordinate[1]>=settings.min_y&&c.coordinate[1]<=settings.max_y);if(!changes.length)continue;
  const mesh=new THREE.InstancedMesh(box,new THREE.MeshBasicMaterial({color,transparent:true,opacity:.38,depthTest:false}),changes.length),matrix=new THREE.Matrix4();
  changes.forEach((c,i)=>{matrix.makeTranslation(...c.coordinate.map((v,n)=>v-s[n]+.5));mesh.setMatrixAt(i,matrix);});mesh.renderOrder=8;diffGroup.add(mesh);
 }
}
function renderScene(incomingDelta){
 const wanted=snapshot,wantedRegion=region,config={...settings};
 const run=async()=>{
  if(wanted!==snapshot||wantedRegion!==region)return;
  // Snapshot identity includes the neighboring block states used for face culling.
  const profile=[config.min_y,config.max_y,!!config.show_invisible].join(':');
  const previous=residentGeometry;
  const sameProfile=previous?.profile===profile;
  const reused=!!wantedRegion.snapshot_hash&&sameProfile&&previous.hash===wantedRegion.snapshot_hash;
  let meshUpdate={mode:'reused',rebuilt_chunks:0,retained_chunks:chunks.loaded.size};
  if(!reused){
   const delta=sameProfile
    ?(incomingDelta?.from_hash===previous.hash?incomingDelta:snapshotDelta(previous.snapshot,wanted))
    :null;
   const dirty=delta?affectedChunkColumns(delta):null;
   const states=delta
    ?new Set([...delta.blocks,...delta.context_blocks].map(([,state])=>state).filter(state=>state!==null))
    :new Set([...Object.values(wanted.blocks),...Object.values(wanted.context_blocks??{})]);
   const opaqueStates=delta?new Set(previous.opaqueStates):new Set();
   await Promise.all([...states].map(async state=>{if(await opaqueModel(state))opaqueStates.add(state);}));
   if(wanted!==snapshot||wantedRegion!==region)return;
   residentGeometry=null;
   chunks.origin=wanted.bounds.slice(0,3);
   if(delta)chunks.index=patchLocalIndex(chunks.index,wanted,dirty,opaqueStates);
   else chunks.reset(makeIndex(wanted,1,{cull:true,opaqueStates}),config.max_y,config.min_y);
   while(chunks.busy)await new Promise(r=>setTimeout(r,10));
   const updated=await chunks.update((wanted.bounds[0]+wanted.bounds[3]+1)/2,(wanted.bounds[2]+wanted.bounds[5]+1)/2,256,256,{
    parts:(state,options)=>parts(state,options,!!config.show_invisible),dirty,prepare:awaitTextures
   });
   if(wanted!==snapshot||wantedRegion!==region)return;
   residentGeometry={hash:wantedRegion.snapshot_hash,snapshot:wanted,profile,opaqueStates};
   meshUpdate={mode:delta?'partial':'full',...updated};
   geometryBuilds++;
  }
  markers();atmosphere();
  const active=[...new Set(chunks.meshes().map(m=>m.userData.s))].filter(s=>unsupported.has(s));
  ui.setLimits(active.length?'以下状态使用粉色占位：\n'+active.join('\n'):'实际方块模型与材质已就绪；光照、流体、实体及方块实体细节仍有差异。');ui.stats(chunks.stats.activeBlocks);
  return meshUpdate;
 };
 renderQueue=renderQueue.catch(()=>{}).then(run);return renderQueue;
}
async function configureInvisible(value){let map;if(value){const mat=invisibleMarkerMaterial();await awaitTextures([mat]);map=mat.map;}lod.setShowInvisible(!!value,map);requestDraw();}
async function setView(next){if(sceneChanging||capturing)return;const layers=next.min_y!==undefined&&next.min_y!==settings.min_y||next.max_y!==undefined&&next.max_y!==settings.max_y,invisible=next.show_invisible!==undefined&&next.show_invisible!==settings.show_invisible;settings={...settings,...next};if(invisible)await configureInvisible(settings.show_invisible);atmosphere();ui.setViewFields(settings);if(snapshot&&(layers||invisible)&&!region.panorama)await renderScene();}
function frame(name='isometric',width=view.clientWidth,height=view.clientHeight,custom){
 const b=region.bounds,focus=[...b];focus[1]=Math.max(b[1],settings.min_y);focus[4]=Math.max(focus[1],Math.min(b[4],settings.max_y));
 const center=region.focus_position?[region.focus_position[0],THREE.MathUtils.clamp(region.focus_position[1],focus[1],focus[4]+1),region.focus_position[2]]:focus.slice(0,3).map((n,i)=>(n+focus[i+3]+1)/2);
 const dimensions=focus.slice(0,3).map((n,i)=>focus[i+3]-n+1),extent=Math.max(...dimensions);
 const distance=extent/(2*Math.tan(THREE.MathUtils.degToRad(camera.fov/2)))*1.5*Math.max(1,height/width);
 const directions={north:[0,.25,-1],south:[0,.25,1],east:[1,.25,0],west:[-1,.25,0],top:[0,1,0],isometric:[1,.8,-1]};
 camera.aspect=width/height;camera.up.set(0,1,0);let position,target;
 if(custom){position=custom.position;target=custom.target;}
 else{const d=new THREE.Vector3(...directions[name]).normalize().multiplyScalar(distance);position=center.map((n,i)=>n+d.getComponent(i));target=center;if(name==='top')camera.up.set(0,0,-1);}
 camera.position.copy(local(position));controls.target.copy(local(target));camera.lookAt(controls.target);camera.updateProjectionMatrix();requestDraw();
 return {position,target,up:camera.up.toArray(),world_coordinates:true,fov:camera.fov};
}
function described(){return {region_id:region.id,snapshot_hash:region.snapshot_hash,positions:Object.keys(snapshot.blocks).length,unsupported_states:[...new Set(chunks.meshes().map(m=>m.userData.s))].filter(s=>unsupported.has(s))};}
function applySceneCamera(pose){
 if(pose?.world_uuid!==region?.world_uuid||!['position','target'].every(key=>Array.isArray(pose[key])&&pose[key].length===3&&pose[key].every(Number.isFinite)))return false;
 resetNavigation();
 const damping=controls.enableDamping;
 controls.enableDamping=false;controls.update();controls.enableDamping=damping;
 frame('restore',view.clientWidth,view.clientHeight,pose);
 if(Array.isArray(pose.up)&&pose.up.length===3&&pose.up.every(Number.isFinite))camera.up.fromArray(pose.up);
 camera.lookAt(controls.target);
 fly=pose.mode!=='orbit';
 syncCameraFields(true);
 return true;
}
function sceneView(){if(macro.active)return {mode:'map',view:macro.getView()};if(!snapshot)return {mode:'empty'};const position=camera.position.toArray().map((n,i)=>n+snapshot.bounds[i]),target=controls.target.toArray().map((n,i)=>n+snapshot.bounds[i]),direction=camera.getWorldDirection(new THREE.Vector3());return {mode:fly?'free':'orbit',panoramic:!!region.panorama,view_id:region.view_id,label:region.label,position,target,up:camera.up.toArray(),yaw:(THREE.MathUtils.radToDeg(Math.atan2(direction.x,-direction.z))+360)%360,pitch:THREE.MathUtils.radToDeg(Math.asin(direction.y)),fov:camera.fov,width:view.clientWidth,height:view.clientHeight,world_uuid:region.world_uuid,region_id:region.panorama?undefined:region.id,world_revision:region.world_revision,render_stats:{viewport_frames:viewportFrames,draw_calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,gpu_geometries:renderer.info.memory.geometries,gpu_textures:renderer.info.memory.textures,model_tiles:lod.meshes.size,cached_tiles:lod.cache.size,loading:!!lod.loading}};}
function localVertices(collection){
 return collection.meshes().reduce((n,mesh)=>n+mesh.count*(mesh.geometry.index?.count??mesh.geometry.getAttribute('position').count),0);
}
async function updateWorldVolume(tileLimit){
 if(!snapshot||!region||!lod.enabled)return;
 const owner=region,origin=snapshot.bounds.slice(0,3);
 const eye=camera.position.toArray().map((n,i)=>n+origin[i]),target=controls.target.toArray().map((n,i)=>n+origin[i]);
 const cut=owner.panorama?null:snapshot.bounds;
 const budget=Math.max(0,Math.min(5_200_000,6_900_000-(owner.panorama?0:localVertices(chunks))));
 volumeLoadEye=eye;
 await lod.update(target[0],target[2],camera.position.distanceTo(controls.target),origin,cut,eye,undefined,captureFrustum(camera),budget,tileLimit);
 if(owner!==region)return;
 if(lod.omittedTiles)$('source-status').textContent='已载入选区周围的实景模型 · 部分远处图块未驻留';
 requestDraw();
}
let volumeQueued=false,lastVolumeRefresh=0,volumeLoadEye;
function scheduleVolumeRefresh(now,moved){
 volumeQueued||=moved;
 if(!volumeQueued||!lod.enabled||sceneChanging||now-lastVolumeRefresh<240)return;
 if(lod.loading&&(!volumeLoadEye||!snapshot||
  Math.hypot(camera.position.x+snapshot.bounds[0]-volumeLoadEye[0],camera.position.z+snapshot.bounds[2]-volumeLoadEye[2])<96))return;
 volumeQueued=false;
 lastVolumeRefresh=now;
 updateWorldVolume().catch(error=>ui.say(String(error)));
}
function restoredSettings(defaults,saved,bounds){
 if(!saved)return defaults;
 const min_y=THREE.MathUtils.clamp(saved.min_y,bounds[1],bounds[4]);
 const max_y=THREE.MathUtils.clamp(saved.max_y,min_y,bounds[4]);
 return {...defaults,...saved,min_y,max_y};
}
async function openPanorama(q){
 if(!q.scene.bounds)throw Error('当前存档中没有可预览的完整三维内容');
 const info=q.scene.occupied_chunks?q.scene:await api('world_scene_info',{preview:true});
 if(info.revision!==q.scene.revision)throw Error('打开期间存档已变化，请刷新三维视图');
 ui.rememberView();
 const b=q.scene.bounds,sameWorld=region?.panorama&&region.world_uuid===q.scene.world_uuid&&
  region.world_revision===q.scene.revision&&lod.meshes.size&&!lod.loading;
 const next={id:'world-scene',view_id:q.view_id,panorama:true,transient:true,label:q.label??'全景三维',bounds:b,loaded_bounds:b,
  source:'saved_anvil_volume',world:q.scene.world,world_uuid:q.scene.world_uuid,world_revision:q.scene.revision,environment_revision:q.scene.environment_revision};
 const saved=ui.storedView(next);
 if(!sameWorld)clearDocument();
 else clearSceneSketch();
 fly=true;
 snapshot={bounds:b,blocks:{}};
 region=next;
 settings=restoredSettings({min_y:b[1],max_y:b[4],show_selection:false,show_grid:false,show_plans:false,
  show_invisible:settings.show_invisible??false,display_mode:'scene'},saved?.view,b);
 macro.showDetail();
 atmosphere();
 await macro.refresh();
 await lod.initialize(info);
 await configureInvisible(settings.show_invisible);
 lod.enabled=true;
 if(!applySceneCamera(q.camera??saved?.camera??q.scene.initial_camera))frame('isometric');
 ui.setRegion(region);ui.setViewFields(settings);ui.toolChanged('orbit');
 $('source-state').textContent='存档全景三维';
 $('source-status').textContent='完整模型与贴图 · 自由相机';
 $('object-summary').textContent=info.occupied_chunks.length+(info.preview_index?' 个候选区块 · 相机周围优先加载':' 个有内容区块 · 全部使用方块模型与贴图')+'\n自由移动观察，双击表面进入方块编辑';
 ui.setLimits(q.scene.limits);
 if(info.progressive_loading&&!sameWorld){
  await updateWorldVolume(6);
  volumeQueued=true;
  if(info.preview_index)api('world_scene_info').then(exact=>{
   if(region!==next||exact.revision!==info.revision||!exact.bounds)return;
   return lod.initialize(exact).then(()=>{
    if(region!==next)return;
    volumeQueued=true;
    $('object-summary').textContent=exact.occupied_chunks.length+' 个有内容区块 · 相机周围优先加载\n自由移动观察，双击表面进入方块编辑';
   });
  }).catch(error=>{if(region===next)ui.say(String(error));});
 }else await updateWorldVolume();
 cameraMode();
 ui.say(info.progressive_loading&&!sameWorld?'附近区块已就绪 · 其余区块继续加载':'实景已就绪 · WASD 移动，右键转头，E/空格上升，Q/C 下降');
 return {world_uuid:region.world_uuid,world_revision:q.scene.revision,view_id:region.view_id,representation:'minecraft_block_models',tiles:lod.meshes.size};
}
function captureScene(displayMode){
 const result=new THREE.Scene();
 result.background=new THREE.Color(displayMode==='editor'?'#14171c':'#b8d4ed');
 const light=sun.clone();
 result.add(skyLight.clone(),light,light.target);
 return result;
}
async function captureScope(callback){
 const previous=controls.enabled;
 capturing=true;resetNavigation();controls.enabled=false;
 renderer.domElement.setAttribute('aria-busy','true');
 try{return await callback();}
 finally{
  controls.enabled=previous;capturing=false;
  renderer.domElement.setAttribute('aria-busy','false');
  requestDraw();requestPlanOverlay();
 }
}
function snapshotHeight(data,x,z){
 const b=data.snapshot.bounds,ix=Math.floor(x),iz=Math.floor(z);
 const local=!data.region.panorama&&ix>=b[0]&&ix<=b[3]&&iz>=b[2]&&iz<=b[5];
 const source=local?b:data.lod.info?.bounds;
 for(let y=source?.[4]??-65;y>=(source?.[1]??-64);y--){
  const state=local?data.snapshot.blocks[[ix,y,iz].join(',')]:data.lod.stateAt(ix,y,iz);
  if(state&&!/^minecraft:(air|cave_air|void_air|barrier|structure_void|light)(\[|$)/.test(state))return y;
 }
 return data.region.surface_y??b[1];
}
async function exportViews(q,data,frozenPlans,views){
 const origin=data.snapshot.bounds;
 const overlay=new PlanningOverlay(document.createElement('div'));
 overlay.update(frozenPlans,q.show_plans,(x,z)=>snapshotHeight(data,x,z),data.key);
 const shaded=iris.active&&q.display_mode!=='editor',images=[];
 for(const {camera:renderCamera,pose,name} of views){
  const output=shaded?await iris.capture({...data,camera:renderCamera,width:q.width,height:q.height}):
   renderCapture(renderer,data.scene,renderCamera,q.width,q.height);
  const canvas=overlay.capture(output,renderCamera,origin);
  images.push({name,camera:pose,data_url:canvas.toDataURL('image/png')});
 }
 return {images,report:shaded?iris.report:undefined};
}
async function capturePanorama(q){
 const current=q.current_view?sceneView():null;
 if(current?.mode==='map'||current?.mode==='empty')throw Error('请先打开三维场景，或指定截图相机');
 if(current&&region?.draft_id)throw Error('当前为草稿预览，请使用方案的 capture_views');
 return captureScope(async()=>{
  const plans=await api('planning_state');
  if(plans.revision!==q.planning_revision)throw Error('规划已变化，请重新截图');
  const bounds=q.scene.bounds,scene=captureScene('scene');
  const staged=new TexturedWorld(scene,api,parts);
  const placed={...q.scene,id:'capture-world',panorama:true,loaded_bounds:bounds};
  const snap={bounds,blocks:{}};
  const requested=current?[{...current,name:'当前实景'}]:q.views?.length?q.views:q.angles.map(name=>({name}));
  const views=requested.map(spec=>({...captureCamera(q.width,q.height,bounds,q.focus??bounds,spec),name:spec.name}));
  try{
   if(lod.info?.revision===q.scene.revision){staged.info=lod.info;staged.cache=new Map(lod.cache);staged.prepared=new Map(lod.prepared);}
   await staged.initialize(q.scene);
   if(q.show_invisible){
    const marker=invisibleMarkerMaterial();await awaitTextures([marker]);staged.setShowInvisible(true,marker.map);
   }
   staged.enabled=true;
   const first=views[0].pose,frusta=views.map(v=>captureFrustum(v.camera));
   await staged.update(first.target[0],first.target[2],0,bounds.slice(0,3),null,first.position,undefined,
    {intersectsBox:box=>frusta.some(f=>f.intersectsBox(box))});
   const {images,report}=await exportViews(q,{scene,lod:staged,chunks,snapshot:snap,region:placed,key:'export:'+staged.signature},plans,views);
   const evidence=staged.evidence();
   for(const image of images)image.camera.tiles=evidence.tiles.map(t=>({x:t.x,z:t.z,detail:'full',revision:t.revision}));
   return {images,world_uuid:q.scene.world_uuid,world_revision:q.scene.revision,bounds,
    planning_revision:plans.revision,view:{iris:report,panoramic:true,show_plans:q.show_plans,show_invisible:!!q.show_invisible},
    scene_geometry:{...evidence,world_uuid:q.scene.world_uuid},source:'saved_anvil_textured_render',created_at:new Date().toISOString(),minecraft_client_screenshot:false};
  }finally{staged.clear();staged.markerMaterial.dispose();}
 });
}
async function display(q){
 if(!macro.acceptsDetail(q.navigation_id))return {cancelled:true};
 ui.rememberView();
 const saved=q.region.view_id?ui.storedView(q.region):null;
 const oldOrigin=snapshot?.bounds.slice(0,3),worldPosition=oldOrigin?camera.position.toArray().map((v,i)=>v+oldOrigin[i]):null,worldTarget=oldOrigin?controls.target.toArray().map((v,i)=>v+oldOrigin[i]):null;
 if(blockOutline&&(region?.snapshot_hash!==q.region.snapshot_hash||region?.view_id!==q.region.view_id||region?.draft_id!==q.region.draft_id)){
  scene.remove(blockOutline);blockOutline.geometry.dispose();blockOutline.material.dispose();blockOutline=null;
 }
 snapshot=q.snapshot;region=q.region;macro.showDetail();
 const construction=Number.isInteger(region.construction_y),edit=region.source==='design_draft'&&region.preview_mode==='diff';
 settings={min_y:snapshot.bounds[1],max_y:snapshot.bounds[4],show_selection:edit?$('outline').checked:false,
  show_grid:construction||(edit&&$('grid').checked),show_plans:construction||!!region.detail_for_plan_id,
  show_invisible:settings.show_invisible??false,display_mode:edit||construction?'editor':'scene'};
 settings=restoredSettings(settings,saved?.view,snapshot.bounds);
 corner=null;controls.enabled=!fly;
 if(grid){scene.remove(grid);grid.geometry.dispose();grid.material.dispose();}
 const width=snapshot.bounds[3]-snapshot.bounds[0]+1,depth=snapshot.bounds[5]-snapshot.bounds[2]+1;
 const size=construction?Math.max(width,depth):Math.ceil(Math.max(width,depth)*2/16)*16;
 grid=new THREE.GridHelper(size,size,0x557f83,0x304952);
 grid.position.set(Math.floor(width/2),construction?region.construction_y-snapshot.bounds[1]-.002:-.03,Math.floor(depth/2));scene.add(grid);
 const meshUpdate=await renderScene(q.snapshot_delta);
 if(!macro.acceptsDetail(q.navigation_id))return {cancelled:true};
 if(region.keep_camera&&worldPosition){camera.position.copy(local(worldPosition));controls.target.copy(local(worldTarget));camera.lookAt(controls.target);}else frame();
 applySceneCamera(q.camera??saved?.camera);
 lod.enabled=!!region.transient&&!region.pristine_void;
 if(!lod.enabled)lod.clear();else lod.rebase(snapshot.bounds.slice(0,3));
 ui.setRegion(region);ui.setViewFields(settings);ui.toolChanged(tool);cameraMode();
 macro.completeDetail(q.navigation_id);
 if(lod.enabled){
  if(!lod.info||region.world_revision&&lod.info.revision!==region.world_revision||region.environment_revision&&lod.info.environment_revision!==region.environment_revision){
   await lod.initialize(await api('world_scene_info',{preview:true}));
  }
  updateWorldVolume().catch(error=>ui.say(String(error)));
 }
 return {...described(),geometry_reused:meshUpdate?.mode==='reused',local_geometry_builds:geometryBuilds,local_mesh_update:meshUpdate};
}
async function captures(q){
 return captureScope(async()=>{
  const r=q.region,snap=q.snapshot,origin=snap.bounds.slice(0,3);
  const scene=captureScene(q.display_mode),staged=new TexturedWorld(scene,api,parts);
  const localChunks=new ChunkRenderer(scene,(s,o)=>parts(s,o,!!q.show_invisible),origin);
  const helpers=[];
  try{
   const states=new Set([...Object.values(snap.blocks),...Object.values(snap.context_blocks??{})]);
   const opaqueStates=new Set();
   await Promise.all([...states].map(async state=>{if(await opaqueModel(state))opaqueStates.add(state);}));
   localChunks.reset(makeIndex(snap,1,{cull:true,opaqueStates}),q.max_y,q.min_y);
   const b=snap.bounds;
   await localChunks.update((b[0]+b[3]+1)/2,(b[2]+b[5]+1)/2,256,256,{prepare:awaitTextures});
   if(q.show_selection){
    const bounds=r.bounds,box=new THREE.BoxGeometry(...origin.map((_,i)=>bounds[i+3]-bounds[i]+1));
    const edges=new THREE.EdgesGeometry(box);box.dispose();
    const outline=new THREE.LineSegments(edges,new THREE.LineBasicMaterial({color:0x35e9f7,depthTest:false}));
    outline.position.set(...origin.map((n,i)=>(bounds[i]+bounds[i+3]+1)/2-n));
    scene.add(outline);helpers.push(outline);
   }
   if(q.show_grid){
    const size=Math.ceil(Math.max(b[3]-b[0]+1,b[5]-b[2]+1)*2/16)*16;
    const grid=new THREE.GridHelper(size,size,0x3b4554,0x282e38);
    grid.position.set(Math.floor((b[3]-b[0]+1)/2),-.03,Math.floor((b[5]-b[2]+1)/2));
    scene.add(grid);helpers.push(grid);
   }
   const focus=[...r.bounds];
   focus[1]=Math.max(focus[1],q.min_y);focus[4]=Math.max(focus[1],Math.min(focus[4],q.max_y));
   const requested=q.views?.length?q.views:q.angles.map(name=>({name}));
   const views=requested.map(spec=>({...captureCamera(q.width,q.height,origin,focus,spec),name:spec.name}));
   const plans=await api('planning_state');
   const environment=await api('world_scene_info');
   const {images,report}=await exportViews(q,{scene,lod:staged,chunks:localChunks,snapshot:snap,region:r,
    key:'capture:'+r.snapshot_hash+':'+q.min_y+':'+q.max_y+':'+q.show_invisible,
    world_revision:environment.revision,environment_revision:environment.environment_revision},plans,views);
   return {region_id:r.id,snapshot_hash:r.snapshot_hash,bounds:r.bounds,loaded_bounds:b,positions:Object.keys(snap.blocks).length,
    unknown_chunks:r.unknown_chunks??[],unsupported_states:[...states].filter(s=>unsupported.has(s)),far_terrain_included:false,world_uuid:r.world_uuid,images,
    view:{iris:report,min_y:q.min_y,max_y:q.max_y,show_selection:q.show_selection,show_grid:!!q.show_grid,show_plans:!!q.show_plans,display_mode:q.display_mode??'scene'},
    planning_revision:q.show_plans?plans.revision:undefined,draft_id:r.draft_id,draft_revision:r.draft_revision,preview_mode:r.preview_mode,
    created_at:new Date().toISOString(),source:report?'workbench_iris_render':'workbench_webgl_render',minecraft_client_screenshot:false};
  }finally{
   localChunks.reset({chunks:[]},319);
   for(const helper of helpers){helper.geometry.dispose();helper.material.dispose();}
   staged.markerMaterial.dispose();
  }
 });
}
async function captureViewport(q){
 if(macro.active||!snapshot)throw Error('当前为地图，请使用地图截图');
 const r=region,snap=snapshot,viewSettings={...settings},pose=sceneView();
 return captureScope(async()=>{
  await renderQueue;
  if(lod.loading)await lod.loading;
  const plans=await api('planning_state');
  const viewCamera=captureCamera(q.width,q.height,snap.bounds,r.bounds,pose);
  const data={scene,lod,chunks,snapshot:snap,region:r,key:sceneKey()};
  const {images,report}=await exportViews({...q,...viewSettings},data,plans,[{...viewCamera,name:'当前完整实景'}]);
  return {images,region_id:r.panorama?undefined:r.id,snapshot_hash:r.snapshot_hash,world_uuid:r.world_uuid,world_revision:lod.info?.revision,
   bounds:snap.bounds,draft_id:r.draft_id,draft_revision:r.draft_revision,preview_mode:r.preview_mode,
   view:{...viewSettings,iris:report,includes_background:!!lod.meshes.size},planning_snapshot:plans,
   scene_geometry:{...(lod.atlas?lod.evidence():{tiles:[],models:{}}),representation:'minecraft_block_models_composite',
    local_region:r.panorama?undefined:{id:r.id,snapshot_hash:r.snapshot_hash,bounds:snap.bounds,context_included:!!snap.context_blocks,view:viewSettings}},
   created_at:new Date().toISOString(),source:'workbench_composite_render',minecraft_client_screenshot:false};
 });
}
const nonBlockingRequests=new Set(['scene_view','show','ui_diagnostics','planning_update']);
function planningLayoutDiagnostics(){
 const actionIds=['save-plan','delete-plan','plan-detail'];
 const actions=Object.fromEntries(actionIds.map(id=>{
  const button=$(id),rect=button.getBoundingClientRect();
  return [id,{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,height:rect.height}];
 }));
 return {viewport:[innerWidth,innerHeight],scale:devicePixelRatio,actions,
  heightHelp:$('plan-height-help').textContent,upperPlaceholder:$('plan-max-y').getAttribute('placeholder')};
}
let initialMapPending = !sessionStorage.getItem('terraweave-render-restore');
function restoreEditorSession(activateLast){
 setTimeout(()=>ui.restoreSession(activateLast).catch(error=>ui.say(String(error))),0);
}
async function poll(){
 if(polling)return;polling=true;
 try{
  const q=await invoke('workbench_poll');
  if (working) return;
  if (!q) {
   if (initialMapPending) {initialMapPending=false;await macro.open().catch(error=>ui.say(String(error)));restoreEditorSession(true);}
   return;
  }
  const initialiseSession=initialMapPending;
  const openOnShow=initialiseSession&&q.kind==='show';
  initialMapPending = false;
  working=true;sceneChanging=!nonBlockingRequests.has(q.kind);let response;
  try{
   let result;
   if(q.kind==='map')result=await macro.open();
   else if(q.kind==='ui_diagnostics'){const samples=[],pids=[];for(let i=0;i<6;i++){const start=performance.now(),data=await api('ui_snapshot');samples.push(performance.now()-start);pids.push(data.backend_pid);}result={samples_ms:samples,median_ms:[...samples].sort((a,b)=>a-b)[3],worker_processes:[...new Set(pids)]};
    if(q.inspect_layout)result.planning_layout=planningLayoutDiagnostics();
   }
   else if(q.kind==='scene_view')result=sceneView();
   else if(q.kind==='world_scene')result=await openPanorama(q);
   else if(q.kind==='capture_scene')result=await capturePanorama(q);
   else if(q.kind==='capture_viewport')result=await captureViewport(q);
   else if(q.kind==='planning_update'){await macro.refresh();result={planning_updated:true};}
   else if(q.kind==='draft_deleted')result=await ui.draftDeleted(q.draft_id);
   else if(q.kind==='capture_map')result=await macro.capture(q);
   else if(q.kind==='display')result=await display(q);
   else if(q.kind==='display_cached'){
    if(!macro.acceptsDetail(q.navigation_id))result={cancelled:true};
    else if(!snapshot||region?.snapshot_hash!==q.region.snapshot_hash)result={cache_miss:true};
    else result={...await display({...q,snapshot}),snapshot_reused:true};
   }
   else if(q.kind==='display_delta'){
    const delta=q.snapshot_delta;
    if(!macro.acceptsDetail(q.navigation_id))result={cancelled:true};
    else if(!snapshot||region?.snapshot_hash!==delta?.from_hash)result={cache_miss:true};
    else result={...await display({...q,snapshot:applySnapshotDelta(snapshot,delta)}),snapshot_delta_applied:true};
   }
   else if(q.kind==='select'){
    if(!snapshot||q.region.snapshot_hash!==region.snapshot_hash)throw Error('请先打开对应快照');
    region=q.region;markers();ui.setRegion(region);ui.setViewFields(settings);result=described();
   }else if(q.kind==='capture')result=await captures(q);
   else if(q.kind==='show'){await invoke('workbench_show');if(openOnShow)await macro.open().catch(error=>ui.say(String(error)));else await ui.refresh();result={shown:true,window_state:await invoke('workbench_window_action',{action:'state'})};}
   else throw Error('未知工作台请求');
   response={ok:true,result};
  }catch(e){response={ok:false,error:String(e)};ui.say(String(e));}
  finally{sceneChanging=false;}
  await invoke('workbench_complete',{id:q.id,result:response});
  if(initialiseSession)restoreEditorSession(openOnShow);
  if(!['scene_view','show','planning_update'].includes(q.kind)&&!response.result?.cache_miss&&!response.result?.cancelled)ui.refresh();
 }catch(e){ui.say('工作台连接错误：'+String(e));}
 finally{polling=false;working=false;}
}
setInterval(()=>{if(working)invoke('workbench_heartbeat').catch(()=>{});else poll();},50);
const ray=new THREE.Raycaster(),mouse=new THREE.Vector2();
const constructionPlane=new THREE.Plane(new THREE.Vector3(0,1,0)),constructionPoint=new THREE.Vector3();
function screenPosition(e){
 const rect=renderer.domElement.getBoundingClientRect();
 return [e.clientX-rect.left,e.clientY-rect.top,rect.width,rect.height];
}
function hit(e,pose=displayedCamera()){
 const [x,y,width,height]=screenPosition(e);
 if(!pose||!width||!height||x<0||x>width||y<0||y>height)return null;
 mouse.set(x/width*2-1,-y/height*2+1);
 pose.updateMatrixWorld();
 ray.setFromCamera(mouse,pose);
 const worldPoint=intersection=>intersection.point.toArray().map((n,i)=>n+snapshot.bounds[i]);
 const localHit=region.panorama?null:ray.intersectObjects(chunks.meshes(),false)[0];
 const previousFar=ray.far;
 try{
  ray.far=localHit?.distance??Infinity;
  for(const intersection of ray.intersectObjects(lod.meshList(),false)){
   if(localHit&&intersection.distance>=localHit.distance)break;
   const block=lod.hitBlock(intersection);
   const covered=!region.panorama&&block.coordinate.every((n,i)=>n>=snapshot.bounds[i]&&n<=snapshot.bounds[i+3]);
   if(!covered)return {...block,point:worldPoint(intersection),source:'saved_anvil'};
  }
 }finally{ray.far=previousFar;}
 if(localHit)return {coordinate:localHit.object.userData.ps[localHit.instanceId].k.split(',').map(Number),state:localHit.object.userData.s,normal:localHit.face.normal.toArray(),point:worldPoint(localHit),source:'local_snapshot'};
 if(!Number.isInteger(region.construction_y)||!grid?.visible)return null;
 constructionPlane.constant=snapshot.bounds[1]-region.construction_y;
 if(!ray.ray.intersectPlane(constructionPlane,constructionPoint))return null;
 const point=constructionPoint.toArray().map((n,i)=>n+snapshot.bounds[i]);
 const coordinate=[Math.floor(point[0]),region.construction_y,Math.floor(point[2])];
 if(!coordinate.every((n,i)=>n>=snapshot.bounds[i]&&n<=snapshot.bounds[i+3]))return null;
 return {point,coordinate,state:'minecraft:air',normal:[0,1,0],source:'construction_grid'};
}
let lastHover=0,primaryPointer;
const hover=$('hover');
function sceneTarget(hit){
 if(!hit)return null;
 return planningPoint(hit.point[0],hit.point[2],{
  height:hit.point[1]+.02,blockY:hit.coordinate[1],snap:getPlanSnap()
 });
}
function cancelSceneDrag(){
 const id=sceneDrag;
 sceneDrag=null;
 sceneSketch.cancelDrag();
 if(id!==null&&renderer.domElement.hasPointerCapture(id))renderer.domElement.releasePointerCapture(id);
}
function clearSceneSketch(){
 cancelSceneDrag();
 scenePointer=null;
 sceneSketch.reset();
 refreshPlanningControls();
 requestPlanOverlay();
}
renderer.domElement.addEventListener('pointermove',e=>{
 if(!region||sceneChanging||capturing||flyLook)return;
 if(planningTool()){
  scenePointer={clientX:e.clientX,clientY:e.clientY};
  requestPlanOverlay(true);
  return;
 }
 if(performance.now()-lastHover<90||document.body.classList.contains('fullscreen-preview'))return;
 lastHover=performance.now();
 const block=hit(e);
 hover.textContent=block?block.coordinate.join(', ')+'\n'+block.state:'';
});
renderer.domElement.addEventListener('pointerleave',()=>{
 hover.textContent='';
 scenePointer=null;
 sceneSketch.hover(null);
 requestPlanOverlay();
});
renderer.domElement.addEventListener('pointerdown',e=>{
 if(e.button===0)primaryPointer={clientX:e.clientX,clientY:e.clientY,timeStamp:e.timeStamp,planning:planningTool()};
 if(e.button!==0||e.altKey||tool==='orbit'||sceneChanging||capturing||!region)return;
 const pose=displayedCamera(),h=hit(e,pose);
 if(planningTool()){
  if(!pose){ui.say('等待当前视角完成渲染');return;}
  const screen=screenPosition(e),target=sceneTarget(h);
  const handle=planOverlay.handleAt(screen,sceneSketch.handles,pose,snapshot.bounds);
  if(!target&&handle===null){ui.say('请在可见的方块或水面上取点');return;}
  if(sceneSketch.start(target,screen,handle)){
   sceneDrag=e.pointerId;
   renderer.domElement.setPointerCapture(e.pointerId);
  }
  hover.textContent='';
  redrawSketch();
  return;
 }
 if(!h||(h.source==='construction_grid'&&tool==='erase'))return;
 ui.picked(h.coordinate,h.state);
 if(blockOutline){scene.remove(blockOutline);blockOutline.geometry.dispose();blockOutline.material.dispose();}const shape=new THREE.BoxGeometry(1.005,1.005,1.005);blockOutline=new THREE.LineSegments(new THREE.EdgesGeometry(shape),new THREE.LineBasicMaterial({color:0x65acff,depthTest:false}));shape.dispose();blockOutline.position.copy(local(h.coordinate.map(v=>v+.5)));scene.add(blockOutline);requestDraw();
 if(tool==='paint'||tool==='erase'){ui.paintAt(h,tool==='erase',e.shiftKey);return;}if(!marking)return;
 if(!corner){corner=h.coordinate;ui.say('第一个角 '+corner.join(', ')+'；请选择第二个角。');return;}
 const b=corner.map((n,i)=>Math.min(n,h.coordinate[i])).concat(corner.map((n,i)=>Math.max(n,h.coordinate[i])));corner=null;ui.saveBounds(b);
});
renderer.domElement.addEventListener('pointerup',e=>{
 if(sceneDrag!==e.pointerId)return;
 sceneDrag=null;
 const target=region&&!sceneChanging&&!capturing?sceneTarget(hit(e)):null;
 sceneSketch.finish(target,screenPosition(e));
 if(!target)ui.say('请在场景表面放置控制点');
 redrawSketch();
});
for(const event of ['pointercancel','lostpointercapture'])renderer.domElement.addEventListener(event,e=>{
 if(sceneDrag===e.pointerId){
  cancelSceneDrag();
  redrawSketch();
 }
});
renderer.domElement.addEventListener('pointerdown',e=>{controls.mouseButtons.LEFT=e.altKey||tool==='orbit'?THREE.MOUSE.ROTATE:null;controls.mouseButtons.RIGHT=e.shiftKey?THREE.MOUSE.PAN:THREE.MOUSE.ROTATE;},true);
renderer.domElement.addEventListener('contextmenu',e=>e.preventDefault());
renderer.domElement.addEventListener('dblclick',e=>{
 if(planningTool()||primaryPointer?.planning)return;
 if(e.button!==0||!region?.panorama||sceneChanging||capturing)return;
 // Pointer events retain subpixel coordinates on high-DPI displays.
 const recentPointer=primaryPointer&&e.timeStamp-primaryPointer.timeStamp<=500
  &&Math.abs(e.clientX-primaryPointer.clientX)<=1&&Math.abs(e.clientY-primaryPointer.clientY)<=1;
 const selected=hit(recentPointer?primaryPointer:e);
 if(!selected)return;
 const [x,y,z]=selected.coordinate;
 ui.run(()=>api('browse_world',{x,y,z,view_id:crypto.randomUUID(),plan_id:macro.getSelected()?.id,allow_saved:true}),'正在进入此位置的三维细化…');
});
document.addEventListener('keydown',e=>{
 if(e.defaultPrevented||document.querySelector('dialog[open]'))return;
 if(!e.target.closest('input,textarea,select,[contenteditable]')&&
  !e.ctrlKey&&!e.metaKey&&!e.altKey&&!capturing&&currentSketch().active&&['Enter','Escape'].includes(e.key)){
  if(e.key==='Enter'&&e.target.closest('button'))return;
  e.preventDefault();
  if(e.key==='Escape')cancelActiveSketch();
  else if(!e.repeat)void savePlanning();
  return;
 }
 if(capturing||macro.active||e.target.closest('input,textarea,select')||e.ctrlKey||e.metaKey)return;
 heldKeys.add(e.code);
 if(fly&&['KeyW','KeyS','KeyA','KeyD','Space','KeyC'].includes(e.code))e.preventDefault();
 if(e.key==='Escape')ui.toolChanged('select');
});
document.addEventListener('keyup',e=>heldKeys.delete(e.code));
window.addEventListener('blur',resetNavigation);
document.addEventListener('visibilitychange',()=>{if(document.hidden)resetNavigation();});
new ResizeObserver(()=>{if(!capturing)resizeViewport();}).observe(view);
for(const button of document.querySelectorAll('[data-display-mode]'))button.onclick=()=>{const edit=button.dataset.displayMode==='editor';$('grid').checked=edit;$('outline').checked=edit;setView({display_mode:button.dataset.displayMode,show_grid:edit,show_selection:edit});};
$('fly-toggle').onclick=()=>{if(capturing)return;resetNavigation();fly=!fly;cameraMode();ui.say(fly?'自由相机已开启 · 右键转头，WASD 移动，E/空格上升，Q/C 下降，Shift 加速':'环绕相机已开启');};
renderer.domElement.addEventListener('pointerdown',e=>{if(!capturing&&fly&&(e.button===2||e.button===1)){flyLook={x:e.clientX,y:e.clientY,mode:e.button===1?'pan':'look'};renderer.domElement.setPointerCapture(e.pointerId);}},true);
renderer.domElement.addEventListener('pointermove',e=>{if(capturing||!fly||!flyLook)return;const dx=e.clientX-flyLook.x,dy=e.clientY-flyLook.y;if(flyLook.mode==='pan'){const right=new THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion),up=new THREE.Vector3(0,1,0).applyQuaternion(camera.quaternion),move=right.multiplyScalar(-dx).addScaledVector(up,dy).multiplyScalar(moveSpeed()*.005);camera.position.add(move);controls.target.add(move);}else{const angles=new THREE.Euler().setFromQuaternion(camera.quaternion,'YXZ');angles.y-=dx*.004;angles.x=THREE.MathUtils.clamp(angles.x-dy*.004,-Math.PI/2+.01,Math.PI/2-.01);camera.quaternion.setFromEuler(angles);controls.target.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(24));}flyLook={...flyLook,x:e.clientX,y:e.clientY};});for(const event of ['pointerup','pointercancel','lostpointercapture'])renderer.domElement.addEventListener(event,()=>flyLook=null);
renderer.domElement.addEventListener('wheel',e=>{if(macro.active||capturing)return;e.preventDefault();e.stopImmediatePropagation();const sensitivity=$('wheel-sensitivity').value;if(fly){const move=camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(wheelTravel(e,sensitivity));camera.position.add(move);controls.target.add(move);}else{const offset=camera.position.clone().sub(controls.target),distance=offset.length(),next=THREE.MathUtils.clamp(distance*wheelZoomFactor(e,sensitivity),Math.max(.1,controls.minDistance),controls.maxDistance);if(distance)camera.position.copy(controls.target).addScaledVector(offset,next/distance);}},{capture:true,passive:false});
document.addEventListener('keydown',e=>{if(capturing&&!e.target.closest('input,textarea,select')){e.preventDefault();e.stopImmediatePropagation();return;}if(e.target.closest('#camera-x,#camera-y,#camera-z,#camera-yaw,#camera-pitch')&&e.key==='Enter'){e.preventDefault();e.stopImmediatePropagation();$('set-camera-angle').click();return;}if(capturing||!fly||macro.active||e.target.closest('input,textarea,select')||e.ctrlKey||e.metaKey)return;if(['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','KeyC','Space'].includes(e.code)){heldKeys.add(e.code);e.preventDefault();e.stopImmediatePropagation();}},true);
$('set-camera-angle').onclick=()=>{if(!region||capturing)return;resetNavigation();const values=cameraFields.map(id=>{const value=cameraDraft.has(id)?cameraDraft.get(id):$(id).value;return value.trim()===''?NaN:Number(value);});if(!values.every(Number.isFinite)){ui.say('相机坐标和角度必须为有效数字');return;}const yaw=THREE.MathUtils.degToRad(values[3]),pitch=THREE.MathUtils.degToRad(THREE.MathUtils.clamp(values[4],-89.9,89.9)),direction=new THREE.Vector3(Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch));const damping=controls.enableDamping;controls.enableDamping=false;controls.update();controls.enableDamping=damping;camera.position.copy(local(values.slice(0,3)));controls.target.copy(camera.position).addScaledVector(direction,24);camera.up.set(0,1,0);camera.lookAt(controls.target);syncCameraFields(true);ui.say('已应用相机位置与朝向');};
function surfaceHeight(x,z){
 const bounds=snapshot?.bounds;
 if(!region||!bounds)return null;
 const ix=Math.floor(x),iz=Math.floor(z);
 const isLocal=!region.panorama&&ix>=bounds[0]&&ix<=bounds[3]&&iz>=bounds[2]&&iz<=bounds[5];
 const limits=isLocal?bounds:lod.info?.bounds;
 if(!limits)return null;
 for(let y=limits[4];y>=limits[1];y--){
  const block=isLocal?snapshot.blocks[[ix,y,iz].join(',')]:lod.stateAt(ix,y,iz);
  if(block&&!/^minecraft:(air|cave_air|void_air|barrier|structure_void|light)(\[|$)/.test(block))return y;
 }
 return null;
}
function updatePlanningOverlay(){
 const bounds=snapshot?.bounds;
 const key=[region?.id,geometryBuilds,lod.signature,lod.meshes.size].join(':');
 const height=(x,z)=>surfaceHeight(x,z)??region.surface_y??bounds[1];
 if(planOverlay.update(macro.getState(),!!bounds&&settings.show_plans,height,key))requestPlanOverlay();
}
function drawPlanningOverlay(){
 const pose=displayedCamera();
 const y=coordinatePin?.height??(coordinatePin?surfaceHeight(coordinatePin.x,coordinatePin.z):null);
 const pin=y===null?null:{...coordinatePin,height:coordinatePin.height??y+1.02,blockY:coordinatePin.blockY??y};
 planOverlay.draw(pose,snapshot?.bounds,sceneSketch.preview(),sceneSketch.cursor,pin);
}
function updatePlanningTarget(now){
 if(!planTargetDirty||now-lastPlanHover<30)return;
 planTargetDirty=false;
 lastPlanHover=now;
 const block=sceneSketch.active&&scenePointer&&region&&!flyLook&&!sceneChanging?hit(scenePointer):null;
 sceneSketch.hover(sceneTarget(block));
 refreshPlanningControls();
 requestPlanOverlay();
}
let lastSessionPersist=0;
renderer.setAnimationLoop(()=>{
 const now=performance.now(),delta=Math.min(.1,(now-lastFrame)/1000);lastFrame=now;if(capturing||macro.active)return;
 if(fly&&region&&heldKeys.size){const direction=camera.getWorldDirection(new THREE.Vector3()),side=new THREE.Vector3().crossVectors(direction,camera.up).normalize(),move=new THREE.Vector3(),speed=delta*moveSpeed()*(heldKeys.has('ShiftLeft')||heldKeys.has('ShiftRight')?4:1);if(heldKeys.has('KeyW'))move.add(direction);if(heldKeys.has('KeyS'))move.sub(direction);if(heldKeys.has('KeyD'))move.add(side);if(heldKeys.has('KeyA'))move.sub(side);if(heldKeys.has('Space')||heldKeys.has('KeyE'))move.y++;if(heldKeys.has('KeyC')||heldKeys.has('KeyQ'))move.y--;if(move.lengthSq())move.normalize().multiplyScalar(speed);camera.position.add(move);controls.target.add(move);}
 if(!fly)controls.update();
 updatePlanningOverlay();
 const cameraChanged=drawnPosition.distanceToSquared(camera.position)>1e-12||1-Math.abs(drawnRotation.dot(camera.quaternion))>1e-12;
 if(cameraChanged&&region&&now-lastSessionPersist>350){lastSessionPersist=now;ui.recovery.schedule();}
 scheduleVolumeRefresh(now,cameraChanged);
 if(needsDraw||cameraChanged){
  camera.far=Math.max(5000,camera.position.distanceTo(controls.target)*4+1024);
  camera.updateProjectionMatrix();
  requestPlanOverlay(!usesIris());
  drawViewport();
  viewportFrames++;
  drawnPosition.copy(camera.position);
  drawnRotation.copy(camera.quaternion);
  needsDraw=false;
  needsCameraSync=true;
 }else if(usesIris()&&iris.shouldAnimate(now)){drawViewport();viewportFrames++;}
 updatePlanningTarget(now);
 if(planOverlayDirty){planOverlayDirty=false;drawPlanningOverlay();}
 if(needsCameraSync&&now-lastAngles>250){lastAngles=now;syncCameraFields();needsCameraSync=false;}
});
api('render_settings').then(config=>{
 iris.configure(config.shader);
 requestDraw();
}).catch(()=>{});
const renderRestore=sessionStorage.getItem('terraweave-render-restore');
if(renderRestore){
 sessionStorage.removeItem('terraweave-render-restore');
 const pose=JSON.parse(renderRestore);
 (async()=>{
  if(pose.mode==='map'||pose.mode==='empty')return macro.open(pose.view);
  if(pose.panoramic)await api('open_world_scene',{view_id:pose.view_id,label:pose.label});
  else if(pose.region_id)await api('open_region',{region_id:pose.region_id});
  applySceneCamera(pose);requestDraw();
 })().catch(error=>ui.say(String(error))).finally(()=>restoreEditorSession(false));
}
