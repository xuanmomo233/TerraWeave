import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openDocument,closeDocument,documentKey,editorShortcut} from '../editor-state.js';

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
