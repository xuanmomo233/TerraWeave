import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {PROJECT,ROOT,TOOLS,callTool,loadRegionData} from './creative-workbench.mjs';
import {PLANNING_TOOLS,planningService} from './planning-service.mjs';
import {mapService} from './map-service.mjs';
import {snapshotBytes} from './project-store.mjs';
import {snapshotDelta} from '../snapshot-delta.js';
import {savedRenderContext} from './render-context.mjs';
const snapshotHash=snapshot=>createHash('sha256').update(snapshotBytes(snapshot)).digest('hex');

const {chromium}=await import(pathToFileURL(process.env.TERRAWEAVE_PLAYWRIGHT??'C:/Users/杨骋达/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const out=process.env.TERRAWEAVE_UI_QA_OUTPUT??'D:/IDEA/project/.codex-tmp/terraweave-map-qa';fs.mkdirSync(out,{recursive:true});
const original=await callTool('planning_state'),fixture=path.join(out,'planning-fixture');fs.mkdirSync(fixture,{recursive:true});fs.writeFileSync(path.join(fixture,'planning.json'),JSON.stringify({...original,undo:[],redo:[]}));
const planner=planningService(fixture,()=>[],()=>original.world_uuid),rr=await callTool('list_regions'),local=loadRegionData(rr.find(r=>r.label==='客栈规划区域')?.id??rr[0].id);
if(!local.snapshot.context_blocks){
 local.snapshot.context_blocks=savedRenderContext(local.snapshot.bounds);
 local.region.snapshot_hash=snapshotHash(local.snapshot);
}
const anchorName='界面验收锚点',anchorLayer=planner.read().layers[0]?.id??planner.execute('create_layer',{name:'界面验收图层'}).layers.at(-1).id,anchorBounds=local.region.bounds;planner.execute('save_plan',{type:'area',name:anchorName,layer_id:anchorLayer,points:[[anchorBounds[0],anchorBounds[2]],[anchorBounds[3]+1,anchorBounds[2]],[anchorBounds[3]+1,anchorBounds[5]+1],[anchorBounds[0],anchorBounds[5]+1]],min_y:anchorBounds[1],max_y:anchorBounds[4]});
planner.execute('select_plan',{});
const draftFixture=new Map([
 ['qa-independent',{id:'qa-independent',label:'独立方案验收',plan_id:null}],
 ['qa-attached',{id:'qa-attached',label:'关联方案验收',plan_id:planner.read().objects.find(p=>p.name===anchorName).id}]
].map(([id,d])=>[id,{...d,revision:1,visible:true,design_visible:true,changed_positions:0,undo_count:0,redo_count:0,counts:{added:0,replaced:0,removed:0}}]));
const savedViews=new Map(),viewSnapshots=new Map();
let testHeightNavigation=false;
const fixtureMap=mapService({
 root:fixture,planning:planner,serverStatus:()=>({running:false}),
 startServer:()=>{throw Error('The UI fixture must stay offline');},
 serverRequest:()=>{throw Error('The UI fixture must stay offline');},
 saveSnapshot(snapshot){
  const hash=snapshotHash(snapshot);
  viewSnapshots.set(hash,snapshot);
  return {snapshot_id:hash,snapshot_hash:hash};
 },
 savePreview:region=>savedViews.set(region.id,region),
 displayRegion:(region,kind,navigation_id)=>send({kind,region,navigation_id,snapshot:viewSnapshots.get(region.snapshot_id)})
});
let job={id:'qa-map',kind:'map'},completion,reply,view,sequence=0,barrierWait=null,modelReads=0,clipboardText='',selectionDelay=0,browseReads=0,fullscreen=false,sceneAckHold,detailWait;const captures=[],openedPackFolders=[];
const pickedDirectories=[path.join(fixture,'带空格的 存档'),null];
async function send(request){job={id:'qa-'+(++sequence),...request};return new Promise(resolve=>completion=resolve);}
async function bridge(command,args){
 if(command==='pick_world_directory')return pickedDirectories.shift()??null;
 if(command==='workbench_poll')return job;
 if(command==='workbench_heartbeat'||command==='workbench_show')return null;
 if(command==='workbench_window_action'){
  if(args.action==='enter-fullscreen')fullscreen=true;
  if(args.action==='exit-fullscreen')fullscreen=false;
  return {decorated:false,maximized:true,fullscreen};
 }
 if(command==='workbench_clipboard'){if(args.text!==undefined){clipboardText=args.text;return '';}return clipboardText;}
 if(command==='open_pack_folder'){assert.ok(['resourcepacks','shaderpacks'].includes(args.kind));openedPackFolders.push(args.kind);return null;}
 if(command==='read_asset'){if(args.name.endsWith('item/barrier.png')&&barrierWait)await barrierWait;const file=path.resolve(PROJECT,'assets',args.name);if(!file.startsWith(path.join(PROJECT,'assets')+path.sep))throw Error('Invalid fixture asset');const bytes=fs.readFileSync(file);return args.name.endsWith('.png')?'data:image/png;base64,'+bytes.toString('base64'):bytes.toString('utf8');}
 if(command==='workbench_read_image'){const own=captures.find(c=>c.capture_id===args.captureId);if(own)return 'data:image/png;base64,'+fs.readFileSync(own.images[args.index].path).toString('base64');const c=await callTool('read_capture',{capture_id:args.captureId});return 'data:image/png;base64,'+fs.readFileSync(c.images[args.index].path).toString('base64');}
 if(command==='workbench_complete'){
  reply=args.result;const request=job;job=null;const result={...request?.region,...args.result.result,desktop_acknowledged:true};
  if(result.images?.[0]?.data_url){const dir=path.join(out,request.id);fs.mkdirSync(dir,{recursive:true});result.images=result.images.map((img,i)=>{const file=path.join(dir,'view-'+i+'.png');fs.writeFileSync(file,Buffer.from(img.data_url.split(',')[1],'base64'));return {...img,data_url:undefined,path:file,width:request.width,height:request.height};});result.capture_id=request.id;captures.unshift({...result,scene_geometry:undefined});}
  completion?.(result);completion=null;
  if(request.kind==='scene_view'&&sceneAckHold)await sceneAckHold;
  return null;
 }
 if(command!=='workbench_call')throw Error('Unsupported fixture command '+command);
 const {tool,args:input={}}=args;
 if(tool==='render_settings'){
  const settings=await callTool(tool,input);
  const newShader={id:'验收光影.zip',name:'验收光影.zip',format:'iris_zip',supported:true};
  const unsupported={id:'不兼容验收.zip',name:'不兼容验收.zip',supported:false,issues:['缺少测试合成阶段']};
  return {...settings,shader:'off',
   packs:openedPackFolders.includes('resourcepacks')?[...settings.packs,'验收材质包.zip']:settings.packs,
   shaders:[...settings.shaders,unsupported,...(openedPackFolders.includes('shaderpacks')?[newShader]:[])]};
 }
 if(tool==='ui_snapshot'){const data=await callTool(tool,input);return {...data,drafts:[...draftFixture.values(),...data.drafts],planning:planner.execute('planning_state',{}),captures:[...captures,...data.captures]};}
 if(draftFixture.has(input.draft_id)){
  const d=draftFixture.get(input.draft_id);
  if(tool==='update_draft'){
   if(input.label!==undefined)d.label=input.label;
   if(input.visible!==undefined)d.visible=d.design_visible=input.visible;
   d.revision++;
   return d;
  }
  if(tool==='delete_draft'){draftFixture.delete(d.id);return {id:d.id,deleted:true};}
  if(tool==='preview_draft'){
   const camera=input.keep_camera?await send({kind:'scene_view'}):undefined;
   return send({kind:'display',camera,snapshot:local.snapshot,region:{...local.region,id:d.id+'-'+d.revision,
    label:d.label,source:'design_draft',draft_id:d.id,draft_revision:d.revision,preview_mode:'target',design_visible:d.design_visible}});
  }
 }
 if(tool==='select_plan'&&selectionDelay)await new Promise(resolve=>setTimeout(resolve,selectionDelay));
 if(PLANNING_TOOLS.some(t=>t.name===tool))return planner.execute(tool,input);
 if(tool==='world_map_info')return {...await callTool(tool,input),view};
 if(tool==='save_map_view'){view=input.view;return view;}
 if(tool==='list_captures')return [...captures,...await callTool(tool,input)];
 if(tool==='get_scene_view')return send({kind:'scene_view'});
 if(tool==='capture_current_view')return send({kind:'capture_viewport',width:input.width??1280,height:input.height??800});
 if(tool==='preview_draft'&&input.draft_id==='qa-missing-draft')throw Error('草稿已删除或不存在');
 if(tool==='world_model_tile')modelReads++;
 if(TOOLS.find(t=>t.name===tool)?.annotations?.readOnlyHint)return callTool(tool,input);
 if(tool==='open_map')return send({kind:'map'});
 if(tool==='open_world_scene')return send({kind:'world_scene',scene:await callTool('world_scene_info'),view_id:input.view_id,label:input.label});
 if(tool==='open_region'&&savedViews.has(input.region_id)){
  const region=savedViews.get(input.region_id);
  return send({kind:'display',region,snapshot:viewSnapshots.get(region.snapshot_id)});
 }
 if(tool==='get_scene_view')return send({kind:'scene_view'});
 if(tool==='capture_world_scene')return send({kind:'capture_scene',scene:await callTool('world_scene_info'),width:input.width??1280,height:input.height??800,angles:input.angles??[],views:input.views??[],current_view:input.angles===undefined&&input.views===undefined,show_plans:input.show_plans??false,show_invisible:input.show_invisible??false,planning_revision:planner.read().revision});
 if(tool==='open_plan_detail'||tool==='browse_world'){
  browseReads++;
  if(detailWait)await detailWait;
  if(testHeightNavigation)return fixtureMap.execute(tool,input);
  return send({kind:'display',navigation_id:input.navigation_id,region:{...local.region,id:'qa-world-detail',transient:true,detail_for_plan_id:input.plan_id,label:'三维场景'},snapshot:local.snapshot});
 }
 if(tool==='capture_map')return send({kind:'capture_map',width:input.width??1280,height:input.height??800,view:input.view??view??{x:0,z:0,scale:4,rotation:0},planning_revision:planner.read().revision});
 throw Error('UI QA forbids real project/world mutation: '+tool);
}
const server=http.createServer(async(req,res)=>{
 try{const url=new URL(req.url,'http://localhost');if(url.pathname==='/__bridge'){let body='';for await(const b of req)body+=b;const q=JSON.parse(body);let result;try{result={result:await bridge(q.command,q.args??{})};}catch(e){result={error:e.message};}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;}
 const file=path.resolve(PROJECT,'dist','.'+(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(path.join(PROJECT,'dist')+path.sep))throw Error('Invalid route');let bytes=fs.readFileSync(file);
 if(file.endsWith('index.html'))bytes=Buffer.from(bytes.toString('utf8').replace('<meta charset=',`<script>window.__TAURI_INTERNALS__={invoke:async(command,args)=>{const r=await fetch('/__bridge',{method:'POST',body:JSON.stringify({command,args})}).then(r=>r.json());if(r.error)throw Error(r.error);if(command==='workbench_complete')window.__qaComplete=(window.__qaComplete||0)+1;return r.result;}};</script><meta charset=`));
 res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':'text/javascript');res.end(bytes);
 }catch(e){res.statusCode=404;res.end(e.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-networking']});
 const deviceScaleFactor=Number(process.env.TERRAWEAVE_QA_DPR??1.5),page=await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.__qaComplete>=1,{},{timeout:60000});if(reply?.ok!==true)throw Error(reply?.error??'Map failed to open');
 await page.waitForFunction(()=>document.querySelector('#map-loading').hidden,{},{timeout:90000});
 assert.equal(await page.locator('#window-titlebar').getByText('已连接存档').count(),0);
 await page.locator('[data-menu="file"]').click();
 assert.ok(await page.getByRole('menuitem',{name:/关闭当前标签页/}).isDisabled());
 const fileCommands=await page.getByRole('menuitem').allTextContents();
 assert.ok(fileCommands.every(label=>!/(?:…|\.\.\.)/.test(label)),'File menu commands should use plain labels');
 await page.keyboard.press('Escape');
 await page.locator('[data-menu="file"]').press('ArrowDown');
 assert.equal(await page.locator(':focus').innerText(),'切换工程');
 await page.keyboard.press('ArrowDown');
 assert.equal(await page.locator(':focus').innerText(),'新建工程');
 await page.keyboard.press('Escape');
 assert.equal(await page.locator(':focus').getAttribute('data-menu'),'file');
 await page.locator('[data-menu="file"]').click();
 await page.getByRole('menuitem',{name:'在新工程打开存档'}).click();
 const projectDirectory=page.locator('#create-project-path');
 const browseDirectory=page.locator('#create-project-dialog').getByRole('button',{name:'浏览存档目录'});
 await browseDirectory.click();
 await page.waitForFunction(()=>document.querySelector('#create-project-path').value.endsWith('带空格的 存档'));
 await browseDirectory.click();
 await page.waitForFunction(()=>!document.querySelector('[data-world-folder-for="create-project-path"]').disabled);
 assert.equal(await projectDirectory.inputValue(),path.join(fixture,'带空格的 存档'));
 await projectDirectory.click({button:'right'});
 assert.ok(await page.locator('#create-project-dialog #menu-popup').isVisible());
 await page.keyboard.press('Escape');
 assert.ok(await page.locator('#create-project-dialog').isVisible());
 await page.locator('#create-project-cancel').click();
 for(const id of ['create-project-dialog','new-world-dialog','world-source-dialog','new-region-dialog',
  'render-settings-dialog','locate-position-dialog','draft-action-dialog','map-height-dialog','appearance-dialog']){
  const dialog=page.locator('#'+id);
  await dialog.evaluate(element=>element.showModal());
  const bounds=await dialog.locator('.dialog-actions > button:visible').evaluateAll(buttons=>buttons.map(button=>{
   const {top,bottom}=button.getBoundingClientRect();
   return {label:button.textContent,top,bottom};
  }));
  assert.ok(bounds.length>1);
  for(const {top,bottom,label} of bounds.slice(1)){
   assert.ok(Math.abs(top-bounds[0].top)<.1&&Math.abs(bottom-bounds[0].bottom)<.1,
    id+' · '+label+' 与 '+bounds[0].label+' 的边缘应对齐');
  }
  await dialog.evaluate(element=>element.close());
 }
 const center = page.locator('.center-workspace');
 const openAppearance = async () => {
  await page.locator('[data-menu="view"]').click();
  await page.getByRole('menuitem',{name:'外观与主题'}).click();
 };
 await openAppearance();
 await page.locator('[data-preset="paper"]').click();
 await page.locator('.theme-surfaces summary').click();
 await page.locator('[data-color="accent"]').fill('#196b62');
 await page.locator('#appearance-size').press('End');
 await page.locator('#appearance-size').press('ArrowLeft');
 await page.locator('[data-hex="text"]').fill('#242a31');
 await page.locator('#appearance-save').click();
 const storedAppearance = await page.evaluate(()=>JSON.parse(localStorage.getItem('terraweave.appearance.v2')));
 assert.equal(storedAppearance.colors.accent,'#196b62');
 assert.equal(storedAppearance.fontSize,17);
 assert.equal(storedAppearance.colors.text,'#242a31');
 assert.ok(!Object.hasOwn(storedAppearance,'image'));
 await openAppearance();
 await page.locator('[data-preset="midnight"]').click();
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>!document.querySelector('#appearance-dialog').open
  && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()==='#196b62');
 await openAppearance();
 await page.locator('[data-preset="atlas"]').click();
 await page.locator('#appearance-reset').click();
 await page.locator('#appearance-save').click();
 const lookCanvas=page.locator('#map-canvas'), mapLookBox=await lookCanvas.boundingBox();
 await page.mouse.move(mapLookBox.x+mapLookBox.width/2,mapLookBox.y+mapLookBox.height/2);
 const initialAngle=Number(await page.locator('#map-angle').inputValue());
 await page.mouse.down({button:'right'});
 await page.waitForFunction(()=>document.pointerLockElement===document.querySelector('#map-canvas'));
 await page.mouse.move(mapLookBox.x+mapLookBox.width/2+35,mapLookBox.y+mapLookBox.height/2,{steps:3});
 await page.mouse.up({button:'right'});
 await page.waitForFunction(()=>!document.pointerLockElement);
 assert.notEqual(Number(await page.locator('#map-angle').inputValue()),initialAngle);
 await page.locator('#map-angle').fill(String(initialAngle));
 await page.locator('#map-angle').dispatchEvent('change');
 const canvasHeight = () => page.locator('#map-canvas').evaluate(canvas => canvas.clientHeight);
 const fullHeight = await canvasHeight();
 assert.ok(await center.evaluate(el => el.classList.contains('drawer-closed')));
 for (const name of ['history', 'gallery', 'versions']) {
  const button = center.locator('[data-dock="' + name + '"]');
  await button.click();
  assert.equal(await button.getAttribute('aria-expanded'), 'true');
  assert.ok(await center.locator('[data-dock-pane="' + name + '"]').isVisible());
  assert.ok(await canvasHeight() < fullHeight);
  await button.click();
  assert.equal(await canvasHeight(), fullHeight);
 }
 const mapBeforeExports=await send({kind:'scene_view'});
 await send({kind:'capture',region:{...local.region,id:'qa-detached-capture'},snapshot:local.snapshot,
  width:800,height:600,angles:['isometric'],min_y:local.snapshot.bounds[1],max_y:local.snapshot.bounds[4],
  show_plans:false,show_invisible:false,display_mode:'scene'});
 assert.equal(reply.ok,true,reply.error);
 assert.deepEqual((await send({kind:'scene_view'})).view,mapBeforeExports.view);
 const initialScene=await callTool('world_scene_info');
 await send({kind:'capture_scene',scene:initialScene,width:800,height:600,angles:['top'],views:[],current_view:false,
  show_plans:true,planning_revision:planner.read().revision+1});
 assert.equal(reply.ok,false);
 assert.match(reply.error,/规划已变化/);
 assert.equal((await send({kind:'scene_view'})).mode,'map');
 await page.screenshot({path:path.join(out,'world-overview.png')});
 const screenButton=page.locator('#preview-fullscreen'),viewBox=()=>page.locator('#view').boundingBox();
 const waitForFullscreen=active=>page.waitForFunction(active=>document.body.classList.contains('fullscreen-preview')===active,active);
 async function checkFullscreen(canvas){
  await waitForFullscreen(true);
  assert.equal(fullscreen,true);
  assert.deepEqual(await viewBox(),{x:0,y:0,...page.viewportSize()});
  assert.deepEqual(await page.locator(canvas).boundingBox(),await viewBox());
  for(const selector of ['.menu-bar','.properties-panel','.bottom-dock'])assert.equal(await page.locator(selector).isHidden(),true);
  assert.equal(await screenButton.getAttribute('aria-label'),'退出全屏');
 }
 const mapSize=await viewBox(),mapPose=(await send({kind:'scene_view'})).view;
 await screenButton.click();
 await checkFullscreen('#map-canvas');
 await page.keyboard.press('Escape');
 await waitForFullscreen(false);
 assert.equal(fullscreen,false);
 assert.deepEqual(await viewBox(),mapSize);
 assert.deepEqual((await send({kind:'scene_view'})).view,mapPose);
 assert.equal(await page.locator('#render-settings-button,#preview-lighting').count(),0);
 await page.locator('[data-menu="view"]').click();
 await page.getByRole('menuitem',{name:'渲染设置',exact:true}).click();
 const renderDialog=page.locator('#render-settings-dialog');
 await renderDialog.waitFor({state:'visible'});
 await page.waitForFunction(()=>!document.querySelector('#render-settings-save').disabled);
 const shaderSelect=page.locator('#render-shader');
 assert.equal(await shaderSelect.inputValue(),'off');
 const shaderIds=await shaderSelect.locator('option').evaluateAll(options=>options.map(option=>option.value));
 assert.ok(shaderIds.length>=2&&shaderIds.slice(1).every(value=>value.endsWith('.zip')));
 await shaderSelect.selectOption(shaderIds[1]);
 for(const kind of ['resourcepacks','shaderpacks']){
  await Promise.all([
   page.waitForResponse(response=>response.url().endsWith('/__bridge')&&
    response.request().postDataJSON().command==='open_pack_folder'),
   page.locator('#open-'+kind).click()
  ]);
 }
 assert.deepEqual(openedPackFolders,['resourcepacks','shaderpacks']);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await page.locator('#render-pack-list').getByText('验收材质包.zip',{exact:true}).waitFor();
 const packRows=await page.locator('#render-pack-list li').evaluateAll(rows=>rows.map(row=>{
  const name=row.querySelector('.render-pack-name').getBoundingClientRect();
  const actions=row.querySelector('.render-pack-actions').getBoundingClientRect();
  return actions.top>=name.bottom+7.9;
 }));
 assert.ok(packRows.length&&packRows.every(Boolean),'Pack names and actions should have separate rows');
 const incompatibleOption=shaderSelect.locator('option[value="不兼容验收.zip"]');
 assert.equal(await incompatibleOption.evaluate(option=>option.disabled),true);
 assert.equal(await incompatibleOption.textContent(),'不兼容验收.zip（不兼容）');
 await page.locator('#shader-compatibility summary').click();
 assert.ok(await page.locator('#shader-compatibility').getByText('缺少测试合成阶段',{exact:true}).isVisible());
 await page.locator('#shader-compatibility summary').click();
 await renderDialog.screenshot({path:path.join(out,'render-pack-actions.png'),scale:'css'});
 assert.ok(await shaderSelect.locator('option[value="验收光影.zip"]').count());
 assert.equal(await shaderSelect.inputValue(),shaderIds[1]);
 await page.locator('#render-settings-close').click();
 await renderDialog.waitFor({state:'hidden'});
 await page.locator('#enter-3d').click();await page.waitForFunction(()=>document.querySelector('#source-state').textContent==='存档全景三维'&&document.querySelector('#scene-loading').hidden,{},{timeout:120000});
 await page.waitForTimeout(300);await page.screenshot({path:path.join(out,'world-panorama.png')});
 assert.equal(await page.locator('#fly-toggle').textContent(),'自由相机');for(const [id,value]of Object.entries({'camera-x':'120','camera-y':'88','camera-z':'-160','camera-yaw':'123.45','camera-pitch':'-17.25'}))await page.locator('#'+id).fill(value);await page.locator('#set-camera-angle').focus();await page.waitForTimeout(1100);assert.equal(await page.locator('#camera-yaw').inputValue(),'123.45');await page.locator('#set-camera-angle').click();const appliedPose=await send({kind:'scene_view'});assert.equal(appliedPose.mode,'free');assert.ok(Math.abs(appliedPose.yaw-123.45)<.001);assert.ok(Math.abs(appliedPose.pitch+17.25)<.001);assert.deepEqual(appliedPose.position,[120,88,-160]);
 const sceneSize=await viewBox(),readsBeforeFullscreen=modelReads;
 await page.keyboard.press('F11');
 await checkFullscreen('#view>canvas:first-child');
 const fullscreenPose=await send({kind:'scene_view'});
 assert.deepEqual(fullscreenPose.position,appliedPose.position);
 assert.deepEqual(fullscreenPose.target,appliedPose.target);
 assert.ok(Math.abs(fullscreenPose.width/fullscreenPose.height-page.viewportSize().width/page.viewportSize().height)<.001);
 assert.ok(fullscreenPose.render_stats.viewport_frames>appliedPose.render_stats.viewport_frames);
 await page.waitForTimeout(400);
 const idlePose=await send({kind:'scene_view'});
 assert.equal(idlePose.render_stats.viewport_frames,fullscreenPose.render_stats.viewport_frames);
 await screenButton.click();
 await waitForFullscreen(false);
 assert.equal(fullscreen,false);
 assert.deepEqual(await viewBox(),sceneSize);
 assert.equal(modelReads,readsBeforeFullscreen);
 await page.keyboard.down('w');await page.waitForTimeout(350);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.keyboard.up('w');const movedPose=await send({kind:'scene_view'});assert.ok(Math.hypot(...movedPose.position.map((n,i)=>n-appliedPose.position[i]))>1);const lookBox=await page.locator('#view').boundingBox();await page.mouse.move(lookBox.x+lookBox.width*.6,lookBox.y+lookBox.height*.5);await page.mouse.down({button:'right'});await page.mouse.move(lookBox.x+lookBox.width*.6+60,lookBox.y+lookBox.height*.5-20,{steps:8});await page.mouse.up({button:'right'});const lookedPose=await send({kind:'scene_view'});assert.ok(Math.abs(lookedPose.yaw-movedPose.yaw)>1);assert.ok(Math.hypot(...lookedPose.position.map((n,i)=>n-movedPose.position[i]))<.001);
 await page.mouse.down({button:'right'});await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.mouse.move(lookBox.x+lookBox.width*.6+90,lookBox.y+lookBox.height*.5,{steps:4});await page.mouse.up({button:'right'});const afterBlur=await send({kind:'scene_view'});assert.ok(Math.abs(afterBlur.yaw-lookedPose.yaw)<.001);
 await page.mouse.wheel(0,100);const normalWheelPose=await send({kind:'scene_view'}),travel=Math.hypot(...normalWheelPose.position.map((n,i)=>n-lookedPose.position[i]));assert.ok(travel>0&&travel<1);await page.mouse.wheel(0,100000);const burstWheelPose=await send({kind:'scene_view'});assert.ok(Math.hypot(...burstWheelPose.position.map((n,i)=>n-normalWheelPose.position[i]))<1.5);
 await page.locator('#wheel-sensitivity').fill('5');await page.locator('#wheel-sensitivity').dispatchEvent('change');await page.mouse.move(lookBox.x+lookBox.width*.5,lookBox.y+lookBox.height*.5);await page.mouse.wheel(0,100);const fineWheelPose=await send({kind:'scene_view'});assert.ok(Math.hypot(...fineWheelPose.position.map((n,i)=>n-burstWheelPose.position[i]))<travel);
 await page.locator('#fly-toggle').click();
 const orbitBefore=await send({kind:'scene_view'});
 await page.mouse.move(lookBox.x+lookBox.width*.5,lookBox.y+lookBox.height*.5);
 await page.mouse.wheel(0,100000);
 const orbitAfter=await send({kind:'scene_view'}),radius=p=>Math.hypot(...p.position.map((n,i)=>n-p.target[i]));
 assert.ok(Math.hypot(...orbitAfter.target.map((n,i)=>n-orbitBefore.target[i]))<1e-6);
 assert.ok(radius(orbitAfter)/radius(orbitBefore)>1&&radius(orbitAfter)/radius(orbitBefore)<1.1);
 await page.locator('#fly-toggle').click();
 const photoPose=await send({kind:'scene_view'});
 await page.locator('#capture').click();await page.waitForFunction(()=>!document.querySelector('[data-dock-pane="gallery"]').hidden&&document.querySelector('#gallery img'));const currentImage=captures[0];assert.equal(currentImage.images[0].name,'当前完整实景');assert.deepEqual(currentImage.images[0].camera.position,photoPose.position);assert.equal(currentImage.view.includes_background,true);
 const photoViewport=page.viewportSize();
 const photoFont=await page.locator('html').evaluate(root=>root.style.getPropertyValue('--ui-size'));
 await page.setViewportSize({width:1040,height:680});
 await page.locator('html').evaluate(root=>root.style.setProperty('--ui-size','18px'));
 await page.locator('#gallery button').first().click();
 await page.waitForFunction(()=>document.querySelector('#large-image').naturalWidth>0);
 assert.ok(await page.locator('#image-dialog').evaluate(dialog=>
  dialog.scrollHeight<=dialog.clientHeight+1&&dialog.scrollWidth<=dialog.clientWidth+1));
 await page.locator('#image-dialog').screenshot({path:path.join(out,'fitted-preview.png'),scale:'css'});
 await page.locator('#close-image').click();
 assert.equal(await page.locator(':focus').getAttribute('aria-label'),await page.locator('#gallery button').first().getAttribute('aria-label'));
 await page.setViewportSize(photoViewport);
 await page.locator('html').evaluate((root,font)=>root.style.setProperty('--ui-size',font),photoFont);
 const scene=await callTool('world_scene_info'),panorama=await send({kind:'capture_scene',scene,width:1280,height:800,angles:['isometric','south','top'],views:[],show_plans:false,planning_revision:planner.read().revision});assert.equal(reply.ok,true);assert.equal(panorama.images.length,3);assert.ok(panorama.scene_geometry.tiles.length);assert.equal(panorama.world_revision,scene.revision);assert.equal(panorama.scene_geometry.representation,'minecraft_block_models');assert.ok(Object.keys(panorama.scene_geometry.models).length>100);assert.ok(panorama.scene_geometry.atlas_png.startsWith('data:image/png;base64,'));assert.ok(panorama.scene_geometry.tiles.some(t=>t.groups.some(g=>g.state.includes('sugar_cane'))));
 const {PerspectiveCamera,Vector3}=await import('three');
 const lakePose={mode:'free',world_uuid:scene.world_uuid,position:[49,92,14],target:[49,59,14],up:[0,0,-1]};
 await send({kind:'world_scene',scene,camera:lakePose});
 const planView=await viewBox(),lakeCamera=new PerspectiveCamera(50,planView.width/planView.height,.1,5000);
 lakeCamera.position.fromArray(lakePose.position);lakeCamera.up.fromArray(lakePose.up);lakeCamera.lookAt(...lakePose.target);lakeCamera.updateMatrixWorld();
 function waterPoint(x,z){
  const p=new Vector3(x,59+8/9,z).project(lakeCamera);
  return [planView.x+(p.x+1)*planView.width/2,planView.y+(1-p.y)*planView.height/2];
 }
 const beforePlan=planner.read(),initialReads=modelReads;
 await page.keyboard.press('b');
 await page.locator('#planning-gesture').waitFor({state:'visible'});
 await page.mouse.move(...waterPoint(41.25,6.25));
 await page.waitForFunction(()=>document.querySelector('#planning-gesture-range').textContent==='X 41  Y 59  Z 6');
 await page.mouse.down();
 await page.mouse.move(...waterPoint(57.75,17.75),{steps:9});
 await page.locator('#planning-preview').waitFor({state:'visible'});
 await page.mouse.up();
 assert.equal(planner.read().revision,beforePlan.revision);
 await page.mouse.move(...waterPoint(58,6));
 await page.mouse.down();
 await page.mouse.move(...waterPoint(59,5),{steps:4});
 await page.mouse.up();
 await page.waitForFunction(()=>document.querySelector('#planning-gesture-range').textContent.includes('X 41–59')&&
  document.querySelector('#planning-gesture-range').textContent.includes('Z 5–18'));
 await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector('#planning-tree .planning-object.selected'));
 const rectangle=planner.read().objects.find(p=>p.id===planner.read().selected_id);
 assert.equal(rectangle.type,'area');
 assert.equal(rectangle.points.length,4);
 assert.deepEqual([rectangle.min_y,rectangle.max_y],[59,59]);
 assert.deepEqual(rectangle.points,[[41,5],[59,5],[59,18],[41,18]]);
 assert.equal(await page.locator('#planning-overlay').isChecked(),true);
 const afterBox=await send({kind:'scene_view'});
 assert.deepEqual(afterBox.position,lakePose.position);
 assert.deepEqual(afterBox.target,lakePose.target);
 assert.equal(afterBox.panoramic,true);
 await page.keyboard.press('Control+z');
 await page.locator('[data-plan-id="'+rectangle.id+'"]').waitFor({state:'detached'});
 await page.keyboard.press('Control+y');
 await page.locator('[data-plan-id="'+rectangle.id+'"]').waitFor({state:'visible'});
 await page.locator('[data-tool="plan-polygon"]').click();
 await page.locator('#planning-snap').uncheck();
 for(const [x,z] of [[41.25,7.25],[57.75,8.25],[57.75,22.75],[48.25,22.75]])await page.mouse.click(...waterPoint(x,z));
 assert.equal(await page.locator('#finish-planning-gesture').isEnabled(),true);
 assert.equal(planner.read().objects.length,beforePlan.objects.length+1);
 await page.screenshot({path:path.join(out,'world-panorama-pending.png')});
 await page.locator('#finish-planning-gesture').click();
 await page.waitForFunction(id=>document.querySelector('#planning-tree .planning-object.selected')?.dataset.planId!==id,rectangle.id);
 const poly=planner.read().objects.find(p=>p.id===planner.read().selected_id);
 assert.equal(poly.type,'area');
 assert.equal(poly.points.length,4);
 assert.ok(Math.abs(poly.points[3][0]-48.25)<.2);
 assert.equal(browseReads,0);
 assert.equal(modelReads,initialReads);
 await page.screenshot({path:path.join(out,'world-panorama-planning.png')});
 const currentPlan=planner.read();
 const marked=await send({kind:'capture_scene',scene,width:800,height:600,current_view:true,show_plans:true,planning_revision:currentPlan.revision});
 assert.equal(reply.ok,true);
 assert.deepEqual(marked.images[0].camera.position,lakePose.position);
 assert.equal(marked.view.show_plans,true);
 await page.locator('#planning-snap').check();
 await page.mouse.click(...waterPoint(41.25,7.25));
 await page.mouse.click(...waterPoint(57.75,8.25));
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#planning-gesture').isHidden(),true);
 assert.equal(planner.read().objects.length,beforePlan.objects.length+2);
 planner.execute('delete_plan',{plan_id:poly.id});
 planner.execute('delete_plan',{plan_id:rectangle.id});
 await send({kind:'planning_update'});
 async function locateWater(){
  await page.locator('#locate-position').click();
  await page.locator('#locate-x').fill('39');
  await page.locator('#locate-y').fill('60');
  await page.locator('#locate-z').fill('10');
  await page.locator('#locate-position-form').getByRole('button',{name:'定位',exact:true}).click();
  await page.locator('#locate-position-dialog').waitFor({state:'hidden'});
 }
 await locateWater();
 const pinned=await send({kind:'scene_view'});
 assert.deepEqual(pinned.target,[39,60,10]);
 await page.locator('#planning-preview').waitFor({state:'visible'});
 let releaseBarrier;barrierWait=new Promise(resolve=>releaseBarrier=resolve);const beforeFrozen=await send({kind:'scene_view'}),frozenPromise=send({kind:'capture_scene',scene,width:800,height:600,angles:[],views:[],current_view:true,show_plans:false,show_invisible:true,planning_revision:planner.read().revision});await page.waitForFunction(()=>document.querySelector('#view>canvas').getAttribute('aria-busy')==='true');await page.mouse.down({button:'right'});await page.mouse.move(lookBox.x+lookBox.width*.6+140,lookBox.y+lookBox.height*.5+50,{steps:4});await page.mouse.up({button:'right'});await page.locator('#north').click();barrierWait=null;releaseBarrier();const frozen=await frozenPromise;assert.deepEqual(frozen.images[0].camera.position,beforeFrozen.position);assert.deepEqual(frozen.images[0].camera.target,beforeFrozen.target);
 await page.locator('#isometric').click();await page.waitForTimeout(300);const visiblePose=await send({kind:'scene_view'});assert.ok(visiblePose.render_stats.draw_calls>0);const resourceSamples=[];for(let i=0;i<2;i++){const reads=modelReads;await send({kind:'world_scene',scene,camera:visiblePose});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const sample=await send({kind:'scene_view'});assert.equal(modelReads,reads);assert.ok(sample.render_stats.cached_tiles<=192);assert.ok(sample.render_stats.draw_calls>0&&sample.render_stats.gpu_geometries>0);resourceSamples.push(sample.render_stats);}assert.equal(resourceSamples[0].gpu_geometries,resourceSamples[1].gpu_geometries);assert.equal(resourceSamples[0].gpu_textures,resourceSamples[1].gpu_textures);
 await page.locator('#top').click();
 const area=await viewBox();
 // Project a block known to exist in the rendered world rather than using a fixed building coordinate.
 const terrain=panorama.scene_geometry.tiles.find(t=>t.groups.some(g=>g.state.startsWith('minecraft:grass_block')));
 const cell=terrain.groups.find(g=>g.state.startsWith('minecraft:grass_block')).positions[0];
 let releaseSceneAck;
 sceneAckHold=new Promise(resolve=>{releaseSceneAck=resolve;});
 const previousBrowseReads=browseReads;
 try{
  const pose=await send({kind:'scene_view'});
  assert.equal(pose.panoramic,true);
  const camera=new PerspectiveCamera(pose.fov,area.width/area.height,.1,5000);
  camera.position.fromArray(pose.position);
  camera.up.fromArray(pose.up);
  camera.lookAt(new Vector3(...pose.target));
  camera.updateMatrixWorld();
  const point=new Vector3(terrain.bounds[0]+cell%32+.5,Math.floor(cell/1024)-63.5,terrain.bounds[2]+Math.floor(cell/32)%32+.5).project(camera);
  const at=[area.x+(point.x+1)*area.width/2,area.y+(1-point.y)*area.height/2];
  await page.mouse.move(...at);
  await page.waitForFunction(()=>document.querySelector('#hover').textContent.includes('minecraft:'),{},{timeout:5000});
  await page.mouse.dblclick(...at);
  for(let attempt=0;attempt<40&&browseReads===previousBrowseReads;attempt++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(browseReads,previousBrowseReads+1,'A pending read-only view acknowledgement must allow double-click navigation');
 }finally{
  sceneAckHold=null;
  releaseSceneAck();
 }
 await page.waitForFunction(()=>document.querySelector('#source-state').textContent==='实机三维',{},{timeout:30000});
 await page.locator('#world-map-tab').click();await page.waitForFunction(()=>!document.querySelector('#map-host').hidden);
 await locateWater();
 const mapPin=(await send({kind:'scene_view'})).view;
 assert.equal(mapPin.x,39);assert.equal(mapPin.z,10);
 await page.locator('#map-planning-preview').waitFor({state:'visible'});
 await page.locator('#map-fit').click();
 const searchTop=(await page.locator('.tree-search').boundingBox()).y;
 const canvasBeforeGesture=await page.locator('#map-canvas').boundingBox();
 await page.locator('[data-map-tool="area"]').click();
 const sidebarGesture=page.locator('.project-panel #planning-gesture');
 await sidebarGesture.waitFor();
 assert.ok((await page.locator('.tree-search').boundingBox()).y>searchTop,'Planning controls should move the search and tree down');
 assert.deepEqual(await page.locator('#map-canvas').boundingBox(),canvasBeforeGesture);
 assert.ok(await page.locator('#map-canvas').evaluate(canvas=>{
  const {left,top}=canvas.getBoundingClientRect();
  return document.elementFromPoint(left+18,top+18)===canvas;
 }),'The upper-left map must remain available for selection');
 const box=await page.locator('#map-canvas').boundingBox(),beforeMapDraft=planner.read().revision;
 await page.mouse.move(box.x+box.width*.2,box.y+box.height*.25);
 await page.locator('#map-planning-preview').waitFor({state:'visible'});
 await page.mouse.down();await page.mouse.move(box.x+box.width*.8,box.y+box.height*.75,{steps:10});await page.mouse.up();
 assert.equal(planner.read().revision,beforeMapDraft);
 assert.equal(await page.locator('#finish-planning-gesture').isEnabled(),true);
 await page.screenshot({path:path.join(out,'map-pending-planning.png')});
 await page.locator('#finish-planning-gesture').click();
 await page.waitForFunction(()=>!document.querySelector('#plan-fields').hidden);
 const layoutProfiles=[];
 const baselineViewport=page.viewportSize();
 const originalStyle=await page.locator('html').getAttribute('style');
 try{
  for(const [width,height] of [[1040,680],[1280,800],[1600,1000]]){
   await page.setViewportSize({width,height});
   for(const fontSize of [12,14,16,18]){
    const label=width+'×'+height+' @ '+fontSize+'px';
    const failures=await page.evaluate(({fontSize,width})=>{
     const root=document.documentElement,issues=[];
     root.style.setProperty('--ui-size',fontSize+'px');
     root.style.setProperty('--right',width===1040?'170px':'272px');
     const rect=selector=>document.querySelector(selector).getBoundingClientRect();
     const [save,remove,detail]=['#save-plan','#delete-plan','#plan-detail'].map(rect);
     const stacked=Math.abs(save.left-remove.left)<1;
     const separated=stacked?remove.top-save.bottom>=7.9&&Math.abs(save.right-remove.right)<1:
      remove.left-save.right>=7.9&&Math.abs(save.top-remove.top)<1&&Math.abs(save.bottom-remove.bottom)<1;
     const actionOverflow=[...document.querySelectorAll('.plan-actions button')].some(button=>button.scrollWidth>button.clientWidth+1);
     if(!separated||actionOverflow||detail.top-Math.max(save.bottom,remove.bottom)<7.9||detail.height<32||
       Math.abs(detail.left-save.left)>1||Math.abs(detail.right-remove.right)>1||
       detail.bottom>rect('.properties-panel').bottom+1)issues.push('规划操作间距或可见性');
     const [low,high]=['#plan-min-y','#plan-max-y'].map(rect);
     if(low.right>=high.left||Math.abs(low.top-high.top)>1||Math.abs(low.width-high.width)>1||
       Math.abs(high.right-rect('.plan-height-range').right)>1)issues.push('高度输入框对齐');
     const hint=document.querySelector('#plan-height-help');
     if(hint.scrollWidth>hint.clientWidth||!hint.textContent.includes('只填一项')||
       document.querySelector('#plan-max-y').hasAttribute('placeholder'))issues.push('高度说明');
     if(root.scrollWidth>innerWidth||rect('#view').right>rect('.properties-panel').left+1||
       rect('.project-panel').right>rect('#view').left+1||rect('.status-bar').bottom>innerHeight+1)issues.push('主窗口边界');
     for(const section of ['#map-tools','#detail-tools']){
      if([...document.querySelectorAll(section+' button')].some(button=>button.offsetWidth&&button.scrollWidth>button.clientWidth+1))issues.push('侧栏工具文字');
     }
     for(const id of ['create-project-dialog','new-world-dialog','world-source-dialog','locate-position-dialog']){
      const dialog=document.getElementById(id);
      dialog.showModal();
      const bounds=dialog.getBoundingClientRect();
      if(bounds.left<0||bounds.top<0||bounds.right>innerWidth||bounds.bottom>innerHeight||dialog.scrollWidth>dialog.clientWidth+1)issues.push(id+' 边界');
      const buttons=[...dialog.querySelectorAll('.dialog-actions > button')].map(button=>button.getBoundingClientRect());
      if(buttons.some(button=>Math.abs(button.top-buttons[0].top)>1||Math.abs(button.height-buttons[0].height)>1))issues.push(id+' 按钮对齐');
      dialog.close();
     }
     return issues;
    },{fontSize,width});
    assert.deepEqual(failures,[],label);
    await page.locator('#plan-height-help').scrollIntoViewIfNeeded();
    await page.locator('.properties-panel').screenshot({path:path.join(out,'layout-inspector-'+width+'-'+fontSize+'.png'),scale:'css'});
    await page.locator('[data-menu="file"]').click();
    const commands=await page.getByRole('menuitem').allTextContents();
    assert.ok(commands.length>0&&commands.every(command=>!/(?:…|\.\.\.)/.test(command)),label+' 文件菜单');
    await page.locator('#menu-popup').screenshot({path:path.join(out,'layout-menu-'+width+'-'+fontSize+'.png'),scale:'css'});
    await page.keyboard.press('Escape');
    layoutProfiles.push(label);
   }
  }
 }finally{
  await page.setViewportSize(baselineViewport);
  await page.locator('html').evaluate((root,style)=>{if(style===null)root.removeAttribute('style');else root.setAttribute('style',style);},originalStyle);
 }
 console.log('通过 '+layoutProfiles.length+' 组布局检查 '+layoutProfiles.join('、'));
 const large=planner.read().objects.find(p=>p.id===planner.read().selected_id);assert.ok(Math.max(...large.points.map(p=>p[0]))-Math.min(...large.points.map(p=>p[0]))>128);
 await page.locator('#plan-name').fill('山谷城镇整体规划');await page.locator('#plan-notes').fill('主街连接港口；住宅区保留山体轮廓。');await page.locator('#save-plan').click();await page.waitForFunction(()=>[...document.querySelectorAll('.planning-object .name')].some(e=>e.textContent==='山谷城镇整体规划'));
 await page.waitForFunction(()=>!document.querySelector('#save-plan').disabled);
 selectionDelay=250;const instant=await page.locator('.planning-object .name').filter({hasText:anchorName}).first().evaluate(el=>{const t=performance.now();el.click();return {ms:performance.now()-t,selected:el.closest('.planning-object').classList.contains('selected')};});assert.equal(instant.selected,true);assert.ok(instant.ms<100);await page.locator('.planning-object .name').filter({hasText:'山谷城镇整体规划'}).first().click();await page.waitForFunction(()=>document.querySelector('#plan-name').value==='山谷城镇整体规划');for(let i=0;i<100&&planner.read().selected_id!==large.id;i++)await new Promise(r=>setTimeout(r,20));assert.equal(planner.read().selected_id,large.id);selectionDelay=0;
 const nameField=page.locator('#plan-name');await nameField.evaluate(el=>{el.focus();el.setSelectionRange(2,4);el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:250}));});await page.locator('#menu-popup button').filter({hasText:'复制'}).click();await page.waitForTimeout(50);assert.equal(clipboardText,'城镇');clipboardText='优化';await nameField.evaluate(el=>{el.setSelectionRange(2,4);el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:250}));});await page.locator('#menu-popup button').filter({hasText:'粘贴'}).click();await page.waitForFunction(()=>document.querySelector('#plan-name').value.includes('优化'));await nameField.fill('山谷城镇整体规划');await page.locator('#save-plan').click();await page.waitForFunction(()=>!document.querySelector('#save-plan').disabled);
 await page.locator('.planning-object .name').filter({hasText:'山谷城镇整体规划'}).first().click({button:'right'});await page.waitForFunction(()=>!document.querySelector('#menu-popup').hidden&&document.querySelector('#menu-popup').textContent.includes('删除规划'));await page.keyboard.press('Escape');assert.equal(await page.locator('#menu-popup').isHidden(),true);assert.equal(await page.evaluate(()=>{const e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});document.querySelector('.properties-panel .panel-title').dispatchEvent(e);return e.defaultPrevented;}),true);
 await page.locator('#plan-visible').uncheck();await page.waitForFunction(()=>document.querySelector('.planning-object.selected')?.classList.contains('hidden-object'));assert.ok(planner.read().objects.some(p=>p.id===large.id));
 await page.locator('#delete-plan').click();await page.waitForFunction(()=>document.querySelector('#plan-fields').hidden);assert.equal(planner.read().objects.some(p=>p.id===large.id),false);await page.keyboard.press('Control+z');await page.waitForFunction(()=>!document.querySelector('#plan-fields').hidden);assert.equal(planner.read().objects.some(p=>p.id===large.id),true);
 await page.locator('#plan-visible').check();await page.waitForFunction(()=>document.querySelector('#plan-visible').checked&&!document.querySelector('.planning-object.selected')?.classList.contains('hidden-object'));await page.locator('#map-angle').fill('37');await page.locator('#map-angle').dispatchEvent('change');await page.locator('#map-angle').press('Tab');await page.waitForFunction(()=>Math.round(Number(document.querySelector('#map-angle').value))===37);await page.waitForTimeout(700);assert.equal(Math.round(view.rotation),37);
 await page.screenshot({path:path.join(out,'world-planning.png')});
 await page.keyboard.press('o');for(const [x,y]of [[.2,.2],[.35,.2],[.3,.4]])await page.mouse.click(box.x+box.width*x,box.y+box.height*y);await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#plan-geometry').textContent.startsWith('3 个控制点'));
 await page.keyboard.press('p');for(const [x,y]of [[.2,.6],[.4,.5],[.6,.6]])await page.mouse.click(box.x+box.width*x,box.y+box.height*y);await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('#plan-width-label').hidden);
 await page.keyboard.press('m');await page.mouse.click(box.x+box.width*.6,box.y+box.height*.3);await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#plan-geometry').textContent.startsWith('1 个控制点'));assert.ok(planner.read().objects.some(p=>p.type==='route'));assert.ok(planner.read().objects.some(p=>p.type==='marker'));
 await page.locator('[data-map-tool="select"]').click();const marker=structuredClone(planner.read().objects.find(p=>p.id===planner.read().selected_id));await page.mouse.move(box.x+box.width*.6,box.y+box.height*.3);await page.mouse.down();await page.mouse.move(box.x+box.width*.6+40,box.y+box.height*.3+25,{steps:5});await page.locator('#map-canvas').dispatchEvent('pointercancel',{pointerId:1,button:0});await page.mouse.up();await page.waitForTimeout(300);assert.deepEqual(planner.read().objects.find(p=>p.id===marker.id).points,marker.points);
 async function boundsCheck(){const r=await page.evaluate(()=>{const rect=id=>{const r=document.querySelector(id).getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};};return {view:rect('#view'),map:rect('#map-canvas'),canvas:rect('#view>canvas'),properties:rect('.properties-panel')};});assert.ok(r.view.right<=r.properties.left+.5);assert.ok(r.map.right<=r.properties.left+.5);assert.ok(r.canvas.right<=r.properties.left+.5);}
 await page.setViewportSize({width:1100,height:760});await page.waitForTimeout(300);await boundsCheck();
 const splitter=await page.locator('[data-resize="right"]').boundingBox();await page.mouse.move(splitter.x+2,splitter.y+80);await page.mouse.down();await page.mouse.move(splitter.x-80,splitter.y+80,{steps:8});await page.mouse.up();await page.waitForTimeout(250);await boundsCheck();await page.screenshot({path:path.join(out,'narrow-layout.png')});
 await page.setViewportSize({width:1600,height:1000});
 await page.locator('.planning-object .name').filter({hasText:anchorName}).first().click();
 let releaseDetail;
 detailWait=new Promise(resolve=>{releaseDetail=resolve;});
 try{
  await page.locator('#plan-detail').click();
  assert.equal(await page.locator('#detail-loading').isVisible(),true);
  assert.equal(await page.locator('#map-host').isHidden(),true);
  await page.locator('#cancel-detail').click();
 }finally{detailWait=null;releaseDetail();}
 await page.waitForFunction(()=>document.querySelector('#status').textContent==='已返回地图');
 assert.equal(await page.locator('#map-host').isVisible(),true);
 await page.locator('#plan-detail').click();
 await page.waitForFunction(()=>document.querySelector('#detail-loading').hidden&&document.querySelector('#source-state').textContent==='实机三维',{},{timeout:30000});
 await boundsCheck();
 await page.screenshot({path:path.join(out,'world-3d-scene.png')});
 const localRegion={...local.region,id:'qa-world-detail',transient:true};
 const resident=await send({kind:'display_cached',region:localRegion});
 assert.equal(reply.ok,true);
 assert.equal(resident.snapshot_reused,true);
 assert.equal(resident.geometry_reused,true);
 const repeated=await send({kind:'display_cached',region:{...localRegion,id:'qa-repeat-detail',label:'重复打开的区域'}});
 assert.equal(repeated.region_id,'qa-repeat-detail');
 assert.equal(repeated.local_geometry_builds,resident.local_geometry_builds);
 assert.equal(await page.locator('#view-badge').textContent(),'重复打开的区域');
 const [minX,minY,minZ]=local.snapshot.bounds,neighbor=[minX-1,minY,minZ].join(',');
 const adjacentState=local.snapshot.context_blocks?.[neighbor]==='minecraft:stone'?'minecraft:air':'minecraft:stone';
 const changedSnapshot={...local.snapshot,context_blocks:{...local.snapshot.context_blocks,[neighbor]:adjacentState}};
 const changed={...localRegion,snapshot_hash:snapshotHash(changedSnapshot)};
 const missed=await send({kind:'display_cached',region:changed});
 assert.equal(missed.cache_miss,true);
 const changes=snapshotDelta(local.snapshot,changedSnapshot);
 assert.ok(changes);
 const delta={...changes,from_hash:localRegion.snapshot_hash};
 const ignored=await send({kind:'display_delta',region:changed,snapshot_delta:{...delta,from_hash:changed.snapshot_hash}});
 assert.equal(ignored.cache_miss,true);
 const rebuilt=await send({kind:'display_delta',region:changed,snapshot_delta:delta});
 assert.equal(reply.ok,true,reply.error);
 assert.equal(rebuilt.snapshot_hash,changed.snapshot_hash);
 assert.equal(rebuilt.snapshot_delta_applied,true);
 assert.equal(rebuilt.local_mesh_update.mode,'partial');
 assert.equal(rebuilt.geometry_reused,false);
 assert.equal(rebuilt.local_geometry_builds,resident.local_geometry_builds+1);
 const restored=await send({kind:'display',region:localRegion,snapshot:local.snapshot});
 assert.equal(restored.geometry_reused,false);
 assert.equal(restored.local_geometry_builds,rebuilt.local_geometry_builds+1);
 const beforeTravel=await send({kind:'scene_view'}),readsBeforeTravel=browseReads,modelsBeforeTravel=modelReads;await page.locator('#camera-speed').fill('200');await page.locator('#camera-speed').evaluate(el=>el.blur());await page.mouse.move(lookBox.x+lookBox.width*.5,lookBox.y+lookBox.height*.5);await page.keyboard.down('w');await page.waitForTimeout(400);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.keyboard.up('w');await page.waitForTimeout(900);const afterTravel=await send({kind:'scene_view'});assert.ok(Math.hypot(...afterTravel.position.map((n,i)=>n-beforeTravel.position[i]))>14);assert.equal(browseReads,readsBeforeTravel);assert.equal(modelReads,modelsBeforeTravel);assert.equal(afterTravel.region_id,beforeTravel.region_id);await page.locator('#camera-speed').fill('20');for(const [i,axis]of ['x','y','z'].entries())await page.locator('#camera-'+axis).fill(String(beforeTravel.position[i]));await page.locator('#set-camera-angle').click();
 const localPose=await send({kind:'scene_view'}),localCurrent=await send({kind:'capture_scene',scene,width:800,height:600,angles:[],views:[],current_view:true,show_plans:false,planning_revision:planner.read().revision});assert.equal(reply.ok,true);const restoredLocal=await send({kind:'scene_view'});assert.equal(restoredLocal.region_id,localPose.region_id);assert.equal(restoredLocal.panoramic,false);assert.ok(Math.hypot(...localCurrent.images[0].camera.position.map((n,i)=>n-localPose.position[i]))<1e-6);assert.ok(Math.hypot(...restoredLocal.position.map((n,i)=>n-localPose.position[i]))<1e-6);
 assert.equal(await page.locator('#grid').isChecked(),false);assert.equal(await page.locator('#outline').isChecked(),false);assert.deepEqual(errors,[]);
 const rendered=await send({kind:'capture',region:{...local.region,id:'qa-world-detail',transient:true},snapshot:local.snapshot,width:1024,height:768,angles:['north','isometric'],min_y:local.region.bounds[1],max_y:local.region.bounds[4],show_grid:false,show_selection:false,show_plans:true,display_mode:'scene'});assert.equal(reply.ok,true);assert.equal(rendered.images.length,2);assert.equal(rendered.planning_revision,planner.read().revision);for(const image of rendered.images){const bytes=fs.readFileSync(image.path);assert.equal(bytes.readUInt32BE(16),1024);assert.equal(bytes.readUInt32BE(20),768);}await boundsCheck();assert.deepEqual(errors,[]);
 const barrierSnapshot=structuredClone(local.snapshot),p=[local.region.bounds[0]+2,local.region.bounds[1]+4,local.region.bounds[2]];barrierSnapshot.blocks[p.join(',')]='minecraft:barrier';const barrierRequest={kind:'capture',region:{...local.region,id:'qa-barrier',snapshot_hash:snapshotHash(barrierSnapshot)},snapshot:barrierSnapshot,width:1024,height:768,angles:['north'],min_y:local.region.bounds[1],max_y:local.region.bounds[4],show_grid:false,show_selection:false,show_plans:false,display_mode:'scene'};
 const hiddenBarrier=await send({...barrierRequest,show_invisible:false}),shownBarrier=await send({...barrierRequest,show_invisible:true});assert.equal(reply.ok,true);assert.ok(!shownBarrier.unsupported_states.includes('minecraft:barrier'));assert.notDeepEqual(fs.readFileSync(hiddenBarrier.images[0].path),fs.readFileSync(shownBarrier.images[0].path));fs.copyFileSync(shownBarrier.images[0].path,path.join(out,'barrier-helper.png'));assert.deepEqual(errors,[]);
 const obsoleteDraft={...localRegion,id:'qa-stale-preview',source:'design_draft',draft_id:'qa-missing-draft',draft_revision:1,design_visible:true,label:'临时草稿标签'};
 const staleTab=page.locator('#document-tabs [role="tab"]').filter({hasText:obsoleteDraft.label});
 const displayFixture=region=>send({kind:'display',region,snapshot:local.snapshot});
 await displayFixture(obsoleteDraft);
 await displayFixture(localRegion);
 const inactive=await send({kind:'draft_deleted',draft_id:obsoleteDraft.draft_id});
 assert.equal(inactive.tab_closed,true);
 assert.equal(await staleTab.count(),0);
 assert.equal((await send({kind:'scene_view'})).region_id,localRegion.id);
 await displayFixture(obsoleteDraft);
 await staleTab.click();
 await page.waitForFunction(()=>document.querySelector('#status').textContent==='草稿已不存在，已关闭标签');
 assert.equal(await staleTab.count(),0);
 assert.equal((await send({kind:'scene_view'})).mode,'map');
 const independent=page.locator('[data-draft-id="qa-independent"]'),attached=page.locator('[data-draft-id="qa-attached"]');
 const draftMenu=name=>page.getByRole('menuitem',{name,exact:true});
 await attached.click({button:'right'});
 await draftMenu('重命名').waitFor({state:'visible'});
 await page.keyboard.press('Escape');
 await independent.click({button:'right'});await draftMenu('打开方案').click();
 const draftTab=page.locator('#document-tabs [role="tab"]').filter({hasText:'独立方案验收'});
 await draftTab.waitFor({state:'visible'});
 const beforeRename=await send({kind:'scene_view'});
 await independent.click({button:'right'});await draftMenu('重命名').click();
 await page.locator('#draft-action-name').fill('已命名岸线方案');
 await page.locator('#draft-action-submit').click();
 await page.locator('#document-tabs [role="tab"]').filter({hasText:'已命名岸线方案'}).waitFor({state:'visible'});
 assert.deepEqual((await send({kind:'scene_view'})).position,beforeRename.position);
 assert.equal(draftFixture.get('qa-independent').label,'已命名岸线方案');
 await page.locator('#world-map-tab').click();
 await page.waitForFunction(()=>!document.querySelector('#map-host').hidden);
 await independent.click({button:'right'});await draftMenu('隐藏方案').click();
 await page.waitForFunction(()=>document.querySelector('[data-draft-id="qa-independent"]').classList.contains('hidden-object'));
 await independent.click({button:'right'});await draftMenu('显示方案').click();
 await page.waitForFunction(()=>!document.querySelector('[data-draft-id="qa-independent"]').classList.contains('hidden-object'));
 await independent.click({button:'right'});await draftMenu('删除方案').click();
 await page.locator('#draft-action-dialog').waitFor({state:'visible'});
 assert.equal(draftFixture.has('qa-independent'),true);
 await page.locator('#draft-action-cancel').click();
 assert.equal(draftFixture.has('qa-independent'),true);
 await independent.click({button:'right'});await draftMenu('删除方案').click();
 await page.locator('#draft-action-submit').click();
 await independent.waitFor({state:'detached'});
 assert.equal(draftFixture.has('qa-independent'),false);
 assert.equal(await page.locator('#document-tabs [role="tab"]').filter({hasText:'已命名岸线方案'}).count(),0);
 await displayFixture(obsoleteDraft);
 const activeDeletion=await send({kind:'draft_deleted',draft_id:obsoleteDraft.draft_id});
 assert.equal(activeDeletion.tab_closed,true);
 assert.equal(await staleTab.count(),0);
 assert.equal((await send({kind:'scene_view'})).mode,'map');
 const added=planner.execute('create_layer',{name:'图层菜单验收'}).layers.at(-1);
 planner.execute('save_plan',{type:'area',layer_id:added.id,name:'图层内验收区',points:[[39,10],[42,10],[42,13],[39,13]]});
 await send({kind:'planning_update'});
 const layerRow=page.locator('[data-layer-id="'+added.id+'"]');
 await layerRow.click({button:'right'});
 await page.getByRole('menuitem',{name:'重命名图层',exact:true}).click();
 await page.locator('#draft-action-name').fill('岸线图层验收');
 await page.locator('#draft-action-submit').click();
 await layerRow.getByText('岸线图层验收').waitFor();
 await layerRow.click({button:'right'});
 await page.getByRole('menuitem',{name:'删除图层',exact:true}).click();
 assert.ok((await page.locator('#draft-action-description').textContent()).includes('1 项规划'));
 await page.locator('#draft-action-cancel').click();
 assert.equal(planner.read().layers.some(l=>l.id===added.id),true);
 await layerRow.click({button:'right'});
 await page.getByRole('menuitem',{name:'删除图层',exact:true}).click();
 await page.locator('#draft-action-submit').click();
 await layerRow.waitFor({state:'detached'});
 assert.equal(planner.read().objects.some(p=>p.layer_id===added.id),false);
 await page.keyboard.press('Control+z');
 await layerRow.waitFor({state:'visible'});
 assert.equal(planner.read().objects.some(p=>p.layer_id===added.id),true);

 await locateWater();
 const mapCenter=await page.locator('#map-canvas').boundingBox();
 async function slice(y){
  await page.locator('#map-height').click();
  await page.locator('#map-slice-y').fill(String(y));
  await page.locator('#map-height-form').getByRole('button',{name:'查看此层',exact:true}).click();
  await page.waitForFunction(level=>document.querySelector('#map-height').textContent==='Y · '+level,y);
  assert.equal((await send({kind:'scene_view'})).view.slice_y,y);
 }
 await slice(59);
 await page.keyboard.press('b');
 await page.mouse.move(mapCenter.x+mapCenter.width*.4,mapCenter.y+mapCenter.height*.4);
 await page.mouse.down();await page.mouse.move(mapCenter.x+mapCenter.width*.65,mapCenter.y+mapCenter.height*.65,{steps:5});await page.mouse.up();
 await page.locator('#sketch-min-y').fill('60');await page.locator('#sketch-max-y').fill('64');
 await page.locator('#finish-planning-gesture').click();
 await page.waitForFunction(()=>document.querySelector('#plan-min-y').value==='60'&&document.querySelector('#plan-max-y').value==='64');
 const heightPlan=planner.read().objects.find(p=>p.id===planner.read().selected_id);
 assert.deepEqual([heightPlan.min_y,heightPlan.max_y],[60,64]);
 await page.locator('#plan-min-y').fill('58');await page.locator('#plan-max-y').fill('62');
 await page.locator('#save-plan').click();
 await page.waitForFunction(()=>document.querySelector('#plan-geometry').textContent.includes('Y 58–62'));
 assert.deepEqual([planner.read().objects.find(p=>p.id===heightPlan.id).min_y,planner.read().objects.find(p=>p.id===heightPlan.id).max_y],[58,62]);
 await page.screenshot({path:path.join(out,'map-y-slice.png')});
 testHeightNavigation=true;
 await page.locator('#plan-detail').click();
 await page.waitForFunction(()=>document.querySelector('#source-state').textContent==='存档三维'&&!document.querySelector('#new-region').disabled);
 assert.equal((await send({kind:'scene_view'})).target[1],60);
 await page.locator('#world-map-tab').click();
 await page.waitForFunction(()=>!document.querySelector('#map-host').hidden&&document.querySelector('#map-height').textContent==='Y · 59');
 await page.locator('[data-map-tool="select"]').click();
 const centerClick=()=>page.mouse.dblclick(mapCenter.x+mapCenter.width/2,mapCenter.y+mapCenter.height/2);
 await centerClick();
 await page.waitForFunction(()=>document.querySelector('#source-state').textContent==='存档三维');
 const first=await send({kind:'scene_view'});
 assert.equal(first.target[1],59);
 assert.ok(first.view_id);
 await page.locator('#grid').check();
 await page.locator('#north').click();
 const firstPose=await send({kind:'scene_view'});
 await page.locator('#world-map-tab').click();
 await page.waitForFunction(()=>!document.querySelector('#map-host').hidden);
 await slice(60);
 await centerClick();
 await page.waitForFunction(()=>document.querySelector('#source-state').textContent==='存档三维');
 const second=await send({kind:'scene_view'});
 assert.equal(second.target[1],60);
 assert.notEqual(second.view_id,first.view_id);
 assert.equal(await page.locator('#grid').isChecked(),false);
 const tabFor=label=>page.locator('#document-tabs [role="tab"]').filter({has:page.getByText(label,{exact:true})});
 await tabFor(second.label).press('ArrowLeft');
 assert.equal(await page.locator(':focus').getAttribute('aria-label'),first.label);
 await page.keyboard.press('Enter');
 await page.waitForFunction(label=>document.querySelector('#view-badge').textContent===label,first.label);
 const restoredFirst=await send({kind:'scene_view'});
 assert.equal(restoredFirst.view_id,first.view_id);
 assert.deepEqual(restoredFirst.position,firstPose.position);
 assert.deepEqual(restoredFirst.target,firstPose.target);
 assert.equal(await page.locator('#grid').isChecked(),true);
 await tabFor(second.label).click();
 await page.waitForFunction(label=>document.querySelector('#view-badge').textContent===label,second.label);
 assert.deepEqual((await send({kind:'scene_view'})).position,second.position);

 async function newPanorama(label){
  await page.locator('#new-region').click();
  await page.getByRole('menuitem',{name:'新建三维视图',exact:true}).click();
  await page.waitForFunction(title=>document.querySelector('#view-badge').textContent===title&&!document.querySelector('#new-region').disabled,label);
 }
 await newPanorama('全景三维 1');
 await page.locator('#south').click();
 const south=await send({kind:'scene_view'}),readsBeforeSecond=modelReads;
 await newPanorama('全景三维 2');
 await page.locator('#east').click();
 const east=await send({kind:'scene_view'});
 assert.notEqual(south.view_id,east.view_id);
 assert.notDeepEqual(south.position,east.position);
 await tabFor('全景三维 1').click();
 await page.waitForFunction(()=>document.querySelector('#view-badge').textContent==='全景三维 1'&&!document.querySelector('#new-region').disabled);
 assert.deepEqual((await send({kind:'scene_view'})).position,south.position);
 assert.equal(modelReads,readsBeforeSecond);
 await page.screenshot({path:path.join(out,'independent-scene-tabs.png')});
 const closeTabs=page.locator('#document-tabs .close');
 while(await closeTabs.count()){
  const count=await closeTabs.count();
  await closeTabs.last().click();
  await page.waitForFunction(count=>document.querySelectorAll('#document-tabs .close').length<count,count);
 }
 await page.waitForFunction(()=>!document.querySelector('#map-host').hidden);
 const anchorRow = page.locator('.planning-object .name').filter({hasText:anchorName}).first();
 await anchorRow.click();
 await page.locator('#plan-fields').waitFor();
 assert.equal(await page.locator('#layer-settings').isVisible(), false);
 await page.locator('.planning-layer .name').first().click();
 await page.locator('#layer-settings').waitFor();
 assert.equal(await page.locator('#plan-fields').isVisible(), false);
 await anchorRow.click();
 const previousReads = browseReads;
 await page.locator('#enter-3d').click();
 await page.locator('#detail-controls').waitFor();
 await page.waitForFunction(() => document.querySelector('#detail-loading').hidden);
 assert.equal(browseReads, previousReads + 1);
 assert.deepEqual(errors,[]);
 const report={passed:true,scope:'isolated browser with actual saved-world terrain and temporary planning metadata',deviceScaleFactor,selection_feedback_ms:instant.ms,rapid_selection_persisted:true,app_context_menu:true,text_copy_paste_menu:true,browser_context_menu_suppressed:true,world_map:true,full_models_and_textures:true,free_camera:true,movement_does_not_refetch_or_rebuild:true,apply_camera_after_editing:true,wheel_sensitivity:true,wheel_burst_limited:true,orbit_wheel_bounded:true,current_view_photo:true,capture_input_frozen:true,local_capture_restores_document:true,blur_stops_camera_drag:true,cancel_preserves_plan:true,close_returns_to_map:true,resource_reuse:resourceSamples,panorama_views:3,panorama_surface_to_live_detail:true,large_area:true,polygon_route_marker:true,hide_delete_undo:true,rotation:37,resize_boundary:true,capture_restores_layout:true,scene_preview:true,barrier_icon:true,screenshots:out,errors};fs.writeFileSync(path.join(out,'workflow-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
