import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {gunzipSync} from 'node:zlib';

test('a new void world preserves unbound plans and provides an air baseline', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terraweave-void-'));
 const oldState=process.env.TERRAWEAVE_STATE,oldWorld=process.env.TERRAWEAVE_WORLD;
 process.env.TERRAWEAVE_STATE=root;
 delete process.env.TERRAWEAVE_WORLD;
 t.after(()=>{
  if(oldState===undefined)delete process.env.TERRAWEAVE_STATE;
  else process.env.TERRAWEAVE_STATE=oldState;
  if(oldWorld!==undefined)process.env.TERRAWEAVE_WORLD=oldWorld;
  fs.rmSync(root,{recursive:true,force:true});
 });
 const {callTool}=await import('./creative-workbench.mjs');
 const {worldIndex,parseNbt,readWorldChunk}=await import('./world-surface.mjs');
 const {savedDetailSnapshot,savedBlocks}=await import('./render-context.mjs');
 const call=(name,args)=>callTool(name,args,{origin:'desktop'});
 const before=await call('save_plan',{name:'城堡',type:'area',points:[[-1032,680],[-1000,680],[-1000,712],[-1032,712]],
  layer_id:'buildings',min_y:70,max_y:70,notes:'主塔在西侧'});
 const world=await call('create_void_world',{name:'空白沙盘'});
 assert.deepEqual(world.void_world.spawn,[-1016,70,696]);
 assert.equal(world.plan_id,before.selected_id);
 const current=await call('planning_state');
 assert.equal(current.world_uuid,world.world_uuid);
 assert.deepEqual(current.objects,before.objects);
 assert.deepEqual(current.layers,before.layers);
 assert.equal(current.undo_count,before.undo_count);
 const level=parseNbt(gunzipSync(fs.readFileSync(path.join(world.directory,'level.dat')))).Data;
 assert.equal(level.LevelName,'空白沙盘');
 assert.equal(level.DataVersion,3465);
 const generator=level.WorldGenSettings.dimensions['minecraft:overworld'].generator;
 assert.equal(generator.type,'minecraft:flat');
 assert.equal(generator.settings.biome,'minecraft:the_void');
 assert.deepEqual(generator.settings.layers,[]);
 const info=worldIndex();
 assert.equal(info.pristine_void,true);
 assert.deepEqual(savedBlocks(['-1016,70,696','2000000,1,-2000000'],info),
  {'-1016,70,696':'minecraft:air','2000000,1,-2000000':'minecraft:air'});
 assert.deepEqual(savedDetailSnapshot([-1016,70,696,-1014,74,698],info).blocks,{});
 assert.equal(readWorldChunk(0,0,world.directory),null);
 await assert.rejects(call('create_void_world',{name:'重复点击'}),/已关联世界/);
 assert.equal(fs.readdirSync(path.join(root,'worlds')).length,1);
});
