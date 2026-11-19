import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {pathToFileURL} from 'node:url';
import {bridgeTransport,worldWriter} from './world-writer.mjs';

const id={type:'string'};
const tool=(name,description,properties,required)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
const tools=[
 tool('apply_exported_design','Apply a frozen TerraWeave export through the configured plugin. Repeat the same operation ID to resume safely.',{export_path:{type:'string'},operation_id:id},['export_path']),
 tool('world_write_status','Read persisted batch receipts for a write operation.',{operation_id:id},['operation_id']),
 tool('list_world_writes','List write receipts from this connector.',{},[]),
 tool('undo_world_write','Reverse committed cells using current before-state checks.',{operation_id:id},['operation_id']),
 tool('redo_world_write','Reapply cells that were successfully undone.',{operation_id:id},['operation_id'])
];
let service;
function configured(){
 const bridge=process.env.TERRAWEAVE_WRITE_BRIDGE;
 if(!bridge)throw Error('请为写入 MCP 设置 TERRAWEAVE_WRITE_BRIDGE，指向已配置的配套插件数据目录');
 const directory=process.env.TERRAWEAVE_WRITER_STATE??path.join(bridge,'writer-state');
 return service??=worldWriter({directory,send:bridgeTransport(bridge)});
}
export function callWriter(name,args={}){
 const definition=tools.find(t=>t.name===name);
 if(!definition||!args||typeof args!=='object'||Array.isArray(args)||
  Object.keys(args).some(k=>!Object.hasOwn(definition.inputSchema.properties,k))||
  definition.inputSchema.required.some(k=>typeof args[k]!=='string'))throw Error('无效的写入 MCP 请求');
 const writer=configured();
 if(name==='apply_exported_design'){
  const file=path.resolve(args.export_path),stat=fs.statSync(file);
  if(!stat.isFile()||stat.size>64*1024*1024)throw Error('方案文件超出写入上限');
  return writer.apply(JSON.parse(fs.readFileSync(file,'utf8')),args.operation_id);
 }
 if(name==='world_write_status')return writer.status(args.operation_id);
 if(name==='list_world_writes')return writer.history();
 return writer.reverse(args.operation_id,name==='undo_world_write'?'undo':'redo');
}
async function handle(q){
 if(q.id===undefined)return;
 let result;
 if(q.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'TerraWeave World Writer',version:'0.6.0'}};
 else if(q.method==='tools/list')result={tools};
 else if(q.method==='ping')result={};
 else if(q.method==='tools/call'){
  try{result={content:[{type:'text',text:JSON.stringify(await callWriter(q.params.name,q.params.arguments??{}))}]};}
  catch(error){result={isError:true,content:[{type:'text',text:error.message}]};}
 }else return {jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'Method not found'}};
 return {jsonrpc:'2.0',id:q.id,result};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 if(process.argv.includes('--stdio')){
  const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of lines){
   try{const reply=await handle(JSON.parse(line));if(reply)console.log(JSON.stringify(reply));}
   catch(error){console.log(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:error.message}}));}
  }
 }else{
  try{console.log(JSON.stringify(await callWriter(process.argv[2],JSON.parse(process.argv[3]??'{}'))));}
  catch(error){console.error(error.message);process.exitCode=1;}
 }
}
