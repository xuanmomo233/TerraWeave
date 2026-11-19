import fs from 'node:fs';
import {draftContext} from './render-context.mjs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {diffChanges,editOverlay,keyOf,draftPatch,replayDraftPatch,inside} from './design-core.mjs';
import {planBounds} from './planning-core.mjs';

const integer={type:'integer'},id={type:'string'},state={type:'string'},bounds={type:'array',items:integer,minItems:6,maxItems:6};
const schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const block=schema({x:integer,y:integer,z:integer,state},['x','y','z','state']);
const previewOptions=schema({mode:{type:'string',enum:['target','base','diff']},focus:{type:'array',items:{type:'number'},minItems:3,maxItems:3},keep_camera:{type:'boolean'}},[]);
export const DESIGN_TOOLS=[
 {name:'create_draft',description:'Create a sparse world-scale design for a planning object or continuous scene. Only edited coordinates acquire baselines; no full-map voxel capture is needed.',inputSchema:schema({region_id:id,plan_id:id,label:{type:'string'},focus:{type:'array',items:{type:'number'},minItems:3,maxItems:3}},[])},
 {name:'list_drafts',description:'List saved design drafts and their current revisions.',inputSchema:schema({include_archived:{type:'boolean'}}),annotations:{readOnlyHint:true}},
 {name:'archive_draft',description:'Archive or restore a design without deleting its authored data.',inputSchema:schema({draft_id:id,archived:{type:'boolean'}},['draft_id'])},
 {name:'delete_draft',description:'Delete a design object and collect unreferenced previews. Existing world blocks are not removed.',inputSchema:schema({draft_id:id},['draft_id'])},
 {name:'update_draft',description:'Save a design name, notes and visibility without duplicating block data.',inputSchema:schema({draft_id:id,label:{type:'string'},notes:{type:'string'},visible:{type:'boolean'}},['draft_id'])},
 {name:'undo_draft',description:'Undo a draft edit and optionally display its saved revision. No world writes.',inputSchema:schema({draft_id:id,preview:previewOptions},['draft_id'])},
 {name:'redo_draft',description:'Redo a draft edit and optionally display its saved revision. No world writes.',inputSchema:schema({draft_id:id,preview:previewOptions},['draft_id'])},
 {name:'edit_draft',description:'Change or fill blocks in a draft using the local 1.20.1 block registry. Optionally display the saved revision in the same request. No world writes. reset clears the draft overlay.',inputSchema:schema({draft_id:id,blocks:{type:'array',items:block,maxItems:16384},fill:schema({bounds,state},['bounds','state']),reset:{type:'boolean'},preview:previewOptions},['draft_id'])},
 {name:'inspect_draft',description:'Read draft revision, changed coordinates, before/after block states and added/replaced/removed counts.',inputSchema:schema({draft_id:id,offset:integer,limit:integer},['draft_id']),annotations:{readOnlyHint:true}},
 {name:'preview_draft',description:'Display a design at a world-coordinate focus. Large planning designs stream local detail rather than loading their full volume.',inputSchema:schema({draft_id:id,mode:{type:'string',enum:['target','base','diff']},focus:{type:'array',items:{type:'number'},minItems:3,maxItems:3},keep_camera:{type:'boolean'}},['draft_id'])},
 {name:'export_draft',description:'Freeze a draft revision and its before-states as a JSON file for the independent world-writer MCP.',inputSchema:schema({draft_id:id},['draft_id'])},
 {name:'list_history',description:'List persisted world edit history with undo/redo availability.',inputSchema:schema({}),annotations:{readOnlyHint:true}},
];

