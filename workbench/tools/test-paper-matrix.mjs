import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {SERVER,serverRequest,serverStatus} from './test-server.mjs';
import {bridgeTransport,worldWriter} from './world-writer.mjs';
import {javaReleases} from '../minecraft-version.js';
import {identifyWorld} from './world-source.mjs';
import {worldIndex} from './world-surface.mjs';
import {savedBlocks} from './render-context.mjs';

const [directory,plugin,java21,java25,...requested]=process.argv.slice(2);
if(!directory||!plugin||!java21||!java25)
 throw Error('Usage: node tools/test-paper-matrix.mjs <matrix-directory> <TerraWeave.jar> <java21> <java25> [Minecraft versions...]');
const root=fs.realpathSync(directory),jar=fs.realpathSync(plugin);
const manifest=JSON.parse(fs.readFileSync(path.join(root,'builds','builds.json'),'utf8'));
const targets=manifest.filter(record=>!requested.length||requested.includes(record.version));
assert.ok(targets.length);
const eula=fs.readFileSync(path.join(SERVER,'eula.txt'),'utf8');
assert.match(eula,/^eula=true\s*$/m,'The local fixture must have an accepted server EULA');
const positions=[[2,70,2],[4,70,2],[6,70,2]];
const key=position=>position.join(',');
const spawnSettings=[
 'server-ip=127.0.0.1','server-port=0','online-mode=false','enable-rcon=false','enable-query=false',
 'level-type=minecraft:flat','generate-structures=false','view-distance=3','simulation-distance=3',
 'spawn-protection=0','allow-nether=false','sync-chunk-writes=true','max-tick-time=0'
].join('\n')+'\n';

async function bounded(check,child,description,timeout=45_000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){
  if(child.exitCode!==null||child.signalCode)throw Error('Paper exited during '+description);
  const value=await check();
  if(value)return value;
  await wait(250);
 }
 throw Error('Timed out waiting for '+description);
}

async function exportPaperDraft(server,worldDirectory,position){
 const project=path.join(server,'workbench-'+randomUUID());
 fs.mkdirSync(project);
 // Older builds already saved local IDs for worlds opened without uid.dat.
 const localId='local-'+'a'.repeat(32);
 fs.writeFileSync(path.join(project,'world-source.json'),JSON.stringify({directory:worldDirectory,world_uuid:localId}));
 const code=`
  import assert from 'node:assert/strict';
  import {callTool} from './tools/creative-workbench.mjs';
  const point=JSON.parse(process.argv[1]);
  const workbench=(name,args)=>callTool(name,args,{origin:'desktop'});
  const plans=await workbench('save_plan',{type:'marker',name:'Paper 26.3 导出验收',layer_id:'markers',points:[[point[0],point[2]]]});
  const draft=await workbench('create_draft',{plan_id:plans.selected_id,focus:point});
  assert.equal(draft.world_uuid,process.argv[2]);
  await workbench('edit_draft',{draft_id:draft.id,blocks:[{x:point[0],y:point[1],z:point[2],state:'minecraft:poplar_log[axis=z]'}]});
  console.log(JSON.stringify(await workbench('export_draft',{draft_id:draft.id})));
 `;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',code,JSON.stringify(position),localId],
  {cwd:new URL('..',import.meta.url),env:{...process.env,TERRAWEAVE_STATE:project},windowsHide:true,timeout:120_000});
 return JSON.parse(fs.readFileSync(JSON.parse(stdout).path,'utf8'));
}

