import {openAppearance} from './appearance.js';
import {invoke} from '@tauri-apps/api/core';
import {documentKey,openDocument,closeDocument,editorShortcut} from './editor-state.js';
import {callWorkbench} from './workbench-api.js';
import {installDesktopChrome} from './desktop-chrome.js';
import {editorPersistence} from './editor-persistence.js';

const $=id=>document.getElementById(id),call=callWorkbench;
const date=s=>new Date(s).toLocaleString('zh-CN',{hour12:false}),icon=name=>'<svg class="icon" aria-hidden="true"><use href="#i-'+name+'"/></svg>';
function bounds(prefix){return Array.from({length:6},(_,i)=>{const value=$(prefix+i).value;if(value==='')throw Error('坐标不能为空');const n=Number(value);if(!Number.isSafeInteger(n))throw Error('坐标必须是整数');return n;});}
function fields(prefix,b){b.forEach((n,i)=>$(prefix+i).value=String(n));}
function text(tag,value,className){const e=document.createElement(tag);e.textContent=value;if(className)e.className=className;return e;}
const names={north:'北向',south:'南向',east:'东向',west:'西向',top:'俯视',isometric:'透视',map:'地图总览'};
function sessionRegion(region){
 const keys=['id','label','view_id','world_uuid','draft_id','preview_mode','panorama','transient','entity_id',
  'focus_position','loaded_bounds','detail_for_plan_id'];
 return Object.fromEntries(keys.filter(key=>region[key]!==undefined).map(key=>[key,region[key]]));
}

