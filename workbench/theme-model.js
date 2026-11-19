export const fields = {
 background:'工作区底色', chrome:'标题与工具栏', panel:'面板底色', field:'输入框',
 text:'正文', muted:'辅助文字', heading:'标题', accent:'强调色', selected:'选中背景', line:'分隔线'
};
const keys=Object.keys(fields);
export const presets={
 atlas:['岩墨','#16181d','#1b1e24','#23262d','#2b2f38','#e2e4ea','#b0b5c2','#f4f5f8','#aab9fa','#363e56','#424751'],
 graphite:['暖灰','#1c1917','#201e1b','#292623','#33302b','#ece7df','#bcb6ac','#faf6ef','#e8bd8c','#484034','#4c463e'],
 midnight:['深海','#101723','#141d2b','#1b2738','#233147','#e1e9f5','#afc0d5','#f0f6ff','#88bafa','#2d435e','#384c65'],
 paper:['浅纸','#eceeea','#f5f6f2','#fcfcf9','#f1f2ed','#30382f','#536052','#18271c','#286748','#dceade','#c6cec3']
};
const legacyAtlas=['#102028','#12232a','#1a2c33','#21363c','#e5f1f0','#adc3c4','#7bd4c5','#25504e','#35494e'];
export function presetTheme(preset='atlas',fontSize=14){
 return {version:2,preset,fontSize,colors:Object.fromEntries(keys.map((k,i)=>[k,presets[preset][i+1]]))};
}
export function parseTheme(value){
 if(![1,2].includes(value?.version)||!Object.hasOwn(presets,value.preset))throw Error('主题格式或版本不受支持');
 const size=value.version===1?14:value.fontSize;
 if(!Number.isInteger(size)||size<12||size>18)throw Error('界面字号应为 12 至 18');
 const theme=presetTheme(value.preset,size);
 const legacyKeys=keys.filter(k=>k!=='heading');
 if(value.version===1&&value.preset==='atlas'&&legacyKeys.every((k,i)=>value.colors?.[k]?.toLowerCase?.()===legacyAtlas[i]))return theme;
 for(const key of keys){
  const color=value.version===1&&key==='heading'?value.colors?.text:value.colors?.[key];
  if(typeof color!=='string'||!/^#[0-9a-f]{6}$/i.test(color))throw Error('无效颜色 · '+fields[key]);
  theme.colors[key]=color.toLowerCase();
 }
 return theme;
}
export function inkFor(background){
 const rgb=background.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
 return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722>.179?'#000000':'#ffffff';
}
