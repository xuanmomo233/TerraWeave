import {callWorkbench} from './workbench-api.js';
import {MapViewport} from './map-viewport.js';
import {planBounds,planningFocusY,planningHeight} from './tools/planning-core.mjs';

const $=id=>document.getElementById(id),call=callWorkbench;
const label={area:'区域',route:'路线',marker:'标记'},icon=name=>'<svg class="icon"><use href="#i-'+name+'"/></svg>';
function node(tag,value,className){const e=document.createElement(tag);e.textContent=value;if(className)e.className=className;return e;}
export function mountMapWorkspace(context){
 let active=true,info=null,state=null,drafts=[],selectedLayer='buildings',busy=false,visibilityTimer,operations=0,selectionEpoch=0,pendingSelection;const visibility=new Map();
 let detailNavigation=null;
 let welcomeDismissed=false;
 $('continue-map-planning').onclick=()=>{welcomeDismissed=true;$('map-welcome').hidden=true;};
 function completeDetail(id){
  if(!id||detailNavigation!==id)return false;
  detailNavigation=null;
  $('detail-loading').hidden=true;
  document.body.classList.remove('loading-detail');
  return true;
 }
 function returnToMap(){
  context.editor.rememberView();
  completeDetail(detailNavigation);
  visible(true);
 }
 $('cancel-detail').onclick=returnToMap;
 const pendingKey=planId=>'plan:'+planId;
 for(const id of ['plan-name','plan-notes','plan-color','plan-width','plan-layer','plan-min-y','plan-max-y']){
  $(id).addEventListener('input',()=>{
   if(!state?.selected_id)return;
   context.editor.recovery.edit(pendingKey(state.selected_id),id,$(id).value);
   $('plan-pending-edits').hidden=false;
  });
 }
 $('discard-plan-edits').onclick=()=>{
  if(!state?.selected_id)return;
  context.editor.recovery.clear(pendingKey(state.selected_id));
  properties();
 };
 function formBusy(value){$('plan-fields').querySelectorAll('input,textarea,select,button').forEach(e=>e.disabled=value);}
 const say=context.editor.say;
 const viewport=new MapViewport($('map-canvas'),call,{
  update:geometry=>run(()=>call('save_plan',geometry)),
  snap:context.getPlanSnap,
  sketchChanged:context.sketchChanged,
  select:plan_id=>selectPlan(plan_id),
  detail:point=>enterDetail(point),
  hover:p=>{$('coordinate-status').textContent='X '+p[0]+(viewport.view.slice_y==null?'':' / Y '+viewport.view.slice_y)+' / Z '+p[1];},
  view:updateHeightLabel,
  saveView:view=>call('save_map_view',{view}).catch(()=>{}),
  progress:remaining=>{$('map-loading').hidden=!remaining;$('map-loading').textContent='正在读取实际地形 · '+remaining+' 个图块';},
  error:say,
 });
 function updateHeightLabel(v){
  const sliced=v.slice_y!=null;
  $('map-angle').value=String(Math.round(v.rotation*10)/10);
  $('map-height').textContent=sliced?'Y · '+v.slice_y:'Y · 地表';
  $('map-height').classList.toggle('chosen',sliced);
  if(active){
   $('source-status').textContent=!info?.world_uuid?'二维规划 · 未关联存档':info.void_world?'虚空世界 · '+info.world:sliced?'存档切片 Y '+v.slice_y+' + 规划':'已保存世界地表 + 规划';
   $('render-stats').textContent='1 px ≈ '+v.scale.toFixed(2)+' m';
  }
  context.sketchChanged?.();
 }
 function visible(value){active=value;$('map-host').hidden=!value;context.canvas.hidden=value;$('map-controls').hidden=!value;$('detail-controls').hidden=value;$('detail-switches').hidden=value;$('detail-axis').hidden=value;$('map-tools').hidden=!value;$('detail-tools').hidden=value;$('map-inspector').hidden=!value;$('inspector').hidden=value;$('project-tree').hidden=true;$('planning-tree').hidden=false;$('world-map-tab').classList.toggle('active',value);context.editor.mapActive(value);context.sketchChanged?.();if(value){$('empty-view').hidden=true;$('source-state').textContent='地图规划';$('source-status').textContent='已保存世界地表 + 规划';$('view-badge').textContent='地图总览';$('control-hint').textContent='拖动平移 · 右键旋转 · 滚轮缩放 · 双击进入三维';viewport.resize();} }
 function adopt(next){if(state&&next.revision<state.revision)return;state=next;if(pendingSelection!==undefined&&(!pendingSelection||state.objects.some(p=>p.id===pendingSelection)))state.selected_id=pendingSelection;for(const [key,pending]of visibility){const [kind,id]=key.split(':');const item=(kind==='layer'?state.layers:state.objects).find(p=>p.id===id);if(item)item.visible=pending.value;}}
 function paint(){if(!state)return;$('map-welcome').hidden=welcomeDismissed||!info||!!info.world_uuid;viewport.setPlanning(state);tree();properties();context.editor.mapActive(active);if(active)context.editor.planningHistory(state);}
 async function selectPlan(id){const ticket=++selectionEpoch;pendingSelection=id??null;state.selected_id=pendingSelection;viewport.setPlanning(state);$('planning-tree').querySelectorAll('[data-plan-id]').forEach(row=>row.classList.toggle('selected',row.dataset.planId===state.selected_id));properties();context.editor.mapActive(active);try{const next=await call('select_plan',id?{plan_id:id}:{});if(ticket===selectionEpoch){pendingSelection=undefined;adopt(next);paint();}}catch(error){if(ticket===selectionEpoch){pendingSelection=undefined;await refresh();say(String(error));}}}
 function toggleVisibility(kind,id,value){const key=kind+':'+id,pending={value};visibility.set(key,pending);const item=(kind==='layer'?state.layers:state.objects).find(p=>p.id===id);if(item)item.visible=value;paint();return run(async()=>{try{return await call(kind==='layer'?'update_layer':'save_plan',kind==='layer'?{layer_id:id,visible:value}:{plan_id:id,visible:value});}finally{if(visibility.get(key)===pending)visibility.delete(key);}});}
 async function refresh(data){if(!info)info=await call('world_map_info');const snapshot=data??await call('ui_snapshot');adopt(snapshot.planning);drafts=snapshot.drafts.filter(d=>!d.archived);if(!state.layers.some(l=>l.id===selectedLayer))selectedLayer=state.layers[0]?.id;paint();const r=context.getRegion?.(),d=drafts.find(d=>d.id===r?.draft_id);if(!active&&d&&r.design_visible!==d.design_visible){clearTimeout(visibilityTimer);visibilityTimer=setTimeout(()=>{if(!active&&context.getRegion?.()?.draft_id===d.id)call('preview_draft',{draft_id:d.id,mode:r.preview_mode??'target',keep_camera:true}).catch(()=>{});},250);}}
 async function open(viewOverride){returnToMap();const [nextInfo,data]=await Promise.all([call('world_map_info'),call('ui_snapshot')]);info=nextInfo;adopt(data.planning);drafts=data.drafts.filter(d=>!d.archived);await viewport.open(info,state,viewOverride??info.view);updateHeightLabel(viewport.view);paint();say('地图总览已就绪 · 在整张地图上划区、连接道路和添加标记');return {world_uuid:info.world_uuid,planning_revision:state.revision,map_bounds:info.bounds};}
 async function run(fn,refreshDrafts=true){operations++;busy=true;formBusy(true);try{const r=await fn();if(r?.layers&&r?.objects){adopt(r);paint();if(refreshDrafts&&drafts.length)await refresh();}else await refresh();say('规划已保存 · Ctrl+Z 可撤销');return r;}catch(e){await refresh();say(String(e));}finally{operations--;busy=operations>0;formBusy(busy);}}
 function tree(){
  if(!state)return;const root=$('planning-tree'),query=$('tree-search').value.toLowerCase().trim();root.replaceChildren();const bytes=Number($('storage-summary').dataset.bytes);$('storage-summary').textContent=state.objects.length+' 项规划 · '+drafts.length+' 个方案'+(Number.isFinite(bytes)?' · '+(bytes/1048576).toFixed(1)+' MB':'');
  for(const layer of state.layers){
   const title=document.createElement('div');
   title.className='planning-layer'+(selectedLayer===layer.id?' selected':'');
   title.dataset.layerId=layer.id;
   title.setAttribute('role','treeitem');
   title.tabIndex=0;
   title.innerHTML=icon('folder');
   const name=node('span',layer.name,'name');
   name.onclick = async () => {
    if (!active) await open();
    selectedLayer = layer.id;
    if (state.selected_id) await selectPlan(null);
    else paint();
   };
   const eye=document.createElement('button'),visibility=layer.visible?'隐藏图层':'显示图层';
   eye.innerHTML=icon('eye');eye.style.opacity=layer.visible?1:.35;
   eye.title=visibility;eye.setAttribute('aria-label',visibility);
   eye.onclick=()=>toggleVisibility('layer',layer.id,!layer.visible);
   const menu=(x,y)=>context.editor.showMenu([
    {label:'重命名图层',action:()=>layerAction('rename',layer)},
    {label:visibility,action:eye.onclick},
    null,
    {label:'删除图层',action:()=>layerAction('delete',layer)}
   ],x,y);
   title.oncontextmenu=e=>{e.preventDefault();menu(e.clientX,e.clientY);};
   title.onkeydown=e=>{
    if(e.target!==title)return;
    if(e.key==='ContextMenu'||e.shiftKey&&e.key==='F10'){
     e.preventDefault();
     const rect=title.getBoundingClientRect();menu(rect.left,rect.bottom);
    }else if(e.key==='Enter'){e.preventDefault();name.click();}
   };
   title.append(name,eye);root.append(title);
   for(const p of state.objects.filter(p=>p.layer_id===layer.id&&p.name.toLowerCase().includes(query))){const row=document.createElement('div');row.dataset.planId=p.id;row.className='planning-object'+(p.id===state.selected_id?' selected':'')+(!p.visible||!layer.visible?' hidden-object':'');const swatch=node('span','','swatch');swatch.style.background=p.color;const text=node('span',p.name,'name');text.title=label[p.type]+' · '+p.name;text.onclick=()=>{const choose=()=>{selectPlan(p.id);viewport.focus(p);};if(!active)open().then(choose);else choose();};const pe=document.createElement('button');pe.className='eye';pe.innerHTML=icon('eye');pe.style.opacity=p.visible?1:.3;pe.title=p.visible?'隐藏规划':'显示规划';pe.onclick=()=>toggleVisibility('plan',p.id,!p.visible);row.append(swatch,text,pe);root.append(row);row.oncontextmenu=e=>{e.preventDefault();selectPlan(p.id);context.editor.showMenu([{label:'聚焦规划',action:()=>viewport.focus(p)},{label:'进入三维细化',action:()=>enterDetail()},null,{label:p.visible?'隐藏规划':'显示规划',action:()=>toggleVisibility('plan',p.id,!p.visible)},{label:'重命名',action:()=>$('plan-name').select()},{label:'删除规划',key:'Delete',action:()=>run(()=>call('delete_plan',{plan_id:p.id}))}],e.clientX,e.clientY);};
    for(const d of drafts.filter(d=>d.plan_id===p.id||!d.plan_id&&p.detail_entity_id&&d.base_entity_id===p.detail_entity_id))draftRow(d,root);
   }
  }
  const independent=drafts.filter(d=>!state.objects.some(p=>d.plan_id===p.id||!d.plan_id&&p.detail_entity_id&&d.base_entity_id===p.detail_entity_id));if(independent.length){root.append(node('div','独立设计方案','planning-layer'));for(const d of independent)draftRow(d,root);}
 }
 function draftRow(d,root){
  const child=document.createElement('div');
  child.className='planning-object draft'+(d.design_visible===false?' hidden-object':'');
  child.dataset.draftId=d.id;
  child.setAttribute('role','treeitem');
  child.tabIndex=0;
  const open=()=>context.editor.run(()=>call('preview_draft',{draft_id:d.id}));
  const toggle=()=>context.editor.run(()=>call('update_draft',{draft_id:d.id,visible:d.visible===false}));
  const visibility=d.visible===false?'显示方案':'隐藏方案';
  const name=node('span',d.label+' · r'+d.revision,'name');
  name.onclick=open;
  const eye=document.createElement('button');
  eye.className='eye';eye.innerHTML=icon('eye');eye.title=visibility;eye.setAttribute('aria-label',visibility);
  eye.style.opacity=d.visible===false?.3:1;eye.onclick=toggle;
  const menu=(x,y)=>context.editor.showMenu([
   {label:'打开方案',action:open},
   {label:'重命名',action:()=>context.editor.openDraftAction('rename',d)},
   {label:visibility,action:toggle},
   null,
   {label:'删除方案',action:()=>context.editor.openDraftAction('delete',d)}
  ],x,y);
  child.oncontextmenu=event=>{event.preventDefault();menu(event.clientX,event.clientY);};
  child.onkeydown=event=>{
   if(event.target!==child)return;
   if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){
    event.preventDefault();
    const rect=child.getBoundingClientRect();menu(rect.left,rect.bottom);
   }else if(event.key==='Enter'){event.preventDefault();open();}
  };
  child.append(name,eye);root.append(child);
 }
 function layerAction(action,layer){
  if(!layer)return;
  const count=state.objects.filter(p=>p.layer_id===layer.id).length;
  context.editor.openNamedAction({action,name:layer.name,kind:'图层',deleteLabel:'删除图层',
   description:'删除「'+layer.name+'」'+(count?'及图层内的 '+count+' 项规划':'')+'。此操作可撤销。',
   confirm:name=>run(()=>call(action==='delete'?'delete_layer':'update_layer',{layer_id:layer.id,...(action==='rename'?{name}:{})}))});
 }
 function properties(){
  if(!state)return;const selected=state.objects.find(p=>p.id===state.selected_id);$('plan-fields').hidden=!selected;$('map-property-title').textContent=selected?label[selected.type]+'规划':'世界地图';
  $('map-world-info').textContent=info?.bounds?'已保存范围 X '+info.bounds[0]+'–'+info.bounds[2]+'\nZ '+info.bounds[1]+'–'+info.bounds[3]+'\n未知地形以斜线显示，已生成空域保持空白。':'';
  $('layer-settings').hidden = Boolean(selected);
  $('map-world-info').hidden = Boolean(selected);
  if (!selected) $('layer-name').value = state.layers.find(layer => layer.id === selectedLayer)?.name ?? '';
  if(!selected)return;
  selectedLayer=selected.layer_id;
  $('plan-layer').replaceChildren(...state.layers.map(layer=>new Option(layer.name,layer.id)));
  $('plan-pending-edits').hidden=!context.editor.formValues(pendingKey(selected.id),{
   'plan-name':selected.name,'plan-notes':selected.notes,'plan-color':selected.color,'plan-width':selected.width,
   'plan-min-y':selected.min_y??'','plan-max-y':selected.max_y??'','plan-layer':selected.layer_id
  });
  $('plan-visible').checked=selected.visible;
  $('plan-width-label').hidden=selected.type!=='route';
  const b=planBounds(selected),format=n=>Math.round(n*100)/100;
  $('plan-geometry').textContent=selected.points.length+' 个控制点\n范围 X '+format(b[0])+'–'+format(b[2])+' / Z '+format(b[1])+'–'+format(b[3])+'\n跨度 '+format(b[2]-b[0])+' × '+format(b[3]-b[1])+' m'+
   (selected.min_y==null?'\n高度沿用地表':'\n规划高度 Y '+selected.min_y+(selected.max_y===selected.min_y?'':'–'+(selected.max_y??selected.min_y)));
  $('layer-name').value=state.layers.find(l=>l.id===selectedLayer)?.name??'';
 }
 function chooseLayer(name){
  if(['buildings','roads','markers'].includes(selectedLayer))selectedLayer=name==='route'?'roads':name==='marker'?'markers':'buildings';
  if(!state.layers.some(l=>l.id===selectedLayer))selectedLayer=state.layers[0]?.id;
 }
 function createPlan(geometry){
  selectionEpoch++;
  pendingSelection=undefined;
  return run(()=>call('save_plan',{...geometry,layer_id:selectedLayer}),false);
 }
 async function createPlanning(geometry){
  if(!state)await refresh();
  chooseLayer(geometry.type);
  return createPlan(geometry);
 }
 function chooseTool(name){if(viewport.sketch.saving)return;if(!active){open().then(()=>chooseTool(name)).catch(e=>say(String(e)));return;}chooseLayer(name);viewport.setTool(name);for (const button of document.querySelectorAll('[data-map-tool]')) {
   const current = button.dataset.mapTool === name;
   button.classList.toggle('active', current);
   button.setAttribute('aria-pressed', String(current));
  }$('control-hint').textContent={select:'左键选择规划 · 拖动空白平移 · 右键旋转',area:'拖动或点击两个角点 · Enter 保存',polygon:'逐点绘制多边形 · 拖动顶点调整 · Enter 保存',route:'逐点绘制路线 · Enter 保存',marker:'点击定位标记 · Enter 保存',pan:'拖动平移 · 右键旋转 · 滚轮缩放'}[name];}
 async function enterDetail(point){
  const selected=state?.objects.find(p=>p.id===state.selected_id),bounds=selected?planBounds(selected):null;
  const belongs=point&&bounds&&point[0]>=bounds[0]&&point[0]<=bounds[2]&&point[1]>=bounds[1]&&point[1]<=bounds[3];
  await context.editor.run(async()=>{
   const navigation_id=active?crypto.randomUUID():undefined;
   if(navigation_id){
    detailNavigation=navigation_id;
    $('detail-loading-name').textContent=selected&&(!point||belongs)?selected.name:'三维细化';
    $('detail-loading').hidden=false;
    document.body.classList.add('loading-detail');
    visible(false);
    $('source-state').textContent='正在打开三维';
   }
   try{
    const y=viewport.view.slice_y??(belongs?planningFocusY(selected):undefined);
    const options={allow_saved:true,navigation_id,view_id:crypto.randomUUID(),y};
    return selected&&!point
     ?await call('open_plan_detail',{...options,plan_id:selected.id})
     :await call('browse_world',{...options,x:point?.[0]??Math.round(viewport.view.x),z:point?.[1]??Math.round(viewport.view.z),plan_id:belongs?selected.id:undefined});
   }finally{
    if(completeDetail(navigation_id))visible(true);
   }
  },'正在打开三维细化…');
 }
 const panorama=()=>context.resumePanorama?.()?Promise.resolve():context.editor.run(()=>call('open_world_scene'),'正在读取完整模型与贴图…');
 $('world-map-tab').onclick=()=>open().catch(e=>say(String(e)));
 document.querySelectorAll('[data-map-tool]').forEach(e=>e.onclick=()=>chooseTool(e.dataset.mapTool));
 $('map-fit').onclick=()=>viewport.fit(info?.bounds);$('map-focus').onclick=()=>{const p=state?.objects.find(p=>p.id===state.selected_id);if(p)viewport.focus(p);else viewport.fit(info?.bounds);};$('map-north').onclick=()=>{viewport.view.rotation=0;viewport.request();viewport.draw();viewport.notify();};$('map-angle').onchange=()=>{const n=Number($('map-angle').value);if(!Number.isFinite(n))return;viewport.view.rotation=(n%360+360)%360;viewport.request();viewport.draw();viewport.notify();};$('map-refresh').onclick=()=>context.editor.run(()=>call('open_map',{refresh:true}));
 const readHeight=id=>$(id).value===''?null:$(id).valueAsNumber;
 function draftHeight(){
  const min=readHeight('sketch-min-y'),max=readHeight('sketch-max-y');
  return min===null&&max===null?planningHeight(viewport.view.slice_y,null):planningHeight(min,max);
 }
 $('save-plan').onclick=()=>{
  const p=state.objects.find(p=>p.id===state.selected_id);
  if(!p)return;
  return run(async()=>{
   const height=planningHeight(readHeight('plan-min-y'),readHeight('plan-max-y'));
   const args={plan_id:p.id,name:$('plan-name').value,notes:$('plan-notes').value,color:$('plan-color').value,width:Number($('plan-width').value),layer_id:$('plan-layer').value,visible:$('plan-visible').checked,...height};
   const result=await call('save_plan',args);
   context.editor.recovery.clear(pendingKey(p.id));
   return result;
  });
 };
 const heightDialog=$('map-height-dialog');
 $('map-height').onclick=()=>{
  $('map-slice-y').value=viewport.view.slice_y??planningFocusY(state?.objects.find(p=>p.id===state.selected_id))??'';
  heightDialog.showModal();
 };
 $('map-height-cancel').onclick=()=>heightDialog.close();
 $('map-surface-mode').onclick=()=>{viewport.setSlice(null);heightDialog.close();};
 $('map-height-form').onsubmit=e=>{
  e.preventDefault();
  viewport.setSlice($('map-slice-y').valueAsNumber);
  heightDialog.close();
 };
 $('plan-visible').onchange=()=>{if(state?.selected_id)toggleVisibility('plan',state.selected_id,$('plan-visible').checked);};$('delete-plan').onclick=()=>{if(state.selected_id)run(()=>call('delete_plan',{plan_id:state.selected_id}));};$('plan-detail').onclick=()=>enterDetail();
 $('add-layer').onclick=()=>run(()=>call('create_layer',{name:'规划图层 '+(state?.layers.length+1)}));$('rename-layer').onclick=()=>run(()=>call('update_layer',{layer_id:selectedLayer,name:$('layer-name').value}));$('delete-layer').onclick=()=>layerAction('delete',state.layers.find(l=>l.id===selectedLayer));
 $('tree-search').addEventListener('input',tree);
 async function capture(request){
  const [map,plans]=await Promise.all([call('world_map_info'),call('planning_state')]);
  if(plans.revision!==request.planning_revision)throw Error('规划版本已变化，请重新请求截图');
  if(request.world_revision!==undefined&&map.revision!==request.world_revision)throw Error('存档地表已变化，请重新请求截图');
  return viewport.capture(request,map,plans);
 }
 return {get active(){return active;},open,refresh,panorama,showDetail(){visible(false);},acceptsDetail:id=>!id||detailNavigation===id,completeDetail,chooseTool,createPlanning,draftHeight,sketch:viewport.sketch,redrawSketch:()=>viewport.drawSketch(),locate:(point,focus)=>viewport.locate(point,focus),enterDetail,fit(){const p=state?.objects.find(p=>p.id===state.selected_id);viewport.fit(p?planBounds(p):info?.bounds);},north(){viewport.view.rotation=0;viewport.request();viewport.draw();viewport.notify();},undo:redo=>run(()=>call(redo?'redo_plan':'undo_plan')),deleteSelected:()=>$('delete-plan').onclick(),save:()=>state?.selected_id?$('save-plan').onclick():context.editor.run(()=>call('save_workspace')),capture,getView:()=>({...viewport.view}),getState:()=>state,getSelected:()=>state?.objects.find(p=>p.id===state.selected_id),selectLocal:chooseTool};
}
