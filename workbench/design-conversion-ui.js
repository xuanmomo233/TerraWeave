import {invoke} from '@tauri-apps/api/core';
import {callWorkbench} from './workbench-api.js';

export function mountDesignConversion(){
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
   status.textContent='方案已生成 · 目标版本 '+converted.target_version;
  }catch(failure){
   checked=undefined;
   error.textContent=String(failure);
  }finally{setBusy(false);}
 };
 element('close').onclick=()=>dialog.close();
 dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
 return ()=>{
  if(dialog.open)return;
  path.value='';
  reset();
  dialog.showModal();
 };
}
