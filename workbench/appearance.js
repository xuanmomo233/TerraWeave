import {fields,presets,presetTheme,parseTheme,inkFor} from './theme-model.js';

const KEY='terraweave.appearance.v2',legacyKey='terraweave.appearance.v1';
let saved=presetTheme();
try {
 const current=localStorage.getItem(KEY),old=localStorage.getItem(legacyKey);
 if(current||old)saved=parseTheme(JSON.parse(current??old));
 if(old){localStorage.setItem(KEY,JSON.stringify(saved));localStorage.removeItem(legacyKey);}
}catch{}
function apply(theme){
 const style=document.documentElement.style;
 for(const [key,color] of Object.entries(theme.colors))style.setProperty('--'+key,color);
 style.setProperty('--ui-size',theme.fontSize+'px');
 style.setProperty('--on-accent',inkFor(theme.colors.accent));
 style.colorScheme=inkFor(theme.colors.panel)==='#000000'?'light':'dark';
 window.dispatchEvent(new CustomEvent('workbench-appearance',{detail:theme}));
}
apply(saved);
const $ = id => document.getElementById(id);
let draft;
let generation = 0;
const dialog = $('appearance-dialog');
const notify = text => $('appearance-error').textContent = text;
function redraw() {
  apply(draft);
  for (const input of dialog.querySelectorAll('[data-color]')) input.value = draft.colors[input.dataset.color];
  for (const button of dialog.querySelectorAll('[data-preset]')) button.setAttribute('aria-pressed', String(button.dataset.preset === draft.preset));
  $('appearance-size').value=draft.fontSize;
  $('appearance-size-value').value=draft.fontSize+' px';
  for(const input of dialog.querySelectorAll('[data-hex]'))input.value=draft.colors[input.dataset.hex];
}
for (const [id, [name]] of Object.entries(presets)) {
  const button = document.createElement('button');
  button.type='button'; button.dataset.preset=id; button.textContent=name;
  const tile=document.createElement('span'); tile.className='theme-sample';tile.setAttribute('aria-hidden','true');
  const colors=presetTheme(id).colors;
  tile.style.cssText='--sample-panel:'+colors.panel+';--sample-field:'+colors.field+';--sample-accent:'+colors.accent+';--sample-border:'+colors.line;
  button.prepend(tile);
  button.onclick=()=>{++generation; draft=presetTheme(id,draft.fontSize);notify('');redraw();};
  $('appearance-presets').append(button);
}
for (const [key,name] of Object.entries(fields)) {
  const label=document.createElement('label'), input=document.createElement('input');
  label.textContent=name; input.type='color'; input.dataset.color=key;
  const group=document.createElement('div'),hex=document.createElement('input');
  group.className='theme-color';
  input.id='theme-color-'+key; label.htmlFor=input.id;
  hex.type='text'; hex.dataset.hex=key; hex.maxLength=7;
  hex.setAttribute('aria-label',name+'十六进制颜色');
  hex.pattern='#[0-9a-fA-F]{6}';hex.spellcheck=false;
  input.oninput=()=>{draft.colors[key]=input.value;hex.value=input.value;apply(draft);};
  hex.oninput=()=>{if(/^#[0-9a-f]{6}$/i.test(hex.value)){draft.colors[key]=hex.value.toLowerCase();input.value=hex.value;apply(draft);}};
  hex.onblur=()=>{hex.value=draft.colors[key];};
  group.append(label,input,hex);
  $( ['text','muted','heading'].includes(key)?'appearance-text-colors':'appearance-colors').append(group);
}
export function openAppearance() {
  draft=structuredClone(saved);notify('');redraw();dialog.showModal();
}
dialog.addEventListener('close',()=>{++generation;apply(saved);});
$('appearance-cancel').onclick=()=>dialog.close();
$('appearance-save').onclick=()=>{
  try {localStorage.setItem(KEY,JSON.stringify(draft));saved=structuredClone(draft);dialog.close();}
  catch {notify('无法保存外观设置，请检查本机存储空间。');}
};
$('appearance-size').oninput=event=>{
 draft.fontSize=Number(event.target.value);$('appearance-size-value').value=draft.fontSize+' px';apply(draft);
};
$('appearance-reset').onclick=()=>{++generation;draft=presetTheme(draft.preset);notify('');redraw();};
window.addEventListener('storage',event=>{
 if(event.key!==KEY)return;
 try{saved=event.newValue?parseTheme(JSON.parse(event.newValue)):presetTheme();if(!dialog.open)apply(saved);}catch{}
});
$('appearance-import').onchange=async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;
  const ticket=++generation;
  try {
    if(file.size>2000000)throw Error('主题文件过大');
    const next=parseTheme(JSON.parse(await file.text()));
    if(ticket===generation){draft=next;notify('');redraw();}
  }catch(e){if(ticket===generation)notify('导入失败 · '+e.message);}
};
$('appearance-export').onclick=()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify(draft,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='terraweave-'+draft.preset+'.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
};

