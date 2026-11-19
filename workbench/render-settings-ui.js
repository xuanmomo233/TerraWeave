import {invoke} from '@tauri-apps/api/core';
import {callWorkbench} from './workbench-api.js';

export function mountRenderSettings({selected,apply}){
 const $=id=>document.getElementById(id),dialog=$('render-settings-dialog'),list=$('render-pack-list');
 const shader=$('render-shader'),save=$('render-settings-save'),status=$('render-settings-error');
 let catalog,order,request=0,saving=false;
 function row(name){
  const entry=document.createElement('li'),label=document.createElement('span');
  label.textContent=name;entry.append(label);
  const index=order.indexOf(name);
  function button(text,action,disabled=false){
   const b=document.createElement('button');
   b.type='button';b.textContent=text;b.disabled=disabled;b.onclick=()=>{action();draw();};
   entry.append(b);
  }
  button(index<0?'启用':'停用',()=>index<0?order.push(name):order.splice(index,1));
  if(index>=0){
   button('↓ 提高',()=>[order[index],order[index+1]]=[order[index+1],order[index]],index===order.length-1);
   button('↑ 降低',()=>[order[index],order[index-1]]=[order[index-1],order[index]],index===0);
  }
  return entry;
 }
 function draw(){list.replaceChildren(...[...order,...catalog.packs.filter(n=>!order.includes(n))].map(row));}
 async function refresh(reset){
  const id=++request;
  try{
   const next=await callWorkbench('render_settings');
   if(id!==request||!dialog.open||saving)return;
   const selectedShader=reset?next.shader:shader.value;
   order=(reset?next.pack_order:order).filter(n=>next.packs.includes(n));
   catalog=next;
   draw();
   shader.replaceChildren(new Option('关闭光影','off'),...catalog.shaders.map(s=>{
    const option=new Option(s.name+(s.supported?'':' · '+s.issues.join(' / ')),s.id);
    option.disabled=!s.supported;
    return option;
   }));
   shader.value=selectedShader;
   if(!shader.value)shader.value='off';
   status.textContent=catalog.shader_error??'';
   save.disabled=false;
  }catch(error){if(id===request&&dialog.open)status.textContent=String(error);}
 }
 async function open(){
  if(dialog.open)return;
  catalog=null;
  list.replaceChildren();
  shader.replaceChildren(new Option('关闭光影','off'));
  status.textContent='';
  save.disabled=true;
  dialog.showModal();
  await refresh(true);
 }
 for(const [id,kind] of [['open-resourcepacks','resourcepacks'],['open-shaderpacks','shaderpacks']]){
  $(id).onclick=async()=>{
   try{await invoke('open_pack_folder',{kind});}
   catch(error){status.textContent=String(error);}
  };
 }
 window.addEventListener('focus',()=>{if(dialog.open&&catalog&&!saving)void refresh(false);});
 $('render-settings-close').onclick=()=>dialog.close();
 save.onclick=async()=>{
  saving=true;
  save.disabled=true;
  try{
   const before=selected();
   if(shader.value!=='off'){
    status.textContent='正在校验原版光影…';
    const pack=await callWorkbench('iris_pack_source',{shader:shader.value});
    await invoke('iris_check_pack',{pack});
   }
   const settings=await callWorkbench('save_render_settings',{pack_order:order,shader:shader.value});
   dialog.close();
   await apply(settings,before);
  }catch(error){status.textContent=String(error);}
  finally{saving=false;save.disabled=false;}
 };
 return open;
}
