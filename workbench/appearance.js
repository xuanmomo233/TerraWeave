const KEY = 'terraweave.appearance.v1';
const fields = {
  background:'工作区背景', chrome:'标题与工具栏', panel:'面板', field:'输入框',
  text:'正文', muted:'辅助文字', accent:'强调色', selected:'选中背景', line:'分隔线'
};
const presets = {
  atlas: ['织境青', '#102028','#12232a','#1a2c33','#21363c','#e5f1f0','#adc3c4','#7bd4c5','#25504e','#35494e'],
  graphite: ['石墨', '#161616','#1b1b1b','#222222','#2c2c2c','#ecebe8','#b5b4af','#d7c8a7','#48453f','#40403e'],
  midnight: ['深海蓝', '#111722','#151c29','#1c2533','#263144','#e5ebf5','#adbad0','#79baff','#293f5d','#354151'],
  paper: ['浅纸', '#edf0ed','#f7f7f2','#ffffff','#f0f2ef','#263330','#556560','#146c62','#d2eae3','#bdccc5']
};
const keys = Object.keys(fields);
const base = id => Object.fromEntries(keys.map((key,i) => [key,presets[id][i+1]]));
function validate(value) {
  if (value?.version !== 1 || !Object.hasOwn(presets,value.preset)) throw Error('主题格式或版本不受支持');
  const colors = {};
  for (const key of keys) {
    const color = value.colors?.[key];
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw Error('无效颜色 · '+fields[key]);
    colors[key] = color;
  }
  const image = value.image ?? '';
  if (typeof image !== 'string' || image.length > 1800000 || (image && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(image))) throw Error('背景图片格式或大小无效');
  return {version:1,preset:value.preset,colors,image};
}
const initial = () => ({version:1,preset:'atlas',colors:base('atlas'),image:''});
let saved = initial();
try {saved = validate(JSON.parse(localStorage.getItem(KEY)));} catch {}
const style = document.documentElement.style;
function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map(v => parseInt(v,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);
  return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
}
function apply(theme) {
  for (const key of keys) style.setProperty('--'+key, theme.colors[key]);
  style.setProperty('--on-accent',luminance(theme.colors.accent)>0.179?'#101517':'#ffffff');
  style.setProperty('--wallpaper',theme.image?'url("'+theme.image+'")':'none');
  style.colorScheme = luminance(theme.colors.panel)>0.3?'light':'dark';
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
  $('appearance-remove').disabled = !draft.image;
}
for (const [id, [name]] of Object.entries(presets)) {
  const button = document.createElement('button');
  button.type='button'; button.dataset.preset=id; button.textContent=name;
  const tile=document.createElement('span'); tile.className='theme-sample';tile.setAttribute('aria-hidden','true');
  const colors=base(id);
  tile.style.cssText='--sample-panel:'+colors.panel+';--sample-field:'+colors.field+';--sample-accent:'+colors.accent+';--sample-border:'+colors.line;
  button.prepend(tile);
  button.onclick=()=>{++generation; draft={...draft,preset:id,colors:base(id)};notify('');redraw();};
  $('appearance-presets').append(button);
}
for (const [key,name] of Object.entries(fields)) {
  const label=document.createElement('label'), input=document.createElement('input');
  label.textContent=name; input.type='color'; input.dataset.color=key;
  input.oninput=()=>{draft.colors[key]=input.value;apply(draft);};
  label.append(input);$('appearance-colors').append(label);
}
export function openAppearance() {
  draft=structuredClone(saved);notify('');redraw();dialog.showModal();
}
dialog.addEventListener('close',()=>{++generation;apply(saved);});
$('appearance-cancel').onclick=()=>dialog.close();
$('appearance-save').onclick=()=>{
  try {localStorage.setItem(KEY,JSON.stringify(draft));saved=structuredClone(draft);dialog.close();}
  catch {notify('保存失败，请缩小背景图片后重试。');}
};
$('appearance-remove').onclick=()=>{++generation;draft.image='';redraw();};
$('appearance-image').onchange=async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;
  const ticket=++generation;
  let bitmap;
  try {
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>12*1024*1024)throw Error('请选择 12 MB 以内的 PNG、JPEG 或 WebP');
    bitmap=await createImageBitmap(file);
    if(ticket!==generation)return;
    const scale=Math.min(1,1440/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    const next=validate({...draft,image:canvas.toDataURL('image/webp',0.76)});
    draft=next;notify('');redraw();
  } catch(e) {if(ticket===generation)notify(e.message);} finally {bitmap?.close();}
};
$('appearance-import').onchange=async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;
  const ticket=++generation;
  try {
    if(file.size>2000000)throw Error('主题文件过大');
    const next=validate(JSON.parse(await file.text()));
    if(ticket===generation){draft=next;notify('');redraw();}
  }catch(e){if(ticket===generation)notify('导入失败 · '+e.message);}
};
$('appearance-export').onclick=()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify(draft,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='terraweave-'+draft.preset+'.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
};

