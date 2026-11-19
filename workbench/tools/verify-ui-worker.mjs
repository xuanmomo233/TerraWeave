import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import {PROJECT,ROOT} from './creative-workbench.mjs';
const child=spawn(process.execPath,[path.join(PROJECT,'tools/ui-worker.mjs')],{cwd:PROJECT,stdio:['pipe','pipe','pipe'],windowsHide:true}),pending=new Map();let sequence=0,stderr='';child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-4000));
readline.createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line),job=pending.get(r.id);if(job){pending.delete(r.id);clearTimeout(job.timer);r.error?job.reject(Error(r.error)):job.resolve(r.result);}});
const call=(tool,args={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('UI worker timed out: '+stderr));},10000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,tool,args})+'\n');});
try{const start=performance.now(),first=await call('ui_snapshot'),cold=performance.now()-start,samples=[];assert.ok(first.planning&&first.workspace&&Array.isArray(first.regions));for(let i=0;i<10;i++){const t=performance.now(),r=await call('ui_snapshot');assert.equal(r.backend_pid,first.backend_pid);samples.push(performance.now()-t);}await assert.rejects(call('planning_state',{unknown:true}),/Invalid/);const parallel=await Promise.all([call('planning_state'),call('workbench_status'),call('workspace_status')]);assert.ok(parallel[0].layers&&parallel[1].desktop&&parallel[2].files);const sorted=[...samples].sort((a,b)=>a-b),report={at:new Date().toISOString(),passed:true,cold_ms:cold,warm_median_ms:sorted[5],warm_max_ms:sorted.at(-1),persistent_process:true,concurrent_reads:true,invalid_requests_rejected:true};fs.writeFileSync(path.join(ROOT,'ui-worker-acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
finally{child.stdin.end();}
