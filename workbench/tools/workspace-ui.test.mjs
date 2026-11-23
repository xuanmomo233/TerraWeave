import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openDocument,closeDocument,documentKey,editorShortcut} from '../editor-state.js';
import {callWorkbench,readWorkbenchSnapshot} from '../workbench-api.js';

test('a callback retained by the old page keeps its original project generation across navigation',async t=>{
 const oldWindow=globalThis.window,oldLocation=globalThis.location;
 t.after(()=>{
  if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;
  if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;
 });
 const received=[];
 globalThis.window={__TAURI_INTERNALS__:{invoke:async(command,{projectEpoch})=>{received.push([command,projectEpoch]);}}};
 globalThis.location={search:'?project_epoch=4'};
 const oldPage=await import('../workbench-api.js?source-page');
 globalThis.location={search:'?project_epoch=5'};
 const nextPage=await import('../workbench-api.js?target-page');
 await oldPage.callWorkbench('save_editor_state',{});
 await nextPage.callWorkbench('save_editor_state',{});
 await oldPage.invokeProject('workbench_poll');
 assert.deepEqual(received,[['workbench_call',4],['workbench_call',5],['workbench_poll',4]]);
});

test('a committed planning notification supersedes in-flight panel snapshots',async t=>{
 const requests=[];
 const original=globalThis.window;
 globalThis.window={__TAURI_INTERNALS__:{invoke:(command,{tool})=>{
  assert.equal(command,'workbench_call');assert.equal(tool,'ui_snapshot');
  return new Promise((resolve,reject)=>requests.push({resolve,reject}));
 }}};
 t.after(()=>{if(original===undefined)delete globalThis.window;else globalThis.window=original;});
 const before=callWorkbench('ui_snapshot');
 assert.equal(callWorkbench('ui_snapshot'),before);
 const hide=readWorkbenchSnapshot({fresh:true});
 assert.equal(callWorkbench('ui_snapshot'),hide);
 const show=readWorkbenchSnapshot({fresh:true});
 assert.equal(callWorkbench('ui_snapshot'),show);
 assert.equal(requests.length,3);
 const newest={revision:3};
 requests[2].resolve(newest);
 assert.deepEqual(await Promise.all([before,hide,show]),[newest,newest,newest]);
 requests[1].resolve({revision:2});
 requests[0].reject(Error('stale transport error'));
 const next=callWorkbench('ui_snapshot');
 assert.notEqual(next,show);
 requests[3].resolve({revision:4});
 assert.equal((await next).revision,4);
});

test('refreshes and view changes update one document tab for the same project object',()=>{
 const a={id:'revision-1',entity_id:'region-castle',label:'城堡'},b={...a,id:'revision-2'};
 let docs=openDocument([],a);docs=openDocument(docs,b);assert.equal(docs.length,1);assert.equal(docs[0].region.id,'revision-2');
 docs=openDocument(docs,{id:'preview-target',draft_id:'design-1',label:'城堡设计'});docs=openDocument(docs,{id:'preview-diff',draft_id:'design-1',label:'城堡设计'});assert.equal(docs.length,2);
 assert.equal(closeDocument(docs,documentKey(a)).length,1);
});
test('independent 3D views share scene data and retain separate camera state',()=>{
 const a={id:'world-scene',view_id:'north-view',panorama:true,label:'北侧'};
 const b={...a,view_id:'south-view',label:'南侧'};
 let docs=openDocument(openDocument([],a),b);
 docs[0].camera={position:[8,60,-20]};
 docs=openDocument(docs,{...a,world_revision:'updated'});
 assert.equal(docs.length,2);
 assert.deepEqual(docs[0].camera.position,[8,60,-20]);
 assert.equal(docs[1].camera,undefined);
 assert.equal(closeDocument(docs,documentKey(a))[0].region.view_id,'south-view');
});
test('editor shortcuts respect text editing and route draft controls consistently',()=>{
 const key=(key,extra={})=>({key,ctrlKey:false,metaKey:false,shiftKey:false,...extra});
 assert.equal(editorShortcut(key('z',{ctrlKey:true}),true),null);
 assert.equal(editorShortcut(key('s',{ctrlKey:true}),true),'save');
 assert.equal(editorShortcut(key('s',{ctrlKey:true,shiftKey:true})),'checkpoint');
 assert.equal(editorShortcut(key('p')),'paint');assert.equal(editorShortcut(key('b')),'plan-area');assert.equal(editorShortcut(key('o')),'plan-polygon');assert.equal(editorShortcut(key('p'),true),null);
 assert.equal(editorShortcut(key('Enter',{ctrlKey:true})),'apply');
});
