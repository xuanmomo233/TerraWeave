export const dyes={
 white:0xf9fffe,orange:0xf9801d,magenta:0xc74ebd,light_blue:0x3ab3da,yellow:0xfed83d,lime:0x80c71f,
 pink:0xf38baa,gray:0x474f52,light_gray:0x9d9d97,cyan:0x169c9c,purple:0x8932b8,blue:0x3c44aa,
 brown:0x835432,green:0x5e7c16,red:0xb02e26,black:0x1d1d21
};
const patternIds={
 b:'base',bl:'square_bottom_left',br:'square_bottom_right',tl:'square_top_left',tr:'square_top_right',
 bs:'stripe_bottom',ts:'stripe_top',ls:'stripe_left',rs:'stripe_right',cs:'stripe_center',ms:'stripe_middle',
 drs:'stripe_downright',dls:'stripe_downleft',ss:'small_stripes',cr:'cross',sc:'straight_cross',
 bt:'triangle_bottom',tt:'triangle_top',bts:'triangles_bottom',tts:'triangles_top',
 ld:'diagonal_left',rd:'diagonal_up_right',lud:'diagonal_up_left',rud:'diagonal_right',mc:'circle',mr:'rhombus',
 vh:'half_vertical',hh:'half_horizontal',vhr:'half_vertical_right',hhb:'half_horizontal_bottom',
 bo:'border',cbo:'curly_border',cre:'creeper',gra:'gradient',gru:'gradient_up',bri:'bricks',sku:'skull',
 flo:'flower',moj:'mojang',glb:'globe',pig:'piglin'
};
const dyeNames=Object.keys(dyes);

function componentText(value,depth=0){
 if(depth>8||value===null||value===undefined)return '';
 if(typeof value==='string')return value.slice(0,256);
 if(Array.isArray(value))return value.slice(0,24).map(t=>componentText(t,depth+1)).join('').slice(0,256);
 if(typeof value!=='object')return '';
 return (componentText(value.text??value.fallback??value.translate,depth+1)+componentText(value.extra,depth+1)).slice(0,256);
}

function signLine(value){
 if(typeof value==='string'&&value.length<=8192&&/^[\s]*[{["]/.test(value)){
  try{value=JSON.parse(value);}catch{}
 }
 return componentText(value).replace(/[\r\n\u0000-\u001f]/g,' ').slice(0,128);
}

function signSide(data){
 const messages=Array.isArray(data?.messages)?data.messages:[];
 return {lines:Array.from({length:4},(_,i)=>signLine(messages[i])),color:dyes[data?.color]??dyes.black,glowing:!!data?.has_glowing_text};
}

export function blockEntityAppearance(entity){
 if(entity?.id==='minecraft:banner'){
  const layers=entity.patterns??entity.Patterns;
  const patterns=(Array.isArray(layers)?layers:[]).slice(0,16).flatMap(layer=>{
   const modern=/^minecraft:([a-z0-9_]+)$/.exec(layer?.pattern)?.[1];
   const name=modern??(Object.hasOwn(patternIds,layer?.Pattern)?patternIds[layer.Pattern]:undefined);
   const dye=layer?.color??dyeNames[layer?.Color];
   return name&&Object.hasOwn(dyes,dye)?[{name,color:dyes[dye]}]:[];
  });
  return {kind:'banner',patterns};
 }
 if(/^minecraft:(?:chest|trapped_chest|barrel|shulker_box|hopper|dispenser|dropper|furnace|blast_furnace|smoker|brewing_stand)$/.test(entity?.id)){
  const slots=(Array.isArray(entity.Items)?entity.Items:[]).slice(0,54).flatMap(stack=>{
   const count=stack?.count??stack?.Count;
   return Number.isSafeInteger(stack?.Slot)&&stack.Slot>=0&&stack.Slot<54&&Number.isSafeInteger(count)&&count>0&&typeof stack.id==='string'
    &&/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(stack.id)?[{slot:stack.Slot,item:stack.id,count}]:[];
  });
  return {kind:'container',name:signLine(entity.CustomName??entity.custom_name),slots,
   loot_pending:typeof (entity.LootTable??entity.loot_table)==='string'};
 }
 if(!/^minecraft:(?:sign|hanging_sign)$/.test(entity?.id))return undefined;
 const front=signSide(entity.front_text??{
  messages:[entity.Text1,entity.Text2,entity.Text3,entity.Text4],color:entity.Color,has_glowing_text:entity.GlowingText
 });
 const back=signSide(entity.back_text);
 return {front,back};
}
