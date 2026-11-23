import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {planBounds,planningHeight,validatePlan} from './planning-core.mjs';

const id={type:'string'},point={type:'array',items:{type:'number'},minItems:2,maxItems:2},schema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
export const PLANNING_TOOLS=[
 {name:'planning_state',description:'Read the world-scale planning layers, areas, routes, markers, visibility and selected object.',inputSchema:schema({}),annotations:{readOnlyHint:true}},
 {name:'create_layer',description:'Create a map planning layer. It is independent of Minecraft chunk size.',inputSchema:schema({name:id,color:id},['name'])},
 {name:'update_layer',description:'Rename or show/hide a planning layer.',inputSchema:schema({layer_id:id,name:id,visible:{type:'boolean'},color:id},['layer_id'])},
 {name:'delete_layer',description:'Delete a planning layer and its objects. Optional forget_history permanently removes its undo references; world blocks are unchanged.',inputSchema:schema({layer_id:id,forget_history:{type:'boolean'}},['layer_id'])},
 {name:'save_plan',description:'Create/update a world-scale area polygon, road polyline or point marker. No block-volume or chunk-size restriction.',inputSchema:schema({plan_id:id,layer_id:id,type:{type:'string',enum:['area','route','marker']},name:id,notes:id,points:{type:'array',items:point},color:id,width:{type:'number'},visible:{type:'boolean'},preserve_selection:{type:'boolean'},min_y:{type:['integer','null']},max_y:{type:['integer','null']}},[])},
 {name:'delete_plan',description:'Delete a planning object with undo; world blocks are unchanged.',inputSchema:schema({plan_id:id},['plan_id'])},
 {name:'select_plan',description:'Select a planning object for the user/Codex discussion context.',inputSchema:schema({plan_id:id})},
 {name:'inspect_plan',description:'Read exact planning geometry, bounds, purpose, layer and associated local designs.',inputSchema:schema({plan_id:id}),annotations:{readOnlyHint:true}},
 {name:'undo_plan',description:'Undo a map planning change without changing the world.',inputSchema:schema({})},
 {name:'redo_plan',description:'Redo a map planning change without changing the world.',inputSchema:schema({})},
];
export function planningService(root,listRegions,worldIdentity){
 const file=path.join(root,'planning.json');
 function initial(){const regions=listRegions();return {schema:1,revision:1,world_uuid:worldIdentity(),layers:[{id:'buildings',name:'区域规划',color:'#5b9cec',visible:true},{id:'roads',name:'道路与连接',color:'#e2ad63',visible:true},{id:'markers',name:'地点标注',color:'#a58ade',visible:true}],objects:regions.map(r=>({id:'plan-'+(r.entity_id??r.id),layer_id:'buildings',type:'area',name:r.label,notes:r.notes??'',points:[[r.bounds[0],r.bounds[2]],[r.bounds[3]+1,r.bounds[2]],[r.bounds[3]+1,r.bounds[5]+1],[r.bounds[0],r.bounds[5]+1]],color:'#5b9cec',width:4,visible:true,min_y:r.bounds[1],max_y:r.bounds[4],detail_entity_id:r.entity_id})),selected_id:null,undo:[],redo:[]};}
 function read(){
  if(!fs.existsSync(file))return initial();
  const state=JSON.parse(fs.readFileSync(file,'utf8'));
  state.world_uuid??=worldIdentity();
  return state;
 }
 function write(state){fs.mkdirSync(root,{recursive:true});const temp=file+'.pending-'+process.pid;fs.writeFileSync(temp,JSON.stringify(state));fs.renameSync(temp,file);return publicState(state);}
 function publicState(state){return {...state,undo:undefined,redo:undefined,undo_count:state.undo.length,redo_count:state.redo.length,history:state.undo.map((entry,index)=>({id:index,label:entry.label??'规划修改',at:entry.at}))};}
 function mutate(change,description='规划修改'){const s=read(),before={layers:s.layers,objects:s.objects,selected_id:s.selected_id},next=change(structuredClone(s));const after={layers:next.layers,objects:next.objects,selected_id:next.selected_id};if(JSON.stringify(before)===JSON.stringify(after))return publicState(s);next.undo=[...s.undo,{before,after,label:description,at:new Date().toISOString()}].slice(-40);next.redo=[];next.revision++;next.updated_at=new Date().toISOString();return write(next);}
 function object(id){const s=read(),plan=s.objects.find(p=>p.id===(id??s.selected_id));if(!plan)throw Error('Select a planning object first');return {state:s,plan};}
 function execute(name,args){
  if(name==='planning_state')return publicState(read());
  if(name==='inspect_plan'){const {state:s,plan}=object(args.plan_id);return {revision:s.revision,world_uuid:s.world_uuid,plan,bounds:planBounds(plan),layer:s.layers.find(l=>l.id===plan.layer_id),scope:'Map planning geometry and notes. Actual terrain is separately read from the world.'};}
  if(name==='select_plan'){const s=read();if(args.plan_id&&!s.objects.some(p=>p.id===args.plan_id))throw Error('Planning object not found');s.selected_id=args.plan_id??null;return write(s);}
  if(name==='create_layer')return mutate(s=>{if(!args.name?.trim()||args.name.length>120)throw Error('Layer name required');s.layers.push({id:randomUUID(),name:args.name,color:args.color??'#5b9cec',visible:true});return s;});
  if(name==='update_layer')return mutate(s=>{
   const layer=s.layers.find(l=>l.id===args.layer_id);
   if(!layer)throw Error('Layer not found');
   if(args.name!==undefined&&(typeof args.name!=='string'||!args.name.trim()||args.name.length>120))throw Error('图层名称应为 1 至 120 个字符');
   for(const key of ['name','color','visible'])if(args[key]!==undefined)layer[key]=args[key];
   return s;
  },args.name!==undefined?'重命名规划图层':'更新规划图层');
  if(name==='delete_layer'){
   const result=mutate(s=>{s.layers=s.layers.filter(l=>l.id!==args.layer_id);s.objects=s.objects.filter(p=>p.layer_id!==args.layer_id);if(!s.objects.some(p=>p.id===s.selected_id))s.selected_id=null;return s;},'删除规划图层');
   if(!args.forget_history)return result;
   const s=read(),strip=snapshot=>({...snapshot,layers:snapshot.layers.filter(l=>l.id!==args.layer_id),objects:snapshot.objects.filter(p=>p.layer_id!==args.layer_id),selected_id:snapshot.objects.some(p=>p.id===snapshot.selected_id&&p.layer_id===args.layer_id)?null:snapshot.selected_id});
   const clean=entries=>entries.map(e=>({...e,before:strip(e.before),after:strip(e.after)})).filter(e=>JSON.stringify([e.before.layers,e.before.objects])!==JSON.stringify([e.after.layers,e.after.objects]));s.undo=clean(s.undo);s.redo=clean(s.redo);return write(s);
  }
  if(name==='save_plan')return mutate(s=>{
   const old=args.plan_id?s.objects.find(p=>p.id===args.plan_id):null;
   if(args.plan_id&&!old)throw Error('Planning object not found');
   const type=args.type??old?.type??'area';
   const plan=validatePlan({...old,id:old?.id??randomUUID(),layer_id:args.layer_id??old?.layer_id??(type==='route'?'roads':type==='marker'?'markers':'buildings'),type,name:args.name??old?.name??({area:'规划区域',route:'规划道路',marker:'地点标记'}[type])+' '+(s.objects.length+1),notes:args.notes??old?.notes??'',points:args.points??old?.points,color:args.color??old?.color??(type==='route'?'#e2ad63':type==='marker'?'#a58ade':'#5b9cec'),width:args.width??old?.width??4,visible:args.visible??old?.visible??true});
   if(args.min_y!==undefined||args.max_y!==undefined){
    const {min_y,max_y}=planningHeight(args.min_y===undefined?old?.min_y:args.min_y,args.max_y===undefined?old?.max_y:args.max_y);
    if(min_y===null){delete plan.min_y;delete plan.max_y;}
    else Object.assign(plan,{min_y,max_y});
   }
   if(!s.layers.some(l=>l.id===plan.layer_id))throw Error('Choose a planning layer');
   s.objects=old?s.objects.map(p=>p.id===old.id?plan:p):[...s.objects,plan];
   if(!args.preserve_selection)s.selected_id=plan.id;
   return s;
  });
  if(name==='delete_plan')return mutate(s=>{s.objects=s.objects.filter(p=>p.id!==args.plan_id);if(s.selected_id===args.plan_id)s.selected_id=null;return s;});
  if(name==='undo_plan'||name==='redo_plan'){const s=read(),undo=name==='undo_plan',stack=undo?s.undo:s.redo,entry=stack.at(-1);if(!entry)throw Error('No planning change to '+(undo?'undo':'redo'));const next={...s,...structuredClone(undo?entry.before:entry.after),revision:s.revision+1,undo:undo?stack.slice(0,-1):[...s.undo,entry],redo:undo?[...s.redo,entry]:stack.slice(0,-1)};return write(next);}
  throw Error('Unknown planning tool');
 }
 return {execute,read,publicState,object};
}
