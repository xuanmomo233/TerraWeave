import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const id={type:'string'};
const point={type:'array',items:{type:'number'},minItems:3,maxItems:3};
export const TAB_VIEW_TOOLS=[
 {name:'prepare_tab_view',description:'Prepare an editor tab independently of the active document and its ongoing operations.',inputSchema:{type:'object',properties:{
  kind:{type:'string',enum:['panorama','draft','region','detail']},region_id:id,draft_id:id,mode:id,reveal_changes:{type:'boolean'},view_id:id,label:id,point,plan_id:id
 },required:['kind'],additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'commit_tab_view',description:'Register a prepared regional tab as the current document after it has been displayed.',inputSchema:{type:'object',properties:{ticket:id},required:['ticket'],additionalProperties:false}}
];
const ticketName=/^[0-9a-f-]{36}$/;
const maxAge=120_000;

export function tabViewService({folder,atomic,read,prepare,stamp,commit}){
 const fileFor=ticket=>path.join(folder('tab-views'),ticket+'.json');
 function collect(current){
  const directory=folder('tab-views');
  const files=fs.readdirSync(directory).filter(name=>name.endsWith('.json')&&ticketName.test(name.slice(0,-5)))
   .map(name=>{const file=path.join(directory,name);return {file,time:fs.statSync(file,{throwIfNoEntry:false})?.mtimeMs};})
   .filter(entry=>entry.file!==current&&entry.time!==undefined)
   .sort((a,b)=>b.time-a.time);
  for(const [index,{file,time}] of files.entries())if(index>=11||Date.now()-time>maxAge){
   try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
 }
 return async (name,args)=>{
  if(name==='prepare_tab_view'){
   const initial=stamp();
   const view=await prepare(args);
   if(stamp()!==initial)return {stale:true};
   if(view.kind!=='display')return view;
   const ticket=randomUUID(),file=fileFor(ticket);
   atomic(file,{stamp:initial,view:view.saved?{kind:view.kind,region:view.region,saved:true}:view});
   collect(file);
   return {...view,ticket};
  }
  if(!ticketName.test(args.ticket??''))throw Error('无效的标签预览标识');
  const file=fileFor(args.ticket);
  try{
   const {stamp:expected,view}=read(file);
   if(stamp()!==expected||Date.now()-fs.statSync(file).mtimeMs>maxAge)return {stale:true};
   return commit(view);
  }catch(error){
   if(error.code==='ENOENT')return {stale:true};
   throw error;
  }finally{
   try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
 };
}