export function designService(ctx){
 const {folder,atomic,read,readRegion,readRegionMetadata,currentRegion,saveSnapshot,savePreview,displayRegion,readSavedPositions,normalizeState,validateBounds,validateEdits,planning,captureDetail}=ctx;
 const valid=id=>typeof id==='string'&&/^[a-zA-Z0-9-]{1,99}$/.test(id);
 function file(group,id){if(!valid(id))throw Error('Invalid '+group+' identity');return path.join(folder(group),id+'.json');}
 function draft(id){
  try{return read(file('drafts',id));}
  catch(error){
   if(error.code==='ENOENT')throw Error('草稿已删除或不存在');
   throw error;
  }
 }
 const all=group=>fs.readdirSync(folder(group)).filter(n=>n.endsWith('.json')).map(n=>read(path.join(folder(group),n))).sort((a,b)=>(b.updated_at??b.created_at).localeCompare(a.updated_at??a.created_at));
 const baseFor=d=>d.schema===2?{blocks:d.base_cells??{}}:readRegion(d.base_region_id).snapshot;
 function visibility(d){const state=planning.read(),base=readRegionMetadata(d.base_region_id),parent=state.objects.find(p=>p.id===d.plan_id||!d.plan_id&&base.entity_id&&p.detail_entity_id===base.entity_id);return {revision:state.revision,visible:d.visible!==false&&(!parent||parent.visible!==false&&state.layers.find(l=>l.id===parent.layer_id)?.visible!==false)};}
 const describe=(d,base=baseFor(d))=>{const region=readRegionMetadata(d.base_region_id),{counts,total}=diffChanges(base,d.changes);return {...d,base_cells:undefined,changes:undefined,applied_states:undefined,undo_stack:undefined,redo_stack:undefined,base_entity_id:region.entity_id,visible:d.visible??true,design_visible:visibility(d).visible,undo_count:d.undo_stack?.length??0,redo_count:d.redo_stack?.length??0,counts,changed_positions:total};};
 const summary=r=>({id:r.id,label:r.label,kind:r.kind,world_uuid:r.world_uuid,created_at:r.created_at,state:r.state,changed:r.changes.length,undoable:r.undoable,undo_count:r.undoable?r.changes.length-(r.undone_keys?.length??0):0,redo_count:r.undoable?r.undone_keys?.length??0:0});
 function coversFocus(b,[x,y,z]){
  return x>=b[0]+8&&x<=b[3]-8&&z>=b[2]+8&&z<=b[5]-8&&(y===undefined||y>=b[1]&&y<=b[4]);
 }
 function requestedPreview(value){
  if(value===undefined)return null;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!(key in previewOptions.properties)))throw Error('Invalid draft preview options');
  const {mode='target',focus,keep_camera=true}=value;
  if(!['target','base','diff'].includes(mode))throw Error('Unknown draft view');
  if(typeof keep_camera!=='boolean')throw Error('keep_camera must be a boolean');
  if(focus!==undefined&&(!Array.isArray(focus)||focus.length!==3||!focus.every(Number.isFinite)))throw Error('Invalid design focus');
  return {mode,focus,keep_camera};
 }
 async function afterEdit(d,options,base){
  const result=describe(d,base);
  if(!options)return result;
  try{return {...result,preview:await preview(d,options,base)};}
  catch(error){return {...result,preview_error:error.message};}
 }
 async function preview(d,{mode='target',focus,keep_camera=false},baseStates){
  const baseId=d.preview_region_id??d.base_region_id;
  let base=readRegion(baseId);
  const diff=diffChanges(baseStates??(d.schema!==2&&baseId===d.base_region_id?base.snapshot:baseFor(d)),d.changes);
  let contextReused=true;
  if(d.schema===2){
   const target=focus??d.focus??[(d.bounds[0]+d.bounds[3])/2,64,(d.bounds[2]+d.bounds[5])/2];
   if(target.length!==3||!target.every(Number.isFinite))throw Error('Invalid design focus');
   if(!base.snapshot.context_blocks||!coversFocus(base.snapshot.bounds,target)){
    const region=await captureDetail({x:Math.floor(target[0]),z:Math.floor(target[2]),y:target[1],plan_id:d.plan_id,capture_only:true});
    d={...d,preview_region_id:region.id,focus:target};
    atomic(file('drafts',d.id),d);
    base=readRegion(region.id);
    contextReused=false;
   }
  }
  const visible=key=>{const p=key.split(',').map(Number),b=base.snapshot.bounds;return p.every((n,i)=>n>=b[i]&&n<=b[i+3]);};
  const visibilityState=visibility(d),showTarget=mode!=='base'&&visibilityState.visible;
  let blocks=base.snapshot.blocks;
  function overlay(cells){
   for(const [key,state] of Object.entries(cells)){
    if(!visible(key)||blocks[key]===state)continue;
    if(blocks===base.snapshot.blocks)blocks={...blocks};
    blocks[key]=state;
   }
  }
  if(d.schema===2)overlay(d.base_cells);
  if(showTarget)overlay(d.changes);
  const context_blocks=draftContext(base.snapshot.context_blocks,d.base_cells,d.changes,showTarget);
  const snapshot={...base.snapshot,blocks,context_blocks,source:'design_draft',block_entity_count:null,block_entity_positions:undefined,draft_id:d.id,draft_revision:d.revision};
  const pins=blocks===base.snapshot.blocks&&context_blocks===base.snapshot.context_blocks
   ?{snapshot_id:base.region.snapshot_id,snapshot_hash:base.region.snapshot_hash}
   :saveSnapshot(snapshot);
  const r={...base.region,id:'preview-'+d.id+'-'+d.revision+'-'+mode+'-'+pins.snapshot_hash.slice(0,20),entity_id:undefined,view_id:undefined,label:d.label,notes:d.notes??base.region.notes??'',source:'design_draft',draft_id:d.id,draft_revision:d.revision,design_visible:visibilityState.visible,sparse_draft:d.schema===2,detail_for_plan_id:d.plan_id,keep_camera,base_region_id:d.base_region_id,preview_mode:mode,diff:visibilityState.visible?diff.rows.filter(c=>visible(c.coordinate.join(','))):[],counts:diff.counts,...pins};
  savePreview(r);
  const shown=await displayRegion(r,'display',undefined,snapshot);
  return {...shown,diff:undefined,changed_positions:diff.total,preview_context_reused:contextReused};
 }
 async function execute(name,args){
  if(name==='create_draft'){
   let base,plan,baseReused=false;
   if(args.focus&&(!Array.isArray(args.focus)||args.focus.length!==3||!args.focus.every(Number.isFinite)))throw Error('Invalid design focus');
   if(args.plan_id){
    const selected=planning.object(args.plan_id);
    plan=selected.plan;
    const b=planBounds(plan);
    const [x,y,z]=args.focus??[(b[0]+b[2])/2,plan.min_y===undefined?undefined:(plan.min_y+(plan.max_y??plan.min_y))/2,(b[1]+b[3])/2];
    const current=args.region_id?readRegionMetadata(args.region_id):currentRegion();
    if(current?.detail_for_plan_id===plan.id&&current.world_uuid===selected.state.world_uuid&&
       current.source==='saved_anvil_detail'&&coversFocus(current.loaded_bounds,[x,y,z])){
     const candidate=readRegion(current.id);
     if(candidate.snapshot.context_blocks){base=candidate;baseReused=true;}
    }
    if(!base){
     const r=await captureDetail({x:Math.floor(x),z:Math.floor(z),y,plan_id:plan.id,capture_only:true});
     base=readRegion(r.id);
    }
   }else{
    base=readRegion(args.region_id);
    baseReused=true;
   }
   if(base.region.source==='design_draft')throw Error('Create the draft from a real-world region');
   const label=args.label??(plan?plan.name:base.region.label)+' · 设计';if(typeof label!=='string'||!label.trim()||label.length>120)throw Error('Draft label must contain 1..120 characters');
   const p=plan?planBounds(plan):null,sparse=!!plan||base.region.transient,d={id:randomUUID(),label,base_region_id:base.region.id,world_uuid:base.region.world_uuid,bounds:sparse?[-30000000,-64,-30000000,30000000,319,30000000]:base.region.bounds,revision:1,changes:{},applied_states:{},created_at:new Date().toISOString(),updated_at:new Date().toISOString(),...(sparse?{schema:2,plan_id:plan?.id,plan_bounds:p,base_cells:{},focus:args.focus??[(base.region.bounds[0]+base.region.bounds[3])/2,(base.region.bounds[1]+base.region.bounds[4])/2,(base.region.bounds[2]+base.region.bounds[5])/2]}:{})};atomic(file('drafts',d.id),d);return {...describe(d),base_reused:baseReused};
  }
  if(name==='list_drafts')return all('drafts').filter(d=>args.include_archived||!d.archived).map(d=>describe(d));
  if(name==='update_draft'){const d=draft(args.draft_id),label=args.label??d.label,notes=args.notes??d.notes??'',visible=args.visible??d.visible??true;if(typeof label!=='string'||!label.trim()||label.length>120||typeof notes!=='string'||notes.length>10000)throw Error('Invalid draft name or notes');if(label===d.label&&notes===(d.notes??'')&&visible===(d.visible??true))return describe(d);const next={...d,label,notes,visible,revision:d.revision+1,updated_at:new Date().toISOString()};atomic(file('drafts',d.id),next);return describe(next);}
  if(name==='archive_draft'){const d={...draft(args.draft_id),archived:args.archived??true,updated_at:new Date().toISOString()};atomic(file('drafts',d.id),d);return describe(d);}
  if(name==='delete_draft'){
   const d=draft(args.draft_id);
   if(currentRegion()?.draft_id===d.id)atomic(path.join(path.dirname(folder('drafts')),'current-region.json'),{id:d.base_region_id});
   fs.unlinkSync(file('drafts',d.id));
   return {deleted:true,id:d.id};
  }
  if(name==='undo_draft'||name==='redo_draft'){
   const options=requestedPreview(args.preview);
   const d=draft(args.draft_id),undo=name==='undo_draft',from=undo?(d.undo_stack??[]):(d.redo_stack??[]),patch=from.at(-1);if(!patch)throw Error(undo?'No draft edit to undo':'No draft edit to redo');
   const base=baseFor(d),changes=replayDraftPatch(base,d.changes,patch,undo?'undo':'redo');
   const next={...d,changes,revision:d.revision+1,updated_at:new Date().toISOString(),undo_stack:undo?from.slice(0,-1):[...(d.undo_stack??[]),patch].slice(-20),redo_stack:undo?[...(d.redo_stack??[]),patch].slice(-20):from.slice(0,-1)};
   atomic(file('drafts',d.id),next);return afterEdit(next,options,base);
  }
  if(name==='inspect_draft'){
   const d=draft(args.draft_id),diff=diffChanges(baseFor(d),d.changes),offset=args.offset??0,limit=args.limit??128;
   if(!Number.isSafeInteger(offset)||offset<0||offset>diff.total||!Number.isSafeInteger(limit)||limit<1||limit>512)throw Error('Invalid draft page');
   return {draft:describe(d),offset,total:diff.total,next_offset:offset+limit<diff.total?offset+limit:null,changes:diff.rows.slice(offset,offset+limit)};
  }
  if(name==='edit_draft'){
   const options=requestedPreview(args.preview);
   let d=draft(args.draft_id),base=baseFor(d),blocks=args.blocks??[];
   if(args.reset!==undefined&&typeof args.reset!=='boolean')throw Error('reset must be true or false');
   if(!Array.isArray(blocks)||blocks.length>16384)throw Error('At most 16384 individual edits');
   if(args.fill){validateBounds(args.fill.bounds);if(typeof args.fill.state!=='string')throw Error('Fill state required');blocks=[...blocks];const b=args.fill.bounds;for(let y=b[1];y<=b[4];y++)for(let z=b[2];z<=b[5];z++)for(let x=b[0];x<=b[3];x++)blocks.push({x,y,z,state:args.fill.state});}
   validateEdits(blocks,147456);
   for(const b of blocks){
    if(!inside(d.bounds,[b.x,b.y,b.z])||d.schema!==2&&base.blocks[keyOf(b)]===undefined)throw Error('Draft edit is outside its marked region');
   }
   if(d.schema===2&&d.plan_id){
    const current=planning.read().objects.find(p=>p.id===d.plan_id);
    if(current)d={...d,plan_bounds:planBounds(current)};
   }
   const states=[...new Set(blocks.map(b=>b.state))];
   if(states.length>512)throw Error('At most 512 unique block states');
   if(states.length){
    const missing=d.schema===2?blocks.map(keyOf).filter(key=>d.base_cells[key]===undefined):[];
    const normalized=states.map(normalizeState);
    const cells=missing.length?readSavedPositions(d.world_uuid,missing):{};
    if(missing.length){d={...d,base_cells:{...d.base_cells,...cells}};base=baseFor(d);}
    const mapping=new Map(states.map((s,i)=>[s,normalized[i]]));
    blocks=blocks.map(b=>({...b,state:mapping.get(b.state)}));
   }
   const changes=editOverlay(base,d.bounds,d.changes,blocks,args.reset),patch=draftPatch(base,d.changes,changes);
   if(!patch.length)return afterEdit(d,options,base);
   const next={...d,changes,focus:d.schema===2&&blocks.length?[blocks.at(-1).x,blocks.at(-1).y,blocks.at(-1).z]:d.focus,revision:d.revision+1,undo_stack:[...(d.undo_stack??[]),patch].slice(-20),redo_stack:[],updated_at:new Date().toISOString()};
   atomic(file('drafts',d.id),next);
   return afterEdit(next,options,base);
  }
  if(name==='preview_draft')return preview(draft(args.draft_id),requestedPreview({mode:args.mode,focus:args.focus,keep_camera:args.keep_camera??false}));
  if(name==='export_draft'){
   const d=draft(args.draft_id);
   const packet={schema:1,world_uuid:d.world_uuid,draft_id:d.id,draft_revision:d.revision,
    label:d.label,base:baseFor(d).blocks,changes:d.changes,previously_applied:d.applied_states??{}};
   const digest=createHash('sha256').update(JSON.stringify(packet)).digest('hex');
   const filename=path.join(folder('exports'),'design-'+d.id+'-'+d.revision+'-'+digest.slice(0,12)+'.json');
   if(!fs.existsSync(filename))atomic(filename,packet);
   return {draft_id:d.id,draft_revision:d.revision,world_uuid:d.world_uuid,path:filename,sha256:digest,changed_positions:Object.keys(d.changes).length};
  }
  if(name==='list_history')return all('history').map(summary).slice(0,100);
  throw Error('Unknown design operation');
 }
 return {execute};
}
