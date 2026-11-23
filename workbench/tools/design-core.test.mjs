import assert from 'node:assert/strict';
import {test} from 'node:test';
import {diffChanges,editOverlay,draftApplyPlan,historyActions,advanceHistory,draftPatch,replayDraftPatch} from './design-core.mjs';
import {makeIndex,cellsInChunk} from '../chunk-index.js';
import {designService} from './design-service.mjs';
import {documentKey} from '../editor-state.js';

const base={bounds:[-1,0,0,1,0,0],blocks:{'-1,0,0':'minecraft:air','0,0,0':'minecraft:stone','1,0,0':'minecraft:glass'}};
test('bundled draft edits display the saved revision and preserve it when preview fails',async()=>{
 const storage=new Map(),rendered=[],scope={...base,uuid:'world-test'};
 const region={id:'base',world_uuid:scope.uuid,snapshot_id:'base-hash',snapshot_hash:'base-hash',bounds:scope.bounds,source:'live_paper_main_thread',label:'基础区域'};
 let writes=0,failDisplay=false,current=region;
 const service=designService({
  folder:name=>name,read:file=>structuredClone(storage.get(file)),
  atomic:(file,data)=>storage.set(file,structuredClone(data)),
  readRegion:()=>({region,snapshot:scope}),readRegionMetadata:()=>region,currentRegion:()=>current,
  planning:{read:()=>({objects:[],layers:[]})},
  saveSnapshot:()=>{writes++;return {snapshot_id:'draft-hash',snapshot_hash:'draft-hash'};},
  savePreview:()=>{},
  displayRegion:(r,_kind,_navigation,snapshot,expected)=>{
   if(failDisplay)throw Error('预览连接中断');
   rendered.push({region:r,snapshot,expected});
   return r;
  },
  validateEdits:()=>{},normalizeState:state=>state,
  readSavedPositions:()=>{throw Error('Existing region baselines are already pinned');}
 });
 const d=await service.execute('create_draft',{region_id:'base'}),draft_id=d.id;
 const blocks=[{x:-1,y:0,z:0,state:'minecraft:oak_planks'}];
 await assert.rejects(service.execute('edit_draft',{draft_id,blocks,preview:{mode:'invalid'}}),/Unknown draft view/);
 assert.equal((await service.execute('inspect_draft',{draft_id})).draft.revision,1);
 const edited=await service.execute('edit_draft',{draft_id,blocks,preview:{mode:'diff'}});
 assert.equal(edited.preview.draft_revision,edited.revision);
 assert.equal(rendered.at(-1).snapshot.blocks['-1,0,0'],'minecraft:oak_planks');
 assert.equal(rendered.at(-1).region.keep_camera,true);
 const undone=await service.execute('undo_draft',{draft_id,preview:{mode:'diff'}});
 assert.equal(undone.preview.snapshot_hash,'base-hash');
 assert.equal(writes,1);
 failDisplay=true;
 const redone=await service.execute('redo_draft',{draft_id,preview:{mode:'diff'}});
 assert.equal(redone.preview_error,'预览连接中断');
 assert.equal((await service.execute('inspect_draft',{draft_id})).draft.revision,redone.revision);
 assert.equal((await service.execute('inspect_draft',{draft_id})).changes[0].after,'minecraft:oak_planks');
 failDisplay=false;
 const hidden=await service.execute('update_draft',{draft_id,visible:false});
 assert.deepEqual(hidden.change_focus,[-1,0,0]);
 const located=await service.execute('preview_draft',{draft_id,mode:'diff',reveal_changes:true,expected_region_id:region.id});
 assert.equal(located.design_visible,false);
 assert.equal(located.reveal_changes,true);
 assert.equal(rendered.at(-1).snapshot.blocks['-1,0,0'],'minecraft:air');
 assert.deepEqual(rendered.at(-1).region.diff.map(change=>change.coordinate),[[-1,0,0]]);
 assert.equal(rendered.at(-1).expected,region.id);
 current={id:'another-view'};
 assert.deepEqual(await service.execute('preview_draft',{draft_id,expected_region_id:region.id}),{cancelled:true});
});
test('drafts from a view do not inherit its tab identity',()=>{
 assert.match(documentKey({view_id:'scene-a',draft_id:'draft-a',transient:true}),/^draft:draft-a$/);
});
test('draft overlay preserves its base and distinguishes additions, replacements and removals',()=>{
 const copy=structuredClone(base),next=editOverlay(base,base.bounds,{},[{x:-1,y:0,z:0,state:'minecraft:oak_planks'},{x:0,y:0,z:0,state:'minecraft:air'},{x:1,y:0,z:0,state:'minecraft:stone'}]);
 assert.deepEqual(base,copy);assert.deepEqual(diffChanges(base,next).counts,{added:1,replaced:1,removed:1});
 assert.deepEqual(editOverlay(base,base.bounds,next,[{x:0,y:0,z:0,state:'minecraft:stone'}],true),{});
 assert.throws(()=>editOverlay(base,[0,0,0,1,0,0],{},[{x:-1,y:0,z:0,state:'minecraft:stone'}]),/outside/);
});
test('revised designs recognize their applied progress and can remove an earlier design',()=>{
 const empty={blocks:{'0,0,0':'minecraft:air'}};
 assert.deepEqual(draftApplyPlan(empty,{'0,0,0':'minecraft:oak_planks'},{'0,0,0':'minecraft:stone'},{'0,0,0':'minecraft:stone'})[0],{x:0,y:0,z:0,state:'minecraft:oak_planks',before:'minecraft:stone'});
 assert.equal(draftApplyPlan(empty,{}, {'0,0,0':'minecraft:stone'},{'0,0,0':'minecraft:stone'})[0].state,'minecraft:air');
 assert.equal(draftApplyPlan(empty,{'0,0,0':'minecraft:stone'},{'0,0,0':'minecraft:stone'},{'0,0,0':'minecraft:air'})[0].before,'minecraft:air','undo restores a valid base for resuming the design');
 assert.equal(draftApplyPlan(empty,{'0,0,0':'minecraft:oak_planks'},{'0,0,0':'minecraft:stone'},{'0,0,0':'minecraft:diamond_block'})[0].before,'minecraft:stone','external changes are still conflicts');
});
test('partial undo/redo retains conflicting coordinates and only replays successfully undone cells',()=>{
 const record={undoable:true,undone_keys:[],changes:[{x:0,y:0,z:0,before:'minecraft:air',after:'minecraft:stone'},{x:1,y:0,z:0,before:'minecraft:glass',after:'minecraft:oak_planks'}]};
 const actions=historyActions(record,'undo'),partial=advanceHistory(record,'undo',actions,[{coordinate:'1,0,0'}]);
 assert.equal(partial.state,'partly_undone');assert.deepEqual(partial.undone_keys,['0,0,0']);
 const redo=historyActions(partial,'redo');assert.equal(redo.length,1);assert.equal(redo[0].before,'minecraft:air');
 assert.equal(advanceHistory(partial,'redo',redo,[]).state,'applied');
 assert.throws(()=>historyActions({...record,undoable:false},'undo'),/block-entity/);
});
test('Y cutaways retain exact world coordinates and hide cells outside both layer bounds',()=>{
 const snapshot={bounds:[-1,-1,0,0,1,0],blocks:{'-1,-1,0':'minecraft:stone','-1,0,0':'minecraft:glass','0,1,0':'minecraft:oak_planks'}};
 const index=makeIndex(snapshot),cells=index.chunks.flatMap(c=>cellsInChunk(c,0,0));
 assert.deepEqual(cells.map(c=>c.k),['-1,0,0']);
});
test('draft brush undo stores sparse edits, restores its base, and preserves redo semantics',()=>{
 const changes={'-1,0,0':'minecraft:oak_planks'},patch=draftPatch(base,{},changes);
 assert.equal(patch.length,1);assert.deepEqual(replayDraftPatch(base,changes,patch,'undo'),{});assert.deepEqual(replayDraftPatch(base,{},patch,'redo'),changes);
 assert.throws(()=>replayDraftPatch(base,{'-1,0,0':'minecraft:diamond_block'},patch,'undo'),/changed/);
});
