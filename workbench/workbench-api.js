import {invoke} from '@tauri-apps/api/core';
const writes=new Set(['create_layer','update_layer','delete_layer','save_plan','delete_plan','select_plan','undo_plan','redo_plan','save_map_view','save_workspace','update_draft']);
let mutation=Promise.resolve(),snapshot=null;
// Retain the project generation of this document, even in callbacks that outlive a switch.
const projectEpoch=Number(new URLSearchParams(globalThis.location?.search).get('project_epoch')??0);
export function invokeProject(command,args={}){
 return invoke(command,{...args,projectEpoch});
}
export function finishWorkbenchWrites(){return mutation;}
export function readWorkbenchSnapshot({fresh=false}={}){
 if(snapshot&&!fresh)return snapshot.promise;
 const previous=snapshot,request={};
 request.promise=new Promise((resolve,reject)=>{
  request.forward=resolve;
  invokeProject('workbench_call',{tool:'ui_snapshot',args:{}}).then(resolve,reject);
 });
 snapshot=request;
 // A committed external mutation supersedes reads that started before its notification.
 // Existing readers follow the replacement even when the old transport finishes last.
 previous?.forward(request.promise);
 request.promise.finally(()=>{if(snapshot===request)snapshot=null;}).catch(()=>{});
 return request.promise;
}
export function callWorkbench(tool,args={}){
 if(tool==='ui_snapshot')return readWorkbenchSnapshot();
 const run=()=>invokeProject('workbench_call',{tool,args});
 if(writes.has(tool)){const next=mutation.then(run);mutation=next.catch(()=>{});return next;}
 return run();
}
