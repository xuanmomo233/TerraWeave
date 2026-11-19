import {invoke} from '@tauri-apps/api/core';
import {callWorkbench} from './workbench-api.js';

export function mountRenderSettings({selected,apply}){
 const $=id=>document.getElementById(id),dialog=$('render-settings-dialog'),list=$('render-pack-list');
 const shader=$('render-shader'),save=$('render-settings-save'),close=$('render-settings-close'),status=$('render-settings-error');
 let catalog,order,request=0,saving=false;
 function row(name){
  const entry=document.createElement('li'), label=document.createElement('span'),actions=document.createElement('div');
  label.textContent=name;label.className='render-pack-name';
  actions.className='render-pack-actions';entry.append(label,actions);
  const index=order.indexOf(name);
  function button(text,action,disabled=false){
   const b=document.createElement('button');
   b.type='button';b.textContent=text;b.disabled=disabled||saving;
   b.setAttribute('aria-label',text+' '+name);
   b.onclick=()=>{
    action();draw();
    const updated=[...list.querySelectorAll('li')].find(item=>item.querySelector('.render-pack-name').textContent===name);
    (updated?.querySelector('button[aria-label="'+CSS.escape(b.getAttribute('aria-label'))+'"]:not(:disabled)')??
      updated?.querySelector('button:not(:disabled)'))?.focus();
   };
   actions.append(b);
  }
  button(index<0?'启用':'停用',()=>index<0?order.push(name):order.splice(index,1));
  if(index>=0){
   button('上移',()=>[order[index],order[index-1]]=[order[index-1],order[index]],index===0);
   button('下移',()=>[order[index],order[index+1]]=[order[index+1],order[index]],index===order.length-1);
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
    const option=new Option(s.name+(s.supported?'':'（不兼容）'),s.id);
    option.disabled=!s.supported;
    return option;
   }));
   const unsupported=catalog.shaders.filter(s=>!s.supported);
   $('shader-compatibility').hidden=!unsupported.length;
   $('shader-compatibility-list').replaceChildren(...unsupported.map(s=>{
    const row=document.createElement('li'),name=document.createElement('strong'),reason=document.createElement('span');
    name.textContent=s.name;reason.textContent=s.issues.join('；');
    row.append(name,reason);
    return row;
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
  $('shader-compatibility').hidden=true;
  $('shader-compatibility').open=false;
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
 close.onclick=()=>{if(!saving)dialog.close();};
 dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
 save.onclick=async()=>{
  if(saving)return;
  saving=true;
  const controls=[...dialog.querySelectorAll('button,select')].filter(button=>!button.disabled);
  const nextShader=shader.value,nextOrder=[...order];
  for(const control of controls)control.disabled=true;
  status.textContent='正在应用渲染设置…';
  try{
   const before=selected();
   if(nextShader!=='off'){
    status.textContent='正在校验原版光影…';
    const pack=await callWorkbench('iris_pack_source',{shader:nextShader});
    await invoke('iris_check_pack',{pack});
   }
   const settings=await callWorkbench('save_render_settings',{pack_order:nextOrder,shader:nextShader});
   dialog.close();
   await apply(settings,before);
  }catch(error){status.textContent=String(error);}
  finally{saving=false;for(const control of controls)control.disabled=false;}
 };
 return open;
}
