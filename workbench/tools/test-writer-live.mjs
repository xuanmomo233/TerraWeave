// Development fixture only. The workbench never imports this entry point.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SERVER,serverStatus,serverRequest,startServer,stopServer} from './test-server.mjs';
import {bridgeTransport,worldWriter} from './world-writer.mjs';

if(serverStatus().running)throw Error('请在测试服停止时运行独立写入验收');
const [x,y,z]=[40,58,10],key=[x,y,z].join(',');
const ledger=fs.mkdtempSync(path.join(os.tmpdir(),'terraweave-live-writer-'));
let before,target;
try{
 const status=await startServer();
 const snapshot=await serverRequest('snapshot',{bounds:[x,y,z,x,y,z],generated_only:true});
 assert.equal(snapshot.block_entity_count,0);
 before=snapshot.blocks[key];
 assert.ok(before,'验收点必须已生成');
 target=before==='minecraft:polished_andesite'?'minecraft:stone':'minecraft:polished_andesite';
 const connector=worldWriter({directory:ledger,send:bridgeTransport(path.join(SERVER,'plugins','WorkbenchLive'))});
 const blueprint={schema:1,world_uuid:status.identity.world_uuid,draft_id:randomUUID(),draft_revision:1,
  label:'独立写入链路验收',base:{[key]:before},changes:{[key]:target},previously_applied:{}};
 const result=await connector.apply(blueprint);
 assert.equal(result.complete,true,result.error);
 assert.equal(result.changed,1);
 const repeated=await connector.apply(blueprint,result.operation_id);
 assert.equal(repeated.changed,1);
 assert.equal((await serverRequest('read_blocks',{positions:[[x,y,z]]})).blocks[key],target);
 const undo=await connector.reverse(result.operation_id,'undo');
 assert.equal(undo.complete,true,undo.error);
 assert.equal(undo.changed,1);
 assert.equal((await serverRequest('read_blocks',{positions:[[x,y,z]]})).blocks[key],before);
 console.log(JSON.stringify({passed:true,world_uuid:status.identity.world_uuid,write:result,undo,restored_block:before,ledger}));
}finally{
 if(serverStatus().running){
  try{
   if(before){
    const actual=(await serverRequest('read_blocks',{positions:[[x,y,z]]})).blocks[key];
    if(actual===target)await serverRequest('apply_blocks',{blocks:[{x,y,z,state:before,before:target}],physics:false});
   }
  }finally{await stopServer();}
 }
}
