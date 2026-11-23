import {invoke} from '@tauri-apps/api/core';
import {javaReleases} from './minecraft-version.js';
import {callWorkbench} from './workbench-api.js';

export function mountDesignConversion(openExports){
 const element=name=>document.getElementById('design-conversion-'+name);
 const dialog=element('dialog'),path=element('path'),status=element('status'),error=element('error');
 const save=element('save'),result=element('result'),output=element('output'),issues=element('issues');
 const pages=element('pages'),previous=element('prev'),next=element('next');
 const replacements=new Map();
 let checked,checkedReplacements={},busy=false;

 function setBusy(value){
  busy=value;
  for(const name of ['path','browse','check','close'])element(name).disabled=value;
  for(const input of issues.querySelectorAll('input'))input.disabled=value;
  save.disabled=value||!checked?.analysis_token;
 }
 function reset(){
  replacements.clear();
  checked=undefined;
  issues.replaceChildren();
  issues.hidden=pages.hidden=result.hidden=true;
  save.disabled=true;
  status.textContent=error.textContent='';
 }
 function showAnalysis(report){
  const {counts,incompatible}=report;
  status.textContent=report.source_version+' → '+report.target_version+' · '+report.target_world+
   ' · 直接兼容 '+counts.exact+' · 已适配 '+counts.adapted+' · 指定替换 '+counts.replaced+' · 待处理 '+counts.blocked+
   (report.analysis_token?' · 将替换目标已有方块 '+report.target_blocks_replaced:'');
  issues.replaceChildren();
  for(const issue of incompatible){
   const row=document.createElement('li'),state=document.createElement('code'),details=document.createElement('small');
   const replacement=document.createElement('input');
   state.textContent=issue.state;
   details.textContent=issue.reason+' · '+issue.count+' 处 · '+issue.positions.join(' / ');
   replacement.placeholder='输入目标版本的方块状态';
   replacement.maxLength=512;
   replacement.setAttribute('aria-label','替换 '+issue.state);
   replacement.value=replacements.get(issue.state)??'';
   replacement.oninput=()=>{
    const value=replacement.value.trim();
    if(value)replacements.set(issue.state,value);
    else replacements.delete(issue.state);
    save.disabled=true;
   };
   row.append(state,details,replacement);issues.append(row);
  }
  issues.hidden=!incompatible.length;
  pages.hidden=report.previous_issue_offset===null&&report.next_issue_offset===null;
  previous.disabled=report.previous_issue_offset===null;
  previous.onclick=()=>check(report.previous_issue_offset,false);
  next.disabled=report.next_issue_offset===null;
  next.onclick=()=>check(report.next_issue_offset,false);
  if(report.target_error)error.textContent=report.target_error;
 }
 async function check(offset=0,applyReplacements=true){
  if(busy||!path.reportValidity())return;
  checked=undefined;
  result.hidden=true;
  error.textContent='';
  status.textContent='正在检查目标版本和方块…';
  setBusy(true);
  try{
   if(applyReplacements)checkedReplacements=Object.fromEntries(replacements);
   const report=await callWorkbench('analyze_design_conversion',{
    export_path:path.value,replacements:checkedReplacements,issue_offset:offset
   });
   checked=report;
   showAnalysis(report);
  }catch(failure){
   error.textContent=String(failure);
   status.textContent='';
  }finally{setBusy(false);}
 }
 element('form').onsubmit=event=>{event.preventDefault();void check();};
 path.oninput=reset;
 element('browse').onclick=async()=>{
  try{
   const selected=await invoke('pick_design_export');
   if(selected&&dialog.open){path.value=selected;reset();await check();}
  }catch(failure){error.textContent=String(failure);}
 };
 save.onclick=async()=>{
  if(!checked?.analysis_token||busy)return;
  const token=checked.analysis_token;
  error.textContent='';
  setBusy(true);
  try{
   const converted=await callWorkbench('convert_design_export',{
    export_path:path.value,replacements:checkedReplacements,analysis_token:token
   });
   output.value=converted.path;
   result.hidden=false;
   output.select();
   status.textContent='建筑已导出 · 目标版本 '+converted.target_version;
  }catch(failure){
   checked=undefined;
   error.textContent=String(failure);
  }finally{setBusy(false);}
 };
 element('close').onclick=()=>dialog.close();
 element('open-folder').onclick=openExports;
 dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
 return ()=>{
  if(dialog.open)return;
  path.value='';
  reset();
  dialog.showModal();
 };
}

export function mountWorldVersionAudit(openExports){
 const element=name=>document.getElementById('world-version-'+name);
 const dialog=element('dialog'),target=element('target'),check=element('check'),status=element('status'),error=element('error');
 const source=element('source'),issues=element('issues'),result=element('result');
 const versions=Object.keys(javaReleases);
 const kinds={incompatible_block:'方块待替换',adapted_block:'可适配方块',item:'缺少物品',entity:'缺少实体',
  block_entity:'缺少方块实体',check_data:'需复核',unreadable:'读取失败'};
 let busy=false;
 target.onchange=()=>{status.textContent='';error.textContent='';issues.hidden=result.hidden=true;};
 element('form').onsubmit=async event=>{
  event.preventDefault();
  if(busy||check.disabled)return;
  busy=check.disabled=target.disabled=true;
  error.textContent='';
  issues.hidden=result.hidden=true;
  status.textContent='正在扫描已保存的区块和数据文件…';
  try{
   const report=await callWorkbench('audit_world_version',{target_version:target.value});
   const counts=Object.entries(report.counts).filter(([,count])=>count).map(([name,count])=>kinds[name]+' '+count);
   status.textContent='已读取 '+report.scope.terrain_chunks+' 个地形区块 · '+counts.join(' · ');
   issues.replaceChildren();
   for(const issue of report.issues){
    const row=document.createElement('li');
    const title=document.createElement('strong'),detail=document.createElement('small');
    title.textContent=kinds[issue.kind]+' · '+issue.id;
    detail.textContent=issue.reason+' · '+issue.count+' 处 · '+issue.samples[0];
    row.append(title,detail);issues.append(row);
   }
   issues.hidden=!report.issues.length;
   element('report').value=report.report_path;
   result.hidden=false;
  }catch(failure){
   status.textContent='';
   error.textContent=String(failure);
  }finally{busy=check.disabled=target.disabled=false;}
 };
 element('folder').onclick=openExports;
 element('close').onclick=()=>dialog.close();
 return async()=>{
  if(dialog.open||busy)return;
  target.replaceChildren();
  target.onchange();
  check.disabled=true;
  source.textContent='正在读取当前工程的存档…';
  dialog.showModal();
  try{
   const info=await callWorkbench('world_map_info');
   if(!dialog.open)return;
   if(!info.world_uuid)throw Error('请先在当前工程关联要检查的 Java 版存档');
   source.textContent=info.world+' · 当前版本 '+info.minecraft;
   const options=versions.filter(version=>version!==info.minecraft);
   for(const version of options)target.append(new Option(version,version));
   target.value=versions[versions.indexOf(info.minecraft)-1]??options.at(-1);
   check.disabled=false;
  }catch(failure){source.textContent='当前工程';error.textContent=String(failure);}
 };
}