async function run(record){
 const {version}=record,dataVersion=javaReleases[version];
 if(!record.jar)return {version,build:record.build,status:record.unavailable?'unavailable':'error',reason:record.unavailable??record.error};
 assert.ok(dataVersion,'Unexpected Minecraft version in build manifest');
 const server=path.join(root,'servers',version);
 if(!fs.existsSync(server)){
  fs.mkdirSync(path.join(server,'plugins'),{recursive:true});
  fs.symlinkSync(path.join(root,'cache'),path.join(server,'cache'),process.platform==='win32'?'junction':'dir');
 }
 const bridge=path.join(server,'plugins','TerraWeave');
 assert.equal(serverStatus(bridge).running,false,'The matrix server for '+version+' is already running');
 const jvm=fs.realpathSync(version.startsWith('26.')?java25:java21);
 fs.writeFileSync(path.join(server,'server.properties'),spawnSettings);
 fs.writeFileSync(path.join(server,'eula.txt'),eula);
 fs.copyFileSync(jar,path.join(server,'plugins','TerraWeave.jar'));
 const log=path.join(server,'matrix.log'),fd=fs.openSync(log,'w');
 const child=spawn(jvm,['-Dfile.encoding=UTF-8','-DPaper.IgnoreJavaVersion=false','-Xms192M','-Xmx850M','-XX:ActiveProcessorCount=2','-jar',record.jar,'--nogui'],
  {cwd:server,stdio:['pipe',fd,fd],windowsHide:true});
 fs.closeSync(fd);
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 const exited=new Promise(resolve=>child.once('exit',resolve));
 child.stdin.on('error',()=>{});
 const send=command=>child.stdin.write(command+'\n');
 const call=(action,args)=>serverRequest(action,args,bridge);
 const entities=async()=>(await call('read_block_entities',{positions})).entities;
 let phase='startup';
 try{
  const identity=await bounded(()=>{
   const status=serverStatus(bridge);
   return status.running&&status.identity.pid===child.pid?status.identity:null;
  },child,phase,95_000);
  assert.equal(identity.minecraft,version);
  assert.equal(identity.block_entity_payload,1,'Native NBT adapter is unavailable');
  phase='force-load fixture';
  send('forceload add 0 0');
  await bounded(async()=>Object.keys((await call('read_blocks',{positions})).blocks).length===3,child,phase);
  phase='seed exact block entity data';
  for(const p of positions)send(`setblock ${key(p).replaceAll(',',' ')} minecraft:air`);
  for(const [x,y,z] of positions)send(`setblock ${x} ${y-1} ${z} minecraft:stone`);
  const count=dataVersion>=3837?'count':'Count';
  const amount=n=>n+(count==='Count'?'b':'');
  const name=dataVersion>=4325?'{text:"TerraWeave Matrix"}':`'{"text":"TerraWeave Matrix"}'`;
  const textures=dataVersion>=3837
   ?'patterns:[{pattern:"minecraft:cross",color:"red"},{pattern:"minecraft:border",color:"blue"}]'
   :'Patterns:[{Pattern:"cr",Color:14},{Pattern:"bo",Color:11}]';
  const item=dataVersion>=3837?',components:{"minecraft:custom_data":{probe:1b}}':',tag:{probe:1b}';
  const pdc='PublicBukkitValues:{"terraweave:matrix_proof":42}';
  send(`setblock ${positions[0].join(' ')} minecraft:chest[facing=north,type=single,waterlogged=false]{CustomName:${name},Items:[{Slot:3b,id:"minecraft:diamond",${count}:${amount(7)}${item}}],${pdc}}`);
  send(`setblock ${positions[1].join(' ')} minecraft:barrel[facing=up,open=false]{Items:[{Slot:9b,id:"minecraft:book",${count}:${amount(4)}}],${pdc}}`);
  send(`setblock ${positions[2].join(' ')} minecraft:white_banner[rotation=0]{${textures},${pdc}}`);
  const baseline=await bounded(async()=>{
   const state=await entities();
   return positions.every(p=>state[key(p)]?.payload?.codec)?state:null;
  },child,phase);
  assert.match(baseline[key(positions[0])].payload.snbt,/TerraWeave Matrix/);
  assert.match(baseline[key(positions[0])].payload.snbt,/minecraft:diamond/);
  assert.match(baseline[key(positions[0])].payload.snbt,/probe/);
  assert.match(baseline[key(positions[1])].payload.snbt,/minecraft:book/);
  assert.match(baseline[key(positions[2])].payload.snbt,/Patterns|patterns/);
  for(const entry of Object.values(baseline))assert.match(entry.payload.snbt,/terraweave:matrix_proof/);

  const transport=bridgeTransport(bridge,{timeout:30_000});
  const writer=worldWriter({directory:path.join(server,'ledger'),send:transport});
  const targetBlock=version==='26.3'?'minecraft:poplar_log[axis=x]':'minecraft:stone';
  const design={schema:1,world_uuid:identity.world_uuid,draft_id:randomUUID(),draft_revision:1,minecraft:version,
   label:'TerraWeave Paper version matrix',base:Object.fromEntries(positions.map(p=>[key(p),baseline[key(p)].state])),
   changes:Object.fromEntries(positions.map(p=>[key(p),targetBlock])),previously_applied:{}};
  const verify=(result,changed,conflicts=0)=>{
   assert.equal(result.complete,true,result.error);
   assert.equal(result.changed,changed,JSON.stringify(result.conflicts));
   assert.equal(result.conflict_count,conflicts);
   assert.equal(result.undoable,true);
   return result;
  };
  if(version==='26.3'){
   phase='reject a mismatched version';
   const [x,y,z]=positions[0],block={x,y,z,before:baseline[key(positions[0])].state,state:targetBlock};
   await assert.rejects(transport(randomUUID(),{action:'apply_blocks',world_uuid:identity.world_uuid,minecraft:'26.2',blocks:[block]}),/版本.*不一致/);
   await assert.rejects(call('apply_blocks',{minecraft:'26.2',blocks:[block]}),/version differs/);
   assert.deepEqual(await entities(),baseline);
  }
  phase='apply';
  const applied=verify(await writer.apply(design),3);
  assert.ok(Object.values(await entities()).every(e=>e.state===targetBlock&&e.payload===null));
  if(version==='26.3'){
   phase='read the 26.3 save after durable apply';
   const index=worldIndex(identifyWorld(path.join(server,identity.world)));
   assert.equal(index.data_version,dataVersion);
   assert.equal(index.world_uuid,identity.world_uuid);
   assert.deepEqual(savedBlocks(positions.map(key),index),design.changes);
  }
  phase='undo';
  verify(await writer.reverse(applied.operation_id,'undo'),3);
  assert.deepEqual(await entities(),baseline);
  phase='redo and undo again';
  verify(await writer.reverse(applied.operation_id,'redo'),3);
  assert.ok(Object.values(await entities()).every(e=>e.state===targetBlock&&e.payload===null));
  verify(await writer.reverse(applied.operation_id,'undo'),3);
  assert.deepEqual(await entities(),baseline);
  phase='NBT conflict';
  send(`data merge block ${positions[0].join(' ')} {Items:[{Slot:0b,id:"minecraft:gold_ingot",${count}:${amount(1)}}]}`);
  const newer=await bounded(async()=>{
   const state=await entities();
   return state[key(positions[0])]?.payload?.snbt?.includes('minecraft:gold_ingot')?state:null;
  },child,phase);
  verify(await writer.reverse(applied.operation_id,'redo'),2,1);
  assert.deepEqual((await entities())[key(positions[0])],newer[key(positions[0])]);
  phase='item drop check';
  send('execute if entity @e[type=minecraft:item,x=4,y=70,z=2,distance=..12] run say TERRAWAVE_UNEXPECTED_ITEM_DROP');
  await call('status');
  assert.doesNotMatch(fs.readFileSync(log,'utf8'),/\[Server\] TERRAWAVE_UNEXPECTED_ITEM_DROP/);
  if(version==='26.3'){
   phase='apply an exported workbench draft';
   const position=[10,72,10],coordinate=key(position),worldDirectory=path.join(server,identity.world);
   const readSaved=()=>savedBlocks([coordinate],worldIndex(identifyWorld(worldDirectory)))[coordinate];
   const before=readSaved(),exported=await exportPaperDraft(server,worldDirectory,position);
   assert.equal(exported.world_uuid,identity.world_uuid);
   assert.equal(exported.minecraft,version);
   assert.equal(readSaved(),before);
   const committed=verify(await writer.apply(exported),1);
   assert.equal(readSaved(),'minecraft:poplar_log[axis=z]');
   verify(await writer.reverse(committed.operation_id,'undo'),1);
   assert.equal(readSaved(),before);
  }
  return {version,build:record.build,channel:record.channel,status:'pass',nbt:['chest','barrel','banner'],conflictProtection:true,
   ...(version==='26.3'?{diskDataVersion:dataVersion,writtenBlock:targetBlock,versionMismatchRejected:true,workbenchExportAppliedAndUndone:true}:{}),log};
 }catch(error){
  return {version,build:record.build,channel:record.channel,status:'fail',phase,error:error.message,log};
 }finally{
  if(child.exitCode===null&&!child.signalCode){send('stop');child.stdin.end();}
  const timeout=setTimeout(()=>{if(child.exitCode===null&&!child.signalCode)child.kill();},20_000);
  try{await exited;}finally{clearTimeout(timeout);}
 }
}

const results=[];
const slots=Math.min(3,Number(process.env.TERRAWEAVE_PAPER_JOBS||'2'));
let next=0;
await Promise.all(Array.from({length:slots},async()=>{
 while(next<targets.length){
  const record=targets[next++];
  let result;
  try{result=await run(record);}catch(error){result={version:record.version,status:'error',error:error.message};}
  results.push(result);
  console.log(JSON.stringify(result));
 }
}));
const output=path.join(root,requested.length?'results-'+requested.join('+')+'.json':'results.json');
fs.writeFileSync(output,JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify({results:output,passed:results.filter(r=>r.status==='pass').length,total:results.length}));
if(results.some(r=>r.status==='error'||r.status==='fail'))process.exitCode=1;
