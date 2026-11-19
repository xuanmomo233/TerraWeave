import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {PROJECT,ROOT,callTool} from './creative-workbench.mjs';

const initial=await callTool('planning_state');await callTool('open_map');
const candidates=[];for(const p of (process.env.PATH??'').split(path.delimiter)){const exe=path.join(p,'codex.exe');if(fs.existsSync(exe))candidates.push(exe);}
if(!candidates.length){const root=path.join(process.env.LOCALAPPDATA,'OpenAI/Codex/bin');candidates.push(...fs.readdirSync(root).map(n=>path.join(root,n,'codex.exe')).filter(p=>fs.existsSync(p)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs));}
if(!candidates.length)throw Error('Official Codex CLI not found');
const tools=['world_map_info','planning_state','create_layer','save_plan','inspect_plan','capture_map','delete_layer'];
const args=['exec','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--ignore-user-config','--strict-config','--cd',PROJECT,'--json'];
for(const [key,value]of Object.entries({command:JSON.stringify(process.execPath),args:JSON.stringify([path.join(PROJECT,'tools/creative-workbench.mjs'),'--stdio']),enabled_tools:JSON.stringify(tools),default_tools_approval_mode:'"approve"',required:'true',tool_timeout_sec:'180'}))args.push('-c','mcp_servers.map_workbench.'+key+'='+value);
args.push('这是用户授权的 TerraWeave 地图级工作流验收。只调用 map_workbench，不运行 shell、不修改世界方块。依次：world_map_info与planning_state了解当前世界；create_layer建立临时图层「Codex宏观规划验收」；在此图层用save_plan建立area「城镇总体方案」，points=[[-800,-600],[800,-600],[800,600],[-800,600]]，notes说明是整体规划验证；再用save_plan建立route「主路」points=[[-500,0],[0,0],[500,200]]及marker「广场」points=[[0,0]]；inspect_plan检查area；capture_map view={x:0,z:0,scale:2,rotation:37},width=1024,height=768，必须实际查看返回PNG；最后delete_layer清理临时图层，forget_history=true。任何错误停止，不绕过。中文报告地图范围、创建的宏观对象、旋转截图实际可见内容，明确规划线条不是已建世界内容，图片是存档地表概览与规划叠加，不是游戏客户端截图。');
const logfile=path.join(os.tmpdir(),'TerraWeave-map-codex-'+randomUUID()+'.jsonl'),errfile=logfile+'.err',out=fs.openSync(logfile,'wx'),err=fs.openSync(errfile,'wx');
try{
 const code=await new Promise((resolve,reject)=>{const child=spawn(candidates[0],args,{cwd:PROJECT,stdio:['ignore',out,err],windowsHide:true}),timer=setTimeout(()=>{child.kill();reject(Error('External map workflow timed out'));},300000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});});fs.closeSync(out);fs.closeSync(err);if(code)throw Error('External Codex exited '+code);
 const events=fs.readFileSync(logfile,'utf8').trim().split(/\r?\n/).map(JSON.parse),calls=events.filter(e=>e.type==='item.completed'&&e.item?.type==='mcp_tool_call').map(e=>e.item);
 const data=c=>{if(c.status!=='completed'||c.error||c.result?.isError)throw Error('MCP call failed: '+c.tool);const result=JSON.parse(c.result.content.find(b=>b.type==='text').text);if(result.error)throw Error(result.error);return result;};
 for(const c of calls)data(c);for(const name of tools)if(!calls.some(c=>c.server==='map_workbench'&&c.tool===name))throw Error('Missing real tool '+name);
 const captures=calls.filter(c=>c.tool==='capture_map'),capture=data(captures.at(-1)),images=captures.at(-1).result.content.filter(b=>b.type==='image');
 if(images.length!==1||capture.view.rotation!==37||!capture.planning_snapshot_hash||!events.some(e=>e.type==='turn.completed')||events.some(e=>e.item?.type==='command_execution'))throw Error('Map image or tool receipts incomplete');
 const saved=await callTool('inspect_captured_plans',{capture_id:capture.request_id});const area=saved.objects.find(p=>p.name==='城镇总体方案');if(!area||area.points[1][0]-area.points[0][0]!==1600)throw Error('Frozen map planning geometry not available');
 const after=await callTool('planning_state');if(after.layers.some(l=>l.name==='Codex宏观规划验收'))throw Error('Temporary map planning layer was not removed');
 const answer=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').at(-1)?.item.text;
 const receipt={at:new Date().toISOString(),success:true,world_uuid:saved.world_uuid,macro_objects:saved.objects.filter(p=>['城镇总体方案','主路','广场'].includes(p.name)).map(p=>({name:p.name,type:p.type,points:p.points})),rotation:37,image_content_blocks:images.length,image:capture.images[0],capture_id:capture.request_id,planning_snapshot_hash:capture.planning_snapshot_hash,answer,raw_receipt:logfile};fs.writeFileSync(path.join(ROOT,'codex-map-acceptance.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
}catch(e){console.error(e.message);console.error('Receipts: '+logfile+' / '+errfile);process.exitCode=1;}finally{
 const state=await callTool('planning_state');for(const layer of state.layers.filter(l=>l.name==='Codex宏观规划验收'))await callTool('delete_layer',{layer_id:layer.id,forget_history:true});if(initial.selected_id&&state.objects.some(p=>p.id===initial.selected_id))await callTool('select_plan',{plan_id:initial.selected_id});await callTool('open_map');
}
