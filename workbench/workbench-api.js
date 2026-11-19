import {invoke} from '@tauri-apps/api/core';
const writes=new Set(['create_layer','update_layer','delete_layer','save_plan','delete_plan','select_plan','undo_plan','redo_plan','save_map_view','save_workspace','update_draft']);
let mutation=Promise.resolve(),snapshot=null;
export function callWorkbench(tool,args={}){
 if(tool==='ui_snapshot'&&snapshot)return snapshot;
 const run=()=>invoke('workbench_call',{tool,args});
 if(writes.has(tool)){const next=mutation.then(run);mutation=next.catch(()=>{});return next;}
 const result=run();if(tool==='ui_snapshot'){snapshot=result;result.finally(()=>{if(snapshot===result)snapshot=null;}).catch(()=>{});}return result;
}
