import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateBounds,callTool,TOOLS} from './creative-workbench.mjs';

test('exact inclusive regions cover negative coordinates and reject unsafe or excessive volume',()=>{
 assert.equal(validateBounds([-1,55,-1,16,75,16]),6804);
 assert.equal(validateBounds([0,-64,0,47,-1,47]),147456);
 for(const b of [[0,0,0,0,0],[1,0,0,0,0,0],[0,-65,0,0,0,0],[0,0,0,0,320,0],[0,0,0,1000,1000,1000],[0,0,0,.5,1,1],[0,0,0,NaN,1,1]])assert.throws(()=>validateBounds(b));
});
test('CLI and MCP reject unsupported tools and inputs before side effects',async()=>{
 await assert.rejects(callTool('arbitrary_shell',{}),/Unknown/);
 await assert.rejects(callTool('workbench_status',{path:'D:/'}),/Invalid/);
 await assert.rejects(callTool('load_region',{}),/Missing/);
 await assert.rejects(callTool('apply_blocks',{blocks:[],physics:'yes'}),/Unknown/);
 await assert.rejects(callTool('compact_storage',{remove_backups:'false'}),/boolean/);
 await assert.rejects(callTool('load_region',{bounds:[0,0,0,128,0,0]}),/128/);
 await assert.rejects(callTool('load_region',{bounds:[0,0,0,.5,0,0]}),/integer/);
});
test('capture tools expose images honestly and creative tools are declared mutating',()=>{
 assert.ok(TOOLS.find(t=>t.name==='capture_views').description.includes('not Minecraft-client screenshots'));
 for(const name of ['load_region','set_selection','capture_views','export_draft'])assert.notEqual(TOOLS.find(t=>t.name===name).annotations?.readOnlyHint,true);
 for(const name of ['start_server','stop_server','apply_blocks','apply_draft','undo_edit'])assert.equal(TOOLS.some(t=>t.name===name),false);
});