export function mountWorkspaceUI(context){
 let regions=[],drafts=[],history=[],captures=[],documents=[],activeKey='',busy=false,activeTool='select',activeDock=null,selectedHistory='',selectedCapture='',galleryEpoch=0,picked=null,versionsEpoch=0,macro=null,paletteHash;
 const currentDraft=()=>drafts.find(d=>d.id===context.getRegion()?.draft_id);
 const say=message=>{$('status').textContent=message;$('status').title=message;};
 let sessionRestored=false,sessionLoading=false;
 const recovery=editorPersistence(call,say,()=>{
  if(!sessionRestored||sessionLoading)return null;
  rememberView();
  return {tabs:documents.slice(-100).map(d=>({key:d.key,region:sessionRegion(d.region),camera:d.camera,view:d.view})),
   active:macro?.active?null:activeKey};
 });
 function formValues(key,values){
  const pending=recovery.fields(key);
  for(const [id,value] of Object.entries(values))$(id).value=pending[id]??value;
  return Object.keys(pending).length>0;
 }
 function editorFormKey(r=context.getRegion()){return r?'form:'+documentKey(r):null;}
 const detailFields=['label','notes',...Array.from({length:6},(_,i)=>'b'+i)];
 for(const id of detailFields)$(id).addEventListener('input',()=>{
  const key=editorFormKey();
  if(key){recovery.edit(key,id,$(id).value);$('detail-pending-edits').hidden=false;}
 });
 $('discard-detail-edits').onclick=()=>{
  const region=context.getRegion();
  if(!region)return;
  recovery.clear(editorFormKey(region));fillRegionForm(region);
 };
 const windowAction=(action,title)=>invoke('workbench_window_action',{action,title}).catch(e=>say(String(e)));
 $('window-minimize').onclick=()=>windowAction('minimize');$('window-maximize').onclick=()=>windowAction('maximize');
 $('window-close').onclick=async()=>{
  try{await recovery.flush();await windowAction('close');}
  catch(error){say('工程会话保存失败 · '+String(error));}
 };
 $('window-titlebar').addEventListener('mousedown',e=>{if(e.button!==0||e.target.closest('button,input,.menus,.window-controls'))return;windowAction(e.detail===2?'maximize':'drag');});
 const fullscreenButton=$('preview-fullscreen');
 let fullscreen=false, switchingFullscreen=false;
 async function toggleFullscreen(){
  if(switchingFullscreen||(!fullscreen&&context.isCapturing?.()))return;
  switchingFullscreen=true;
   dismissMenu();
  try {
   const state=await invoke('workbench_window_action',{action:fullscreen?'exit-fullscreen':'enter-fullscreen'});
   fullscreen=state.fullscreen;
   document.body.classList.toggle('fullscreen-preview',fullscreen);
   const label=fullscreen?'退出全屏':'全屏预览';
   fullscreenButton.title=label+(fullscreen?'（Esc / F11）':'（F11）');
   fullscreenButton.setAttribute('aria-label',label);
   fullscreenButton.querySelector('use').setAttribute('href',fullscreen?'#i-fullscreen-exit':'#i-fullscreen');
   (fullscreen?$('view'):fullscreenButton).focus({preventScroll:true});
  } catch(error) {
   say(String(error));
  } finally {
   switchingFullscreen=false;
  }
 }
 fullscreenButton.onclick=toggleFullscreen;
 document.addEventListener('keydown',event=>{
  if(event.target===fullscreenButton&&['Enter',' '].includes(event.key)){
   event.stopImmediatePropagation();
   return;
  }
  const shortcut=event.key==='F11'&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey;
  const exit=fullscreen&&event.key==='Escape'&&$('menu-popup').hidden;
  if((!shortcut&&!exit)||document.querySelector('dialog[open]'))return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if(exit&&context.cancelActiveSketch?.())return;
  if(!event.repeat)toggleFullscreen();
 },true);
 function setBusy(value){busy=value;document.querySelectorAll('[data-action],#save-workspace,#apply-draft,#save,#save-notes,#draft-fill,#new-draft,#new-region,#refresh,#capture,#undo-context,#redo-context').forEach(e=>e.disabled=value);sync();}
 function versionRegionId() {
  const region = context.getRegion();
  if (macro?.active || !region || region.panorama) return null;
  return region.base_region_id ?? (region.transient ? null : region.id);
 }
 function sync(){
  $('checkpoint').disabled = busy || !versionRegionId();
  const r=context.getRegion(),d=currentDraft(),h=history.find(h=>h.id===selectedHistory);
  $('apply-draft').disabled=busy||macro?.active||!d;$('draft-properties').hidden=!d;$('inspector').classList.toggle('no-document',!r);
  for(const id of ['save','save-notes','refresh','capture','archive-object','layer','layer-number','single-layer'])$(id).disabled=busy||!r;
  $('new-draft').disabled=busy||(macro?.active?!macro.getSelected():!r||r.panorama||r.source==='design_draft');if(macro?.active){$('refresh').disabled=busy;$('capture').disabled=busy;}
  for(const id of ['layer','layer-number','single-layer','grid','outline'])$(id).disabled=busy||!r||r.panorama;document.querySelectorAll('[data-tool="box"],[data-tool="paint"],[data-tool="erase"]').forEach(e=>e.disabled=!!r?.panorama);
  const plan=activeTool.startsWith('plan-')?macro?.getState():null;
  $('undo-context').disabled=busy||(!macro?.active&&!(plan?plan.undo_count:d?d.undo_count:false));
  $('redo-context').disabled=busy||(!macro?.active&&!(plan?plan.redo_count:d?d.redo_count:history.some(h=>h.undoable&&h.redo_count)));
  $('undo').disabled=busy||!d?.undo_count;$('redo').disabled=busy||!d?.redo_count;
  $('history-info').textContent=h?h.label+' · '+h.changed+' 处 · '+(h.undoable?'可由配套写入 MCP 撤销':'含 NBT 或物理变化'):'世界写入回执由配套 MCP 管理';
  if(macro?.active)planningHistory(macro.getState()??{undo_count:0,redo_count:0});else{$('undo').textContent='撤销草稿修改';$('redo').textContent='重做草稿修改';}
  if(d)$('draft-info').textContent='第 '+d.revision+' 版 · '+d.changed_positions+' 处改动\n新增 '+d.counts.added+' / 替换 '+d.counts.replaced+' / 删除 '+d.counts.removed+'\n草稿撤销 '+d.undo_count+' / 重做 '+d.redo_count;
  for(const mode of ['target','base','diff'])$('draft-'+mode).classList.toggle('active',r?.preview_mode===mode);
  for (const button of document.querySelectorAll('[data-mode]')) {
   const current = button.dataset.mode === (macro?.active ? 'live' : 'draft');
   button.classList.toggle('active', current);
   button.setAttribute('aria-pressed', String(current));
  }
  document.querySelectorAll('#document-tabs .close').forEach(e=>e.disabled=busy);
 }
 function outcome(result){if(result?.archived)return '已归档，可从项目大纲的「已归档」恢复';if(result?.edit){const e=result.edit;return '已修改 '+e.changed+' 处'+(e.conflict_count?'，保留 '+e.conflict_count+' 处冲突':'')+(result.preview_error?'；预览刷新失败：'+result.preview_error:'');}if(result?.images)return '已保存 '+result.images.length+' 张预览图片';if(result?.snapshot_hash)return '已打开「'+result.label+'」';if(result?.revision)return '草稿第 '+result.revision+' 版 · '+result.changed_positions+' 处改动'+(result.preview_error?'；已保存，预览未更新：'+result.preview_error:'');if(result?.freed_bytes!==undefined)return '已整理 '+result.removed_files+' 个缓存文件，释放 '+(result.freed_bytes/1048576).toFixed(2)+' MB';return '已完成';}
 async function run(fn,message='正在处理…'){
  if(busy)return;setBusy(true);say(message);
  try{const result=await fn();if(result?.cancelled){say('已返回地图');return result;}say(result?.message??(result?.draft_tab_closed?'草稿已不存在，已关闭标签':outcome(result)));await refresh();return result;}catch(e){say(String(e));}finally{setBusy(false);}
 }
 function dock(name) {
  activeDock = name;
  document.querySelector('.center-workspace').classList.toggle('drawer-closed', !name);
  for (const button of document.querySelectorAll('[data-dock]')) {
   const expanded = button.dataset.dock === name;
   button.classList.toggle('active', expanded);
   button.setAttribute('aria-expanded', String(expanded));
   button.setAttribute('aria-controls', 'dock-' + button.dataset.dock);
  }
  for (const pane of document.querySelectorAll('[data-dock-pane]')) {
   pane.id = 'dock-' + pane.dataset.dockPane;
   pane.hidden = pane.dataset.dockPane !== name;
  }
  if (name === 'gallery') showGallery();
  if (name === 'versions') showVersions();
 }
 for (const button of document.querySelectorAll('[data-dock]')) {
  button.onclick = () => dock(activeDock === button.dataset.dock ? null : button.dataset.dock);
 }
 dock(null);
 function renderTabs(){
  const list=$('document-tabs'),focused=document.activeElement;
  const focusedKey=focused.closest('.document-tab')?.dataset.key;
  const focusClose=focused.classList.contains('close');
  list.replaceChildren();
  let focusTarget;
  for(const d of documents){
   const selected=d.key===activeKey&&!macro?.active;
   const row=text('div','','document-tab'+(selected?' active':''));
   row.dataset.key=d.key;
   const tab=text('button','','tab-open');
   tab.type='button';
   tab.setAttribute('role','tab');
   tab.setAttribute('aria-label',d.label);
   tab.setAttribute('aria-selected',String(selected));
   tab.title=d.label;
   tab.innerHTML=icon(d.region.draft_id?'brush':'cube');
   tab.append(text('span',d.label,'name'));
   tab.onclick=()=>activate(d);
   const close=text('button','','close');
   close.type='button';close.title='关闭 '+d.label;close.setAttribute('aria-label',close.title);
   close.innerHTML=icon('close');close.onclick=()=>closeTab(d.key);
   row.append(tab,close);list.append(row);
   if(d.key===focusedKey)focusTarget=focusClose?close:tab;
  }
  if(focusedKey)(focusTarget??list.querySelector('[aria-selected="true"]')??$('world-map-tab')).focus({preventScroll:true});
  if(sessionRestored&&!sessionLoading)recovery.schedule();
 }
 $('document-tabs').addEventListener('keydown',event=>{
  const current=event.target.closest('[role="tab"]');
  if(!current||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();
  const tabs=[...$('document-tabs').querySelectorAll('[role="tab"]')];
  const index=tabs.indexOf(current),step=event.key==='ArrowLeft'?-1:1;
  const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+step+tabs.length)%tabs.length;
  tabs[next]?.focus();
 });
 function rememberView(){
  const r=context.getRegion();
  if(!r||macro?.active||context.isCapturing?.())return;
  const key=documentKey(r),camera=context.getCamera();
  if(!camera?.position)return;
  const view=context.getView();
  documents=documents.map(d=>d.key===key?{...d,camera,view}:d);
 }
 const storedView=r=>documents.find(d=>d.key===documentKey(r));
 async function restoreSession(activateLast=true){
  if(sessionRestored||sessionLoading)return;
  sessionLoading=true;
  try{
   const saved=await recovery.ready;
   const matching=(saved.tabs??[]).filter(d=>d?.region&&d.key===documentKey(d.region)&&typeof d.region.label==='string')
    .map(d=>({...d,label:d.region.label}));
   documents=[...matching.filter(d=>!documents.some(open=>open.key===d.key)),...documents];
   const last=activateLast&&documents.find(d=>d.key===saved.active);
   renderTabs();
   await refresh();
   if(last&&(!last.region.world_uuid||last.region.world_uuid===currentSource?.world_uuid)&&!busy)await activate(last);
   else if(last)say('上次的标签已恢复。关联存档后可继续预览。');
   if(recovery.hasEdits()&&!last)say('工程中有暂存的属性修改。选中对应对象后可继续编辑。');
  }finally{sessionLoading=false;sessionRestored=true;}
 }
 let panoramaCount=0;
 function newPanorama(){
  return run(()=>call('open_world_scene',{view_id:crypto.randomUUID(),label:'全景三维 '+(++panoramaCount)}),'正在打开三维视图…');
 }
 async function activate(d){
  rememberView();
  const r=d.region;
  return run(async()=>{
   if(r.panorama)return call('open_world_scene',{view_id:r.view_id,label:r.label});
   if(r.draft_id)return call('preview_draft',{draft_id:r.draft_id,mode:r.preview_mode??'target'}).catch(async error=>{
    if(!String(error).includes('草稿已删除或不存在'))throw error;
    await draftDeleted(r.draft_id);
    return {draft_tab_closed:true};
   });
   if(r.transient){
    if(r.view_id){
     try{return await call('open_region',{region_id:r.id});}
     catch(error){if(!String(error).includes('ENOENT'))throw error;}
    }
    const [minX,minY,minZ,maxX,maxY,maxZ]=r.loaded_bounds;
    const [x,y,z]=r.focus_position??[(minX+maxX)/2,Math.ceil((minY+maxY)/2),(minZ+maxZ)/2];
    return call('browse_world',{x:Math.floor(x),y,z:Math.floor(z),plan_id:r.detail_for_plan_id,view_id:r.view_id,label:r.label,allow_saved:true});
   }
   return call('open_region',{region_id:r.entity_id??r.id});
  });
 }
 async function draftDeleted(id){
  const key='draft:'+id;
  documents=closeDocument(documents,key);
  drafts=drafts.filter(d=>d.id!==id);
  if(activeKey===key)activeKey='';
  if(context.getRegion()?.draft_id===id){
   picked=null;
   context.clear();
   if(!macro?.active)await macro?.open();
  }
  renderTabs();sync();
  return {draft_id:id,tab_closed:true};
 }
 let namedAction=null;
 function openNamedAction({action,name,kind,deleteLabel,description,confirm}){
  if(busy||context.isCapturing?.())return;
  namedAction={action,name,confirm};
  const deleting=action==='delete',input=$('draft-action-name'),submit=$('draft-action-submit');
  $('draft-action-title').textContent=(deleting?'删除':'重命名')+kind;
  $('draft-action-description').hidden=!deleting;
  $('draft-action-description').textContent=description;
  $('draft-action-name-field').hidden=deleting;
  $('draft-action-field-label').textContent=kind+'名称';
  input.disabled=deleting;
  input.value=name;
  submit.textContent=deleting?deleteLabel:'保存名称';
  submit.classList.toggle('danger',deleting);
  $('draft-action-dialog').showModal();
  if(!deleting){input.focus();input.select();}
 }
 $('draft-action-cancel').onclick=()=>$('draft-action-dialog').close();
 $('draft-action-form').onsubmit=e=>{
  e.preventDefault();
  if(!namedAction||busy)return;
  const {action,name:originalName,confirm}=namedAction;
  const name=$('draft-action-name').value.trim();
  if(action==='rename'&&!name)return;
  namedAction=null;
  $('draft-action-dialog').close();
  if(action==='rename'&&name===originalName)return;
  void confirm(name);
 };
 function openDraftAction(action,draft){
  const {id,label}=draft;
  openNamedAction({action,name:label,kind:'设计方案',deleteLabel:'删除方案',description:'删除「'+label+'」及其草稿改动。',confirm:name=>run(async()=>{
   if(action==='delete'){
    await call('delete_draft',{draft_id:id});
    await draftDeleted(id);
    return {message:'已删除方案「'+label+'」'};
   }
   const updated=await call('update_draft',{draft_id:id,label:name});
   const r=context.getRegion();
   if(!macro?.active&&r?.draft_id===id){
    await call('preview_draft',{draft_id:id,mode:r.preview_mode??'target',keep_camera:true});
   }
   return {message:'已重命名为「'+updated.label+'」'};
  })});
 }
 async function closeTab(key){
  if(busy||context.isCapturing?.())return;
  const wasActive=activeKey===key;
  documents=closeDocument(documents,key);
  if(wasActive)activeKey='';
  if(wasActive&&!macro?.active){
   const next=documents.at(-1);
   if(next)await activate(next);
   if(!activeKey){
    context.clear();
    if(macro)await macro.open().catch(error=>say(String(error)));
    else{
     $('empty-view').hidden=false;
     $('view-badge').textContent='未打开区域';
     $('object-summary').textContent='未选择对象';
     $('source-state').textContent='无文档';
    }
   }
  }
  renderTabs();sync();
 }
 function renderTree(){
  const query=$('tree-search').value.trim().toLowerCase(),tree=$('project-tree');tree.replaceChildren();
  const heading=label=>{const e=text('div',label,'tree-folder');e.insertAdjacentHTML('afterbegin',icon('folder'));tree.append(e);};
  function row(item,isDraft,archived=false){
   const key=isDraft?'draft:'+item.id:'region:'+(item.entity_id??item.id),e=document.createElement('div');e.className='tree-row'+(isDraft?' draft':'')+(archived?' archived':'')+(key===activeKey?' selected':'');e.setAttribute('role','treeitem');e.innerHTML=icon(isDraft?'brush':'cube');e.append(text('span',item.label,'tree-name'));if(isDraft)e.append(text('small','r'+item.revision));e.onclick=()=>run(()=>isDraft?call('preview_draft',{draft_id:item.id}):call('open_region',{region_id:item.entity_id??item.id}));
   e.oncontextmenu=event=>{event.preventDefault();popup([{label:archived?'恢复到项目':'归档',action:()=>run(()=>call(isDraft?'archive_draft':'archive_region',isDraft?{draft_id:item.id,archived:!archived}:{region_id:item.entity_id??item.id,archived:!archived}))}],event.clientX,event.clientY);};tree.append(e);
  }
  heading('world · 区域');
  for(const r of regions.filter(r=>!r.archived)){
   const children=drafts.filter(d=>!d.archived&&d.base_entity_id===r.entity_id),matched=r.label.toLowerCase().includes(query);
   if(matched||children.some(d=>d.label.toLowerCase().includes(query))){row(r,false);for(const d of children)if(matched||d.label.toLowerCase().includes(query))row(d,true);}
  }
  const orphan=drafts.filter(d=>!d.archived&&!regions.some(r=>!r.archived&&r.entity_id===d.base_entity_id));if(orphan.length){heading('独立草稿');for(const d of orphan)if(d.label.toLowerCase().includes(query))row(d,true);}
  const archived=[...regions.filter(r=>r.archived).map(r=>({r,draft:false})),...drafts.filter(d=>d.archived).map(d=>({r:d,draft:true}))];if(archived.length){const details=document.createElement('details'),summary=text('summary','已归档 ('+archived.length+')','tree-folder');details.append(summary);const start=tree.childElementCount;for(const item of archived)if(item.r.label.toLowerCase().includes(query))row(item.r,item.draft,true);const moved=[...tree.children].slice(start);for(const e of moved)details.append(e);tree.append(details);}
 }
 function renderHistory(){
  $('history-list').replaceChildren();history.forEach((h,i)=>{const row=document.createElement('div');row.className='history-row'+(selectedHistory===h.id?' selected':'');row.append(text('span',String(i+1)),text('span',h.label,'title'),text('span',h.changed+' 处'),text('span',date(h.created_at),'time'));row.onclick=()=>{selectedHistory=h.id;renderHistory();sync();};$('history-list').append(row);});
 }
 async function refresh(){
  const data=await call('ui_snapshot'),{regions:rr,drafts:dd,history:hh,captures:cc,status:ss,workspace:ww}=data;
  regions=rr;drafts=dd;history=hh;captures=cc;if(!history.some(h=>h.id===selectedHistory))selectedHistory=history[0]?.id??'';
  const labels=new Map(dd.map(d=>[d.id,d.label]));
  documents=documents.map(d=>labels.has(d.region.draft_id)?{...d,label:labels.get(d.region.draft_id)}:d);
  currentSource=ss.source;
  currentProjectId=data.project?.id??'primary';
  const name=data.project?.name??ww.label;
  if($('project-name-label').textContent!==name){
   $('project-name-label').textContent=name;
   $('project-name').title='切换工程 · '+name;
   windowAction('title','织境工坊 — '+name);
  }
  const bytes=Object.values(ww.files).reduce((n,x)=>n+x.bytes,0);$('storage-summary').dataset.bytes=String(bytes);$('storage-summary').textContent=ww.region_items+' 个区域 · '+(bytes/1048576).toFixed(1)+' MB';$('storage-summary').title='实际工程数据及有限地形缓存；相同方块内容按哈希复用';
  renderTree();renderTabs();renderHistory();sync();if(macro)macro.refresh(data).catch(e=>say(String(e)));if(activeDock==='gallery')showGallery();if(activeDock==='versions')showVersions();
 }
 function setRegion(r){
  macro?.showDetail();
  activeKey=documentKey(r);documents=openDocument(documents,r);$('empty-view').hidden=true;
  if(picked&&(picked.key!==activeKey||picked.snapshot!==r.snapshot_hash)){
   picked=null;
   $('picked-block').textContent='在视口中选择方块';
   $('coordinate-status').textContent='—';
  }
  fillRegionForm(r);
  const draft=r.source==='design_draft',saved=r.source==='saved_anvil_detail';
  $('source-state').textContent=draft?'草稿 r'+r.draft_revision:Number.isInteger(r.construction_y)?'虚空世界':saved?'存档三维':r.is_current_revision===false?'历史版本':r.transient?'实机三维':'实机区域';$('object-kind').textContent=draft?'设计草稿':r.transient?'场景':'区域';
  $('view-badge').textContent=r.label+(draft?' / '+({target:'设计',base:'原始',diff:'差异'}[r.preview_mode]):'');$('source-status').textContent=draft?'设计预览 · 尚未写入实机':saved?'存档数据 · F5 读取实机':'实机数据';
  $('object-summary').textContent=r.transient?(draft?'地图级设计 · 编辑时更新预览':saved?'从配置的存档读取方块，按 F5 重新读取。':'局部存档 · 视角移动不重建地图')+(r.unknown_chunks?.length?'\n周边 '+r.unknown_chunks.length+' 个未知区域未当作空气':''):(r.bounds[3]-r.bounds[0]+1)+' × '+(r.bounds[4]-r.bounds[1]+1)+' × '+(r.bounds[5]-r.bounds[2]+1)+' 方块'+(draft?'\n版本 r'+r.draft_revision:'\n最近核对 '+date(r.last_verified_at??r.captured_at));$('archive-object').textContent=r.draft_id?'删除方案':'返回地图';$('b0').closest('.property-section').hidden=!!r.transient;$('notes').closest('.property-section').hidden=!!r.transient&&!draft;$('label').readOnly=!!r.transient&&!draft;
  $('selection').textContent='区域 '+r.id+'\n世界 '+r.world_uuid+'\n内容 '+r.snapshot_hash;
  $('save-notes').hidden=$('label').readOnly;
  if(Number.isInteger(r.construction_y)&&!draft){
   $('source-status').textContent='虚空世界 · 建造网格 Y '+r.construction_y;
   $('object-summary').textContent='选择画笔，在 Y '+r.construction_y+' 的网格上放置第一块方块。';
  }
  if(draft)fields('d',r.bounds);$('layer').min=r.loaded_bounds[1];$('layer').max=r.loaded_bounds[4];$('layer').value=r.loaded_bounds[4];$('layer-number').value=r.loaded_bounds[4];$('single-layer').checked=false;
  if(!r.snapshot_hash||paletteHash!==r.snapshot_hash){
   paletteHash=r.snapshot_hash;
   const counts={};
   for(const state of Object.values(context.getSnapshot()?.blocks??{}))if(!/^minecraft:(air|cave_air|void_air)$/.test(state))counts[state]=(counts[state]??0)+1;
   $('material-palette').replaceChildren();
   for(const [state,count]of Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,8)){
    const button=text('button',state.replace('minecraft:','').split('[')[0]);
    button.title=state+' · '+count+' 处';
    button.onclick=()=>{$('block-state').value=state;chooseTool('paint');};
    $('material-palette').append(button);
   }
  }
  renderTree();renderTabs();sync();if(!busy)say('已打开「'+r.label+'」');
 }
 function fillRegionForm(r){
  const values={label:r.label,notes:r.notes??'',...Object.fromEntries(r.bounds.map((value,i)=>['b'+i,value]))};
  const editable=!r.transient||r.source==='design_draft';
  $('detail-pending-edits').hidden=!formValues(editable?editorFormKey(r):null,values);
 }
 async function save(){
  const r=context.getRegion();
  if(!r||r.transient&&!r.draft_id)return call('save_workspace');
  const label=$('label').value,notes=$('notes').value;
  let saved;
  if(r.draft_id){
   saved=await call('update_draft',{draft_id:r.draft_id,label,notes});
   recovery.clear(editorFormKey(r));
   await call('preview_draft',{draft_id:r.draft_id,mode:r.preview_mode??'target',keep_camera:true});
  }else{
   saved=await call('set_selection',{region_id:r.id,bounds:bounds('b'),label});
   saved=await call('update_region',{region_id:saved.id,label,notes});
   recovery.clear(editorFormKey(r));
  }
  $('detail-pending-edits').hidden=true;
  await call('save_workspace');
  return saved;
 }
 async function draftFromView(r,label){
  const focus=r.bounds.slice(0,3).map((n,i)=>(n+r.bounds[i+3])/2);
  const args={region_id:r.id,label};
  if(r.detail_for_plan_id)Object.assign(args,{plan_id:r.detail_for_plan_id,focus});
  const draft=await call('create_draft',args);
  await call('preview_draft',{draft_id:draft.id,focus,keep_camera:true});
  return draft;
 }
 async function ensureDraft(){const r=context.getRegion();if(!r)throw Error('请先进入三维场景');if(r.draft_id)return currentDraft()??{id:r.draft_id};return draftFromView(r,r.label+' · 编辑方案');}
 async function newDraft(){return run(async()=>{if(macro?.active){const p=macro.getSelected();if(!p)throw Error('请先在地图上选择规划区域');const d=await call('create_draft',{plan_id:p.id,label:p.name+' · 设计'});await call('preview_draft',{draft_id:d.id});return d;}const r=context.getRegion();if(!r)throw Error('请先进入三维场景');return draftFromView(r,r.label+' · 方案 '+(drafts.length+1));});}
 function editedPreviewMode(){return context.getRegion()?.preview_mode==='diff'?'diff':'target';}
 function chooseTool(name){if(context.getRegion()?.panorama&&['box','paint','erase'].includes(name)){say('请双击三维表面进入实机细化，再编辑方块');return;}if(['paint','erase'].includes(name)&&!context.getRegion()?.draft_id)return run(async()=>{await ensureDraft();toolChanged(name);return {message:'草稿工具已就绪'};});toolChanged(name);}
 function choosePlanningTool(name){return macro?.active?macro.chooseTool(name):chooseTool('plan-'+name);}
 function toolChanged(name){if(context.setTool(name)===false)return;activeTool=name;document.querySelectorAll('[data-tool]').forEach(e=>{e.classList.toggle('active',e.dataset.tool===name);e.setAttribute('aria-pressed',String(e.dataset.tool===name));});$('control-hint').textContent={select:'左键选择 · 右键旋转 · 中键平移 · Alt+左键旋转','plan-area':'拖动或点击两个角点 · Enter 保存','plan-polygon':'逐点圈出边界 · Enter 保存','plan-route':'逐点绘制路线 · Enter 保存','plan-marker':'点击定位标记 · Enter 保存',box:'左键选择两个角点 · 右键旋转 · Esc 退出',paint:'左键放置相邻方块 · Shift 替换 · Ctrl+Z 撤销草稿',erase:'左键删除草稿中的方块 · Ctrl+Z 撤销',orbit:'左键或右键旋转 · 中键平移 · 滚轮缩放'}[name];}
 document.querySelectorAll('[data-tool]').forEach(e=>e.onclick=()=>chooseTool(e.dataset.tool));
 const saveBounds=b=>run(()=>call('set_selection',{region_id:context.getRegion().id,bounds:b,label:$('label').value||'区域'}));
 async function paintAt(hit,erase,replace){return run(async()=>{const d=await ensureDraft(),p=[...hit.coordinate];if(!erase&&!replace&&hit.source!=='construction_grid'){const axis=hit.normal.reduce((best,v,i,a)=>Math.abs(v)>Math.abs(a[best])?i:best,0);p[axis]+=Math.sign(hit.normal[axis]);}return call('edit_draft',{draft_id:d.id,blocks:[{x:p[0],y:p[1],z:p[2],state:erase?'minecraft:air':$('block-state').value}],preview:{mode:editedPreviewMode(),keep_camera:true}});});}
 async function undoContext(redo=false){if(macro?.active||activeTool.startsWith('plan-')){if(context.undoSketch?.(redo))return;return macro.undo(redo);}return run(()=>{const d=currentDraft();if(d)return call(redo?'redo_draft':'undo_draft',{draft_id:d.id,preview:{mode:context.getRegion()?.preview_mode??'target',keep_camera:true}});return {message:'当前没有可撤销的草稿改动'};});}
 function newRegionDialog(){fields('n',context.getRegion()?.loaded_bounds??[0,48,0,31,79,31]);$('new-label').value='新区域 '+(regions.length+1);$('new-region-dialog').showModal();$('new-label').focus();$('new-label').select();}
 $('new-region').onclick=()=>{
  const rect=$('new-region').getBoundingClientRect();
  popup([{label:'新建三维视图',action:newPanorama},{label:'新建区域规划',key:'Ctrl+N',action:()=>macro?choosePlanningTool('area'):newRegionDialog()}],rect.left,rect.bottom);
 };
 $('cancel-new').onclick=()=>$('new-region-dialog').close();$('new-region-form').onsubmit=e=>{e.preventDefault();const b=bounds('n'),label=$('new-label').value;$('new-region-dialog').close();run(()=>call('load_region',{bounds:b,label}));};
 $('new-draft').onclick=newDraft;$('save-workspace').onclick=()=>macro?.active?macro.save():run(save);$('save-notes').onclick=()=>run(save);$('save').onclick=()=>run(()=>call('set_selection',{region_id:context.getRegion().id,bounds:bounds('b'),label:$('label').value}));$('refresh').onclick=()=>macro?.active?run(()=>call('open_map',{refresh:true})):context.getRegion()?.panorama?run(()=>call('open_world_scene',{refresh:true,view_id:context.getRegion().view_id,label:context.getRegion().label})):run(()=>call('refresh_region',{region_id:context.getRegion().id}));
 $('undo-context').onclick=()=>undoContext(false);$('redo-context').onclick=()=>undoContext(true);
 $('apply-draft').onclick=()=>{
  if(macro?.active||!context.getRegion()?.draft_id){say('请先打开设计方案');return;}
  return run(async()=>{
   const result=await call('export_draft',{draft_id:context.getRegion().draft_id});
   await invoke('workbench_clipboard',{text:result.path}).catch(()=>{});
   return {message:'已导出方案 · '+result.path};
  },'正在导出方案…');
 };
 for(const mode of ['target','base','diff'])$('draft-'+mode).onclick=()=>run(()=>call('preview_draft',{draft_id:context.getRegion().draft_id,mode,keep_camera:true}));
 $('draft-fill').onclick=()=>run(()=>{const d=currentDraft();if(!d)throw Error('请先创建草稿');return call('edit_draft',{draft_id:d.id,fill:{bounds:bounds('d'),state:$('block-state').value},preview:{mode:editedPreviewMode(),keep_camera:true}});});
 $('archive-object').onclick=()=>{const r=context.getRegion();if(!r?.draft_id)return call('open_map');openDraftAction('delete',currentDraft()??{id:r.draft_id,label:r.label});};
 $('undo').onclick=()=>undoContext(false);$('redo').onclick=()=>undoContext(true);
 $('compact').onclick=()=>run(()=>call('compact_storage'));$('tree-search').oninput=renderTree;
 $('checkpoint').onclick = () => run(() => call('save_checkpoint', {region_id: versionRegionId()}));
 async function showVersions(){const id = versionRegionId(), ticket = ++versionsEpoch;
  $('version-list').replaceChildren();
  if (!id) { $('version-list').textContent = '打开已保存的区域后可查看版本。'; return; }
  try{const list=await call('list_region_versions',{region_id:id});if(ticket!==versionsEpoch)return;for(const [index,item]of list.entries()){const row=document.createElement('div');row.className='history-row'+(item.id===id?' selected':'');row.append(text('span',String(index+1)),text('span',item.label,'title'),text('span',item.pinned?'检查点':'工作版本'),text('span',date(item.captured_at),'time'));row.onclick=()=>run(()=>call('open_region',{region_id:item.id}));$('version-list').append(row);}}catch(e){say(String(e));}}
 let shownCapture;
 function renderCaptureStrip(){
  const strip=$('capture-strip'),focusId=strip.contains(document.activeElement)?document.activeElement.dataset.captureId:null;
  if(!captures.some(c=>c.capture_id===selectedCapture))selectedCapture=captures[0]?.capture_id??'';
  strip.replaceChildren();
  for(const c of captures){
   const b=text('button',(c.document_title??'区域预览')+' · '+(c.created_at?new Date(c.created_at).toLocaleTimeString('zh-CN'):c.images.length+' 张'));
   b.type='button';b.dataset.captureId=c.capture_id;b.title=b.textContent;
   b.classList.toggle('active',selectedCapture===c.capture_id);
   b.setAttribute('aria-pressed',String(selectedCapture===c.capture_id));
   b.onclick=()=>{selectedCapture=c.capture_id;showGallery();};
   strip.append(b);
   if(focusId===c.capture_id)b.focus({preventScroll:true});
  }
 }
 async function showGallery(){
  renderCaptureStrip();
  if(shownCapture===selectedCapture)return;
  shownCapture=selectedCapture;
  const ticket=++galleryEpoch,c=captures.find(c=>c.capture_id===selectedCapture),gallery=$('gallery'),meta=$('gallery-meta');
  gallery.replaceChildren();
  if(!c){meta.textContent='使用相机工具保存预览图片';return;}
  const desc=(c.document_title??'场景')+' · '+c.images.length+' 张'+(c.view?.rotation!==undefined?' · 旋转 '+c.view.rotation+'°':c.view?.min_y!==undefined?' · Y '+c.view.min_y+'–'+c.view.max_y:'');
  meta.textContent=desc+' · 正在载入';
  let failed=0;
  for(const [index,img]of c.images.entries()){
   try{
    const url=await invoke('workbench_read_image',{captureId:c.capture_id,index});
    if(ticket!==galleryEpoch)return;
    const b=document.createElement('button'),image=document.createElement('img');
    b.type='button';image.src=url;image.alt=names[img.name]??img.name;
    const caption=image.alt+' · '+img.width+'×'+img.height;
    b.setAttribute('aria-label',caption);b.append(image,text('span',caption));
    b.onclick=()=>{
     $('large-image').src=url;$('large-image').alt=image.alt;
     $('image-dialog').showModal();
    };
    gallery.append(b);
   }catch{failed++;}
  }
  if(ticket!==galleryEpoch)return;
  meta.textContent=failed?desc+' · '+failed+' 张读取失败':desc;
  if(failed)shownCapture=undefined;
 }
 async function capture(){
  return run(async()=>{
   const view=$('view'),scale=Math.min(devicePixelRatio,1920/view.clientWidth,1920/view.clientHeight);
   const width=Math.max(256,Math.round(view.clientWidth*scale)),height=Math.max(256,Math.round(view.clientHeight*scale));
   const result = macro?.active
    ? await call('capture_map', {view: macro.getView(), width, height})
    : await call('capture_current_view', {width, height});
   await refresh();selectedCapture=result.capture_id ?? result.request_id;dock('gallery');return result;
  });
 }
 const captureVisible = capture;
 $('capture').onclick=captureVisible;$('close-image').onclick=()=>$('image-dialog').close();
 for(const name of ['isometric','north','south','east','west','top'])$(name).onclick=()=>context.frame(name);$('focus-tool').onclick=()=>macro?.active?macro.fit():context.frame('isometric');$('axis-x').onclick=()=>context.frame('east');$('axis-y').onclick=()=>context.frame('top');$('axis-z').onclick=()=>context.frame('south');
 let sliceTimer;const cut=()=>{const r=context.getRegion();if(!r)return;const max_y=Number($('layer').value);$('layer-number').value=max_y;context.setView({min_y:$('single-layer').checked?max_y:r.loaded_bounds[1],max_y,show_selection:$('outline').checked,show_grid:$('grid').checked,show_plans:$('planning-overlay').checked,show_invisible:$('invisible-blocks').checked}).catch(e=>say(String(e)));};
 $('layer').oninput=()=>{$('layer-number').value=$('layer').value;clearTimeout(sliceTimer);sliceTimer=setTimeout(cut,90);};$('layer-number').onchange=()=>{$('layer').value=$('layer-number').value;cut();};for(const id of ['single-layer','outline','grid','planning-overlay','invisible-blocks'])$(id).onchange=cut;
 for(const id of ['label','notes',...Array.from({length:6},(_,i)=>'b'+i)])$(id).oninput=()=>say('属性已修改 · Ctrl+S 保存');
 const menu=$('menu-popup');
 let menuTrigger=null;
 function dismissMenu(restore=false){
  menu.hidden=true;
  menuTrigger?.setAttribute('aria-expanded','false');
  if(restore&&menuTrigger?.isConnected)menuTrigger.focus({preventScroll:true});
  menuTrigger=null;
 }
 function popup(items,x,y,{trigger=document.activeElement,keyboard=false}={}){
  dismissMenu();
  menuTrigger=trigger;
  if(trigger?.hasAttribute('aria-haspopup'))trigger.setAttribute('aria-expanded','true');
  const dialogs=[...document.querySelectorAll('dialog:modal')];
  (trigger?.closest('dialog:modal')??dialogs.at(-1)??document.body).append(menu);
  menu.replaceChildren();
  menu.setAttribute('role','menu');
  for(const item of items){
   if(!item){menu.append(document.createElement('hr'));continue;}
   const b=document.createElement('button');b.type='button';
   b.setAttribute('role','menuitem');b.disabled=!!item.disabled;
   b.append(text('span',item.label));
   if(item.key)b.append(text('kbd',item.key));
   b.onclick=()=>{dismissMenu(true);Promise.resolve().then(item.action).catch(error=>say(String(error)));};
   menu.append(b);
  }
  menu.hidden=false;
  menu.style.left=Math.max(0,Math.min(x,window.innerWidth-menu.offsetWidth-8))+'px';
  menu.style.top=Math.max(0,Math.min(y,window.innerHeight-menu.offsetHeight-8))+'px';
  if(keyboard)menu.querySelector('button:not(:disabled)')?.focus();
 }
 menu.addEventListener('keydown',event=>{
  if(event.key==='Escape'){
   event.preventDefault();event.stopPropagation();dismissMenu(true);return;
  }
  if(event.key==='Tab'){dismissMenu(true);return;}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  event.preventDefault();event.stopPropagation();
  const buttons=[...menu.querySelectorAll('button:not(:disabled)')],index=buttons.indexOf(document.activeElement);
  const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:
   (index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
  buttons[next]?.focus();
 });
 installDesktopChrome(popup,say);
 function help(){$('shortcut-help').textContent='地图规划\nV 选择与移动　B 框选　O 多边形　P 路线　M 标记　H 平移\n右键拖动旋转，滚轮缩放；双击位置进入三维\n先在光标处核对坐标，拖动控制点调整，Enter 保存，Esc 取消\n选中规划后拖动控制点调整边界；眼睛按钮隐藏／显示\nDelete 删除规划；Ctrl+Z / Ctrl+Y 撤销／重做规划\n\n三维细化\nB 框选规划　O 逐点圈定区域　M 地点标记\n拖动控制点调整，Enter 保存，Esc 取消\n右键旋转，中键平移，滚轮缩放；可输入方位角与俯仰角\n漫游：WASD 移动，空格上升，C 下降，Shift 加速，右键转向\nP 画笔　E 橡皮；左键放置相邻方块，Shift+左键替换\nCtrl+Z / Ctrl+Y 撤销／重做草稿，Ctrl+Enter 导出方案\nF 聚焦　7 俯视　1 北向　3 东向　G 网格\n\nCtrl+S 保存　F5 刷新实机　Ctrl+Shift+P 保存预览图片';$('help-dialog').showModal();}
 $('close-help').onclick=()=>$('help-dialog').close();
 const commands={save:()=>macro?.active?macro.save():run(save),checkpoint:()=>$('checkpoint').click(),undo:()=>undoContext(),redo:()=>undoContext(true),'new-region':()=>macro?choosePlanningTool('area'):newRegionDialog(),close:()=>{if(!macro?.active&&activeKey)return closeTab(activeKey);},apply:()=>$('apply-draft').onclick(),capture:captureVisible,select:()=>chooseTool('select'),'plan-area':()=>choosePlanningTool('area'),'plan-polygon':()=>choosePlanningTool('polygon'),'plan-route':()=>choosePlanningTool('route'),'plan-marker':()=>choosePlanningTool('marker'),paint:()=>chooseTool('paint'),erase:()=>chooseTool('erase'),orbit:()=>chooseTool('orbit'),focus:()=>macro?.active?macro.fit():context.frame('isometric'),grid:()=>{if(macro?.active)return;$('grid').checked=!$('grid').checked;cut();},top:()=>macro?.active?macro.north():context.frame('top'),north:()=>macro?.active?macro.north():context.frame('north'),east:()=>context.frame('east'),refresh:()=>$('refresh').onclick(),help,'delete-block':()=>{if(picked?.key===activeKey&&picked.snapshot===context.getRegion()?.snapshot_hash)paintAt({coordinate:picked.coordinate,normal:[0,1,0]},true,true);}};
 let currentSource=null,currentProjectId='primary',projectBusy=false;
 for(const button of document.querySelectorAll('[data-world-folder-for]')){
  button.onclick=async()=>{
   const input=$(button.dataset.worldFolderFor),dialog=button.closest('dialog');
   const errorField=dialog.querySelector('[role="alert"]');
   button.disabled=true;
   try{
    const directory=await invoke('pick_world_directory',{initialPath:input.value});
    if(directory&&dialog.open){
     input.value=directory;
     errorField.textContent='';
    }
   }catch(error){if(dialog.open)errorField.textContent='无法打开文件夹选择器。'+String(error);}
   finally{button.disabled=false;}
  };
 }
 const projectsDialog=$('projects-dialog'),projectForm=$('create-project-dialog');
 async function openProjectFolder(id,kind){
  try{await invoke('open_project_folder',{id,kind});}
  catch(error){
   if(projectsDialog.open)$('projects-error').textContent=String(error);
   else say(String(error));
  }
 }
 function askProjectRename(project){
  openNamedAction({action:'rename',name:project.name,kind:'工程',confirm:async name=>{
   try{
    await call('rename_project',{id:project.id,name});
    await refresh();
    if(projectsDialog.open)await openProjects();
    say('工程已重命名为「'+name+'」');
   }catch(error){
    if(projectsDialog.open)$('projects-error').textContent=String(error);
    else say(String(error));
   }
  }});
 }
 async function focusProject(id,minimize){
  return call('open_project',{id}).then(result=>{
   if(!result?.shown)throw Error('工程窗口未就绪');
   if(minimize)windowAction('minimize');
   return result;
  });
 }
 function projectAction(label,handler,primary=false){
  const button=text('button',label,primary?'accent':'');
  button.type='button';button.onclick=handler;return button;
 }
 async function openProjects(){
  if(projectBusy)return;
  const list=$('project-list');
  $('projects-error').textContent='';
  list.replaceChildren(text('li','正在读取工程…','project-list-message'));
  if(!projectsDialog.open)projectsDialog.showModal();
  try{
   const projects=await call('list_projects');
   list.replaceChildren();
   for(const project of projects){
    const row=text('li','','project-entry');
    const detail=text('div','','project-entry-detail');
    const name=text('strong',project.name);
    const source=text('span',project.error?'存档不可读取':project.source_kind==='project-world'?'工程内存档 · '+project.world:
     project.world?'关联存档 · '+project.world:'空白规划');
    if(project.directory)source.title=project.directory;
    const location=text('span',project.directory??project.project_directory,'project-entry-path');
    location.title=location.textContent;
    detail.append(name,source,location);row.append(detail);
    const actions=text('div','','project-entry-actions');
    if(project.current){
     row.classList.add('current-project');
     detail.append(text('span','当前工程','project-indicator'));
    }else{
     const activate=minimize=>async()=>{
      if(projectBusy)return;
      projectBusy=true;
      for(const button of list.querySelectorAll('button'))button.disabled=true;
      $('projects-error').textContent='';
      try{await focusProject(project.id,minimize);projectsDialog.close();}
      catch(error){$('projects-error').textContent=String(error);}
      finally{projectBusy=false;for(const button of list.querySelectorAll('button'))button.disabled=false;}
     };
     actions.append(projectAction(project.running?'显示窗口':'新窗口打开',activate(false)),
      projectAction('切换到此工程',activate(true),true));
    }
    actions.append(projectAction('重命名',()=>askProjectRename(project)),
     projectAction('打开工程目录',()=>openProjectFolder(project.id,'project')));
    if(project.directory&&!project.error)actions.append(projectAction('打开存档目录',()=>openProjectFolder(project.id,'save')));
    row.append(actions);list.append(row);
   }
  }catch(error){list.replaceChildren();$('projects-error').textContent=String(error);}
 }
 function projectSourceChanged(){
  const saved=$('create-project-type').value==='save';
  $('create-project-path-field').hidden=!saved;
  $('create-project-path').required=saved;
 }
 function openProjectForm(type='blank',directory=''){
  if(projectBusy)return;
  if(projectsDialog.open)projectsDialog.close();
  $('create-project-name').value=type==='void'?'虚空世界':type==='save'&&directory?directory.split(/[\\/]/).filter(Boolean).at(-1)?.slice(0,64)??'':'';
  $('create-project-type').value=type;
  $('create-project-path').value=directory;
  $('create-project-error').textContent='';
  projectSourceChanged();
  projectForm.showModal();
  $('create-project-name').select();
 }
 $('project-name').onclick=openProjects;
 $('projects-close').onclick=()=>projectsDialog.close();
 $('start-project-form').onclick=()=>openProjectForm();
 $('create-project-cancel').onclick=()=>{if(!projectBusy)projectForm.close();};
 projectForm.addEventListener('cancel',event=>{if(projectBusy)event.preventDefault();});
 $('create-project-type').onchange=projectSourceChanged;
 $('create-project-form').onsubmit=async event=>{
  event.preventDefault();
  if(projectBusy)return;
  const type=$('create-project-type').value;
  const args={name:$('create-project-name').value,type};
  if(type==='save')args.directory=$('create-project-path').value;
  const submit=$('create-project-submit');
  const errorField=$('create-project-error');
  let created,openError;
  projectBusy=true;submit.disabled=true;errorField.textContent='';
  try{
   created=await call('create_project',args);
   await focusProject(created.id,false);
   projectForm.close();
  }catch(error){
   if(created){openError=error;projectForm.close();}
   else errorField.textContent=String(error);
  }finally{projectBusy=false;submit.disabled=false;}
  if(openError){
   await openProjects();
   $('projects-error').textContent='工程已保存，可从列表重试打开。'+String(openError);
  }
 };
 async function openWorldSource(){
  const source=await call('world_source');
  $('world-source-path').value=source?.directory??'';
  $('world-source-error').textContent=source?.error??'';
  $('world-source-relocate').checked=false;
  $('world-source-relocate-label').hidden=!source?.directory;
  $('world-source-dialog').showModal();
 }
 function openNewWorld(){
  if(currentSource&&!currentSource.error){openProjectForm('void');return;}
  $('new-world-name').value='虚空世界';
  $('new-world-error').textContent='';
  $('new-world-dialog').showModal();
  $('new-world-name').select();
 }
 $('new-world-start').onclick=openNewWorld;
 $('open-world-start').onclick=()=>openWorldSource().catch(error=>say(String(error)));
 $('cancel-new-world').onclick=()=>$('new-world-dialog').close();
 $('new-world-form').onsubmit=async event=>{
  event.preventDefault();
  if(busy)return;
  $('new-world-error').textContent='';
  $('create-new-world').disabled=true;
  try {
   await run(async()=>{
    let world;
    try{world=await call('create_void_world',{name:$('new-world-name').value});}
    catch(error){$('new-world-error').textContent=String(error);throw error;}
    $('new-world-dialog').close();
    await macro.open();
    const [x,y,z]=world.void_world.spawn;
    await call('browse_world',{x,y,z,view_id:crypto.randomUUID(),label:world.world,plan_id:world.plan_id});
    return {message:'已创建「'+world.world+'」 · 选择画笔，在网格上放置方块'};
   },'正在创建虚空世界…');
  }finally{$('create-new-world').disabled=false;}
 };
 $('world-source-cancel').onclick=()=>$('world-source-dialog').close();
 $('world-source-new-project').onclick=()=>{
  const directory=$('world-source-path').value;
  $('world-source-dialog').close();
  openProjectForm('save',directory);
 };
 $('world-source-form').onsubmit=async event=>{
  event.preventDefault();
  if(busy)return;
  setBusy(true);
  try{
   const directory=$('world-source-path').value;
   if($('world-source-relocate').checked)await call('relocate_world_source',{directory,confirm_legacy:true});
   else await call('save_world_source',{directory});
   $('world-source-dialog').close();
   await macro.open();
   await refresh();
  }catch(error){$('world-source-error').textContent=String(error);say(String(error));}
  finally{setBusy(false);}
 };
 async function backupCurrentProject(){
  const directory=await invoke('pick_world_directory',{initialPath:'',title:'选择工程备份的保存位置'});
  if(directory)await run(async()=>{
   await recovery.flush();
   const backup=await call('backup_project',{directory});
   return {message:'工程备份已校验 · '+backup.directory};
  },'正在备份工程…');
 }
 async function restoreBackup(){
  const directory=await invoke('pick_world_directory',{initialPath:'',title:'选择织境工程备份文件夹'});
  if(directory)await run(async()=>{
   const project=await call('restore_project_backup',{directory});
   try{await focusProject(project.id,false);}
   catch(error){return {message:'恢复完成，可从工程列表打开「'+project.name+'」 · '+String(error)};}
   return {message:'已恢复为新工程「'+project.name+'」'};
  },'正在校验并恢复工程…');
 }
 const menus={file:[['世界存档来源',openWorldSource],['建立区域规划','new-region','Ctrl+N'],['保存工作区','save','Ctrl+S'],['保存检查点','checkpoint','Ctrl+Shift+S'],null,['刷新存档','refresh','F5'],['关闭当前标签页','close','Ctrl+W']],edit:[['撤销当前编辑','undo','Ctrl+Z'],['重做当前编辑','redo','Ctrl+Y'],null,['导出方案','apply','Ctrl+Enter']],view:[['聚焦当前规划','focus','F'],['俯视','top','7'],['北向','north','1'],['东向','east','3'],null,['网格开关','grid','G'],['重置布局',()=>{localStorage.removeItem('terraweave-layout');location.reload();}]],tools:[['选择',()=>macro?.active?macro.chooseTool('select'):chooseTool('select'),'V'],['框选规划','plan-area','B'],['多边形规划','plan-polygon','O'],['绘制路线','plan-route'],['地点标记','plan-marker','M'],null,['方块画笔','paint','P'],['方块橡皮','erase','E'],['保存预览图片','capture','Ctrl+Shift+P'],['整理未引用缓存',()=>run(()=>call('compact_storage'))]],help:[['快捷键与操作','help','F1']]};
 menus.file.unshift(['切换工程',openProjects],['新建工程',()=>openProjectForm()],
  ['在新工程打开存档',()=>openProjectForm('save')],
  ['重命名当前工程',()=>askProjectRename({id:currentProjectId,name:$('project-name-label').textContent})],
  ['打开工程目录',()=>openProjectFolder(currentProjectId,'project')],
  ['备份当前工程',backupCurrentProject],['恢复工程备份',restoreBackup],null,['新建世界',openNewWorld]);
 menus.view.unshift(['全屏预览',toggleFullscreen,'F11'],['新建三维视图',newPanorama]);
 menus.view.push(['外观与主题',openAppearance],['渲染设置',context.openRenderSettings]);
 document.querySelectorAll('[data-menu]').forEach(button=>{
  button.setAttribute('aria-haspopup','menu');
  button.setAttribute('aria-expanded','false');
  function open(event,keyboard){
   event.stopPropagation();
   const rect=button.getBoundingClientRect();
   popup(menus[button.dataset.menu].map(item=>item?{
    label:item[0],key:item[2],disabled:item[1]==='close'&&(macro?.active||!activeKey),
    action:typeof item[1]==='function'?item[1]:commands[item[1]]
   }:null),rect.left,rect.bottom,{trigger:button,keyboard});
  }
  button.onpointerdown=event=>{
   if(event.button!==0)return;
   event.preventDefault();
   if(menuTrigger===button&&!menu.hidden)dismissMenu(true);
   else open(event,false);
  };
  button.onkeydown=event=>{
   if(!['Enter',' ','ArrowDown'].includes(event.key))return;
   event.preventDefault();open(event,true);
  };
 });
 document.addEventListener('pointerdown',e=>{if(!e.target.closest('#menu-popup')&&!e.target.closest('[data-menu]'))dismissMenu();});
 document.addEventListener('keydown',e=>{if(e.defaultPrevented)return;if(e.key==='Escape'){if(!menu.hidden){e.preventDefault();dismissMenu(true);}return;}if(!menu.hidden)return;if(document.querySelector('dialog[open]'))return;const editing=!!e.target.closest('input,textarea,select,[contenteditable=true]');if(macro?.active&&!editing&&!e.ctrlKey&&!e.metaKey){const keys={v:'select',b:'area',o:'polygon',p:'route',m:'marker',h:'pan'};if(keys[e.key.toLowerCase()]){e.preventDefault();macro.chooseTool(keys[e.key.toLowerCase()]);return;}if(e.key==='Delete'){e.preventDefault();macro.deleteSelected();return;}if(e.key.toLowerCase()==='f'){macro.fit();return;}if(e.key==='7'||e.key==='1'){macro.north();return;}}const key=editorShortcut(e,editing);if(key&&commands[key]){e.preventDefault();if(macro?.active&&key==='new-region')macro.chooseTool('area');else if(key==='capture')captureVisible();else if(macro?.active&&key==='save')macro.save();else commands[key]();}});
 $('enter-3d').onclick = () => {
  if (!macro?.active) return;
  if (macro.getSelected()) macro.enterDetail();
  else macro.panorama();
 };
 document.querySelector('[data-mode="live"]').onclick = () => {
  if (macro && !macro.active) macro.open().catch(e => say(String(e)));
 };
 try{const layout=JSON.parse(localStorage.getItem('terraweave-layout')??'{}');for(const name of ['left','right','bottom'])if(Number.isFinite(layout[name]))document.documentElement.style.setProperty('--'+name,layout[name]+'px');}catch{}
 document.querySelectorAll('[data-resize]').forEach(e=>e.onpointerdown=event=>{event.preventDefault();const name=e.dataset.resize,start=name==='bottom'?event.clientY:event.clientX,initial=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--'+name));document.body.classList.add('resizing');const move=ev=>{const delta=(name==='bottom'?ev.clientY:ev.clientX)-start,size=Math.max(name==='bottom'?100:170,Math.min(name==='bottom'?360:420,initial+(name==='left'?delta:-delta)));document.documentElement.style.setProperty('--'+name,size+'px');};const up=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);document.body.classList.remove('resizing');const layout={};for(const key of ['left','right','bottom'])layout[key]=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--'+key));localStorage.setItem('terraweave-layout',JSON.stringify(layout));};document.addEventListener('pointermove',move);document.addEventListener('pointerup',up);});
 function planningHistory(state){$('history-list').replaceChildren();for(const entry of [...(state.history??[])].reverse()){const row=document.createElement('div');row.className='history-row';row.append(text('span',String(entry.id+1)),text('span',entry.label,'title'),text('span','规划'),text('span',entry.at?date(entry.at):'','time'));$('history-list').append(row);}$('history-info').textContent='地图规划 · 可撤销 '+state.undo_count+' / 可重做 '+state.redo_count;$('undo').disabled=busy||!state.undo_count;$('redo').disabled=busy||!state.redo_count;$('undo-context').disabled=busy||!state.undo_count;$('redo-context').disabled=busy||!state.redo_count;$('undo').textContent='撤销规划';$('redo').textContent='重做规划';}
 refresh().then(()=>{if(!context.getRegion())say('准备就绪 · 在地图总览中选区规划');}).catch(e=>say(String(e)));
 return {recovery,restoreSession,formValues,setRegion,draftDeleted,openDraftAction,openNamedAction,rememberView,storedView,refresh:()=>refresh().catch(e=>say(String(e))),showMenu:popup,say,saveBounds,paintAt,toolChanged,run,planningHistory,bindMap(map){macro=map;},mapActive(){renderTabs();sync();},markDone(){},picked(p,state){picked={coordinate:p,key:activeKey,snapshot:context.getRegion()?.snapshot_hash};fields('d',[...p,...p]);$('picked-block').textContent=p.join(', ')+'\n'+state;$('coordinate-status').textContent=p.join(' / ');},stats(n){$('render-stats').textContent=n.toLocaleString()+' 方块';},setViewFields(view){$('layer').value=view.max_y;$('layer-number').value=view.max_y;$('single-layer').checked=view.min_y===view.max_y;$('outline').checked=view.show_selection;$('grid').checked=view.show_grid??false;$('planning-overlay').checked=view.show_plans??false;$('invisible-blocks').checked=view.show_invisible??false;document.querySelectorAll('[data-display-mode]').forEach(e=>e.classList.toggle('active',e.dataset.displayMode===(view.display_mode??'scene')));if(sessionRestored&&!sessionLoading)recovery.schedule();},setLimits(value){$('limits').textContent=value;}};
}
