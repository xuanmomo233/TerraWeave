export const air=state=>/^minecraft:(air|cave_air|void_air)$/.test(state);
export const coordinate=block=>[block.x,block.y,block.z];
export const keyOf=block=>coordinate(block).join(',');
export const inside=(bounds,p)=>p.length===3&&p.every((v,i)=>Number.isSafeInteger(v)&&v>=bounds[i]&&v<=bounds[i+3]);
export function diffChanges(base,changes,{rows:includeRows=true,focus}={}){
 const counts={added:0,replaced:0,removed:0},rows=[];
 let total=0,nearest,nearestDistance=Infinity;
 for(const [key,after]of Object.entries(changes)){
  const before=base.blocks[key];if(before===undefined)throw Error('Draft contains a coordinate absent from its base');if(before===after)continue;
  const kind=air(after)?'removed':air(before)?'added':'replaced';counts[kind]++;
  total++;
  if(!includeRows&&!focus)continue;
  const coordinate=key.split(',').map(Number);
  if(includeRows)rows.push({coordinate,before,after,kind});
  if(focus){
   const distance=coordinate.reduce((sum,value,i)=>sum+(value-focus[i])**2,0);
   if(distance<nearestDistance){nearest=coordinate;nearestDistance=distance;}
  }
 }
 rows.sort((a,b)=>a.coordinate[1]-b.coordinate[1]||a.coordinate[2]-b.coordinate[2]||a.coordinate[0]-b.coordinate[0]);
 return {counts,total,rows,...(focus?{focus:nearest}:{})};
}
export function editOverlay(base,marked,previous,blocks,reset=false){
 const next=reset?{}:{...previous};
 for(const b of blocks){const p=coordinate(b),key=p.join(',');if(!inside(marked,p)||base.blocks[key]===undefined)throw Error('Draft edit is outside its marked region');
  if(typeof b.state!=='string')throw Error('Block state required');if(base.blocks[key]===b.state)delete next[key];else next[key]=b.state;
 }
 return next;
}
export function historyActions(record,direction){
 if(!record.undoable)throw Error('This edit contains block-entity data or physics effects that cannot be fully restored from block states');
 const undone=new Set(record.undone_keys??[]);
 return record.changes.filter(c=>direction==='undo'?!undone.has(keyOf(c)):undone.has(keyOf(c))).map(c=>({x:c.x,y:c.y,z:c.z,before:direction==='undo'?c.after:c.before,state:direction==='undo'?c.before:c.after}));
}
export function draftApplyPlan(base,changes,applied={},live={}){
 return [...new Set([...Object.keys(changes),...Object.keys(applied)])].map(key=>{
  const original=base.blocks[key],state=changes[key]??original,known=applied[key]??original,now=live[key];
  if(original===undefined)throw Error('Applied draft cell is absent from its base');
  const before=now===original||now===known?now:known;
  const [x,y,z]=key.split(',').map(Number);return {x,y,z,state,before};
 });
}
export function advanceHistory(record,direction,attempts,conflicts){
 const blocked=new Set(conflicts.map(c=>c.coordinate)),undone=new Set(record.undone_keys??[]);
 for(const attempt of attempts)if(!blocked.has(keyOf(attempt))){if(direction==='undo')undone.add(keyOf(attempt));else undone.delete(keyOf(attempt));}
 return {...record,undone_keys:[...undone],state:undone.size===record.changes.length?'undone':undone.size?'partly_undone':'applied'};
}
export function draftPatch(base,before,after){return [...new Set([...Object.keys(before),...Object.keys(after)])].map(key=>({key,before:before[key]??base.blocks[key],after:after[key]??base.blocks[key]})).filter(c=>c.before!==c.after);}
export function replayDraftPatch(base,changes,patch,direction){
 const next={...changes};for(const c of patch){const expected=direction==='undo'?c.after:c.before,state=direction==='undo'?c.before:c.after;if((next[c.key]??base.blocks[c.key])!==expected)throw Error('Draft changed since this edit');if(state===base.blocks[c.key])delete next[c.key];else next[c.key]=state;}return next;
}
