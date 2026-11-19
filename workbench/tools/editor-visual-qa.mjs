// Isolated browser rendering of the packaged editor. Data reads use the real project;
// document switches are simulated in memory and no world/project mutations are permitted.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {PROJECT,ROOT,TOOLS,callTool,loadRegionData} from './creative-workbench.mjs';
import {snapshotBytes} from './project-store.mjs';

const modulePath=process.env.TERRAWEAVE_PLAYWRIGHT??'C:/Users/杨骋达/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const {chromium}=await import(pathToFileURL(modulePath).href);
const out=process.env.TERRAWEAVE_UI_QA_OUTPUT??'D:/IDEA/project/.codex-tmp/terraweave-editor-qa';fs.mkdirSync(out,{recursive:true});
const regions=await callTool('list_regions'),initial=regions.find(r=>r.label==='客栈规划区域')??regions[0];
if(!initial)throw Error('A saved region is required for UI rendering QA');
let job={id:'qa-initial',kind:'display',...loadRegionData(initial.id)},sequence=0,completion,reply,currentDisplay,lastSavedNotes;
job.region=loadRegionData(initial.id).region;job.snapshot=loadRegionData(initial.id).snapshot;
async function display(region,snapshot){job={id:'qa-'+(++sequence),kind:'display',region,snapshot};return new Promise(resolve=>completion=resolve);}
async function bridge(command,args){
 if(command==='workbench_poll')return job;
 if(command==='workbench_heartbeat'||command==='workbench_show')return null;
 if(command==='workbench_window_action')return {decorated:false,maximized:false};
 if(command==='workbench_complete'){reply=args.result;currentDisplay=job;job=null;completion?.({...currentDisplay?.region,...args.result.result,desktop_acknowledged:true});completion=null;return null;}
 if(command==='read_asset'){
  const file=path.resolve(PROJECT,'assets',args.name);if(!file.startsWith(path.join(PROJECT,'assets')+path.sep))throw Error('Invalid fixture asset');const bytes=fs.readFileSync(file);return args.name.endsWith('.png')?'data:image/png;base64,'+bytes.toString('base64'):bytes.toString('utf8');
 }
 if(command==='workbench_read_image'){const r=await callTool('read_capture',{capture_id:args.captureId});return 'data:image/png;base64,'+fs.readFileSync(r.images[args.index].path).toString('base64');}
 if(command!=='workbench_call')throw Error('Unsupported UI QA command '+command);
 const {tool,args:input}=args;
 if(TOOLS.find(t=>t.name===tool)?.annotations?.readOnlyHint)return callTool(tool,input);
 if(tool==='open_region'){const d=loadRegionData(input.region_id);return display(d.region,d.snapshot);}
 if(tool==='set_selection')return display({...currentDisplay.region,bounds:input.bounds,label:input.label},currentDisplay.snapshot);
 if(tool==='update_region'){lastSavedNotes=input.notes;return display({...currentDisplay.region,label:input.label,notes:input.notes},currentDisplay.snapshot);}
 if(tool==='save_workspace')return {saved_at:new Date().toISOString()};
 if(tool==='preview_draft'){
  const d=JSON.parse(fs.readFileSync(path.join(ROOT,'drafts',input.draft_id+'.json'))),base=loadRegionData(d.base_region_id),mode=input.mode??'target';
  const snapshot={...base.snapshot,blocks:{...base.snapshot.blocks,...(mode==='base'?{}:d.changes)}};
  const diff=Object.entries(d.changes).map(([key,after])=>({coordinate:key.split(',').map(Number),before:base.snapshot.blocks[key],after,kind:/^minecraft:(air|cave_air|void_air)$/.test(after)?'removed':/^minecraft:(air|cave_air|void_air)$/.test(base.snapshot.blocks[key])?'added':'replaced'}));
  const region={...base.region,id:'qa-preview-'+d.id+'-'+mode,entity_id:undefined,label:d.label,source:'design_draft',draft_id:d.id,draft_revision:d.revision,base_region_id:d.base_region_id,preview_mode:mode,diff,snapshot_hash:createHash('sha256').update(snapshotBytes(snapshot)).digest('hex')};
  return display(region,snapshot);
 }
 throw Error('UI rendering QA forbids mutation: '+tool);
}
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/__bridge'){
   let body='';for await(const chunk of req)body+=chunk;const q=JSON.parse(body);let result;try{result={result:await bridge(q.command,q.args??{})};}catch(e){result={error:e.message};}res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(result));return;
  }
  let file=path.resolve(PROJECT,'dist','.'+(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(path.join(PROJECT,'dist')+path.sep))throw Error('Invalid fixture route');
  let bytes=fs.readFileSync(file);if(file.endsWith('index.html'))bytes=Buffer.from(bytes.toString('utf8').replace('<head>','<head>').replace('<meta charset=',`<script>window.__TAURI_INTERNALS__={invoke:async(command,args)=>{const r=await fetch('/__bridge',{method:'POST',body:JSON.stringify({command,args})}).then(r=>r.json());if(r.error)throw Error(r.error);if(command==='workbench_complete')window.__qaComplete=(window.__qaComplete||0)+1;return r.result;}};</script><meta charset=`));
  res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');res.end(bytes);
 }catch(e){res.statusCode=404;res.end(e.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-networking']});
 const page=await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);await page.waitForFunction(()=>window.__qaComplete>=1,{timeout:45000});if(reply?.ok!==true)throw Error(reply?.error??'UI scene did not render');
 const box=await page.locator('#view').boundingBox();await page.mouse.click(box.x+box.width*.45,box.y+box.height*.6);await page.waitForFunction(()=>document.querySelector('#picked-block').textContent.includes('minecraft:'));
 const beforeOrbit=await page.locator('canvas').screenshot();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down({button:'right'});await page.mouse.move(box.x+box.width*.5+80,box.y+box.height*.5+25,{steps:8});await page.mouse.up({button:'right'});await page.waitForTimeout(200);assert.equal((await page.locator('canvas').screenshot()).equals(beforeOrbit),false);await page.keyboard.press('f');
 await page.locator('[data-menu="file"]').click();assert.equal(await page.locator('#menu-popup').isVisible(),true);await page.keyboard.press('Escape');
 const other=regions.find(r=>r.entity_id!==initial.entity_id&&!r.archived);if(other){await page.locator('.tree-row').filter({hasText:other.label}).first().click();await page.waitForFunction(()=>document.querySelectorAll('.document-tab').length>=2);await page.locator('.document-tab').first().click();await page.waitForFunction(label=>document.querySelector('#view-badge').textContent.includes(label),initial.label);}
 await page.waitForFunction(()=>!document.querySelector('#save-workspace').disabled);await page.locator('#notes').fill('保留门洞与主梁，入口衔接南侧道路。');await page.keyboard.press('Control+s');await page.waitForFunction(()=>!document.querySelector('#save-workspace').disabled);assert.equal(lastSavedNotes,'保留门洞与主梁，入口衔接南侧道路。');
 await page.screenshot({path:path.join(out,'editor-workspace.png')});
 const drafts=await callTool('list_drafts'),d=drafts.find(d=>d.label==='客栈石基材质方案')??drafts[0];
 if(d){await page.locator('.tree-row.draft').filter({hasText:d.label}).first().click();await page.waitForFunction(()=>!document.querySelector('#draft-properties').hidden);await page.locator('#draft-diff').click();await page.waitForFunction(()=>document.querySelector('#draft-diff').classList.contains('active'));await page.screenshot({path:path.join(out,'editor-design.png')});}
 await page.locator('[data-dock="gallery"]').click();await page.waitForFunction(()=>document.querySelectorAll('#gallery img').length>=1);await page.screenshot({path:path.join(out,'editor-gallery.png')});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,scope:'isolated browser rendering of packaged editor',screenshots:out,document_tabs:await page.locator('.document-tab').count(),logical_regions:regions.length,menus:true,gallery:true,errors},null,2));
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
