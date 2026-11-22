function matches(condition,properties){
 if(!condition)return true;
 return Object.entries(condition).every(([key,value])=>key==='OR'?value.some(part=>matches(part,properties)):
  key==='AND'?value.every(part=>matches(part,properties)):String(value).split('|').includes(properties[key]));
}

export function variantChoices(blockstate,properties){
 if(blockstate.multipart)return blockstate.multipart.filter(part=>matches(part.when,properties))
  .map(part=>Array.isArray(part.apply)?part.apply:[part.apply]);
 const entry=Object.entries(blockstate.variants??{}).find(([selector])=>!selector||selector.split(',').every(pair=>{
  const [key,allowed]=pair.split('=');return allowed.split('|').includes(properties[key]);
 }));
 if(!entry)throw Error('状态无对应模型');
 return [Array.isArray(entry[1])?entry[1]:[entry[1]]];
}

export function selectVariants(blockstate,properties,indices=[]){
 return variantChoices(blockstate,properties).map((choices,i)=>choices[indices[i]??0]);
}

// Variants stay stable at a world coordinate across snapshots, tiles and reloads.
function positionSeed([x,y,z]){
 let seed=Math.imul(x,3129871)^Math.imul(z,116129781)^y;
 seed=Math.imul(seed^(seed>>>16),0x45d9f3b);
 return (seed^(seed>>>16))>>>0;
}

export function partitionVariants(choices,items,position){
 if(!choices.some(options=>options.length>1))return [{items}];
 const weights=choices.map(options=>options.map(option=>Number.isSafeInteger(option.weight)&&option.weight>0?option.weight:1));
 const totals=weights.map(list=>list.reduce((a,b)=>a+b,0)),groups=new Map();
 for(const item of items){
  const seed=positionSeed(position(item));
  const indices=weights.map((list,i)=>{
   let roll=((seed+Math.imul(i,0x9e3779b9))>>>0)%totals[i];
   return list.findIndex(weight=>(roll-=weight)<0);
  });
  const key=indices.join(',');
  if(!groups.has(key))groups.set(key,{indices,items:[]});
  groups.get(key).items.push(item);
 }
 return [...groups.values()];
}
