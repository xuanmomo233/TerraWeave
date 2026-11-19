export const documentKey=r=>r.draft_id?'draft:'+r.draft_id:r.view_id?'scene:'+r.view_id:r.panorama?'world-panorama':r.transient?'world-3d':'region:'+(r.entity_id??r.id);
export function openDocument(documents,region){
 const key=documentKey(region),next={key,region,label:region.label};
 const existing=documents.some(d=>d.key===key);
 return existing?documents.map(d=>d.key===key?{...d,...next}:d):[...documents,next];
}
export function closeDocument(documents,key){return documents.filter(d=>d.key!==key);}
export function editorShortcut(event,inText=false){
 const key=event.key.toLowerCase(),mod=event.ctrlKey||event.metaKey;
 if(mod){if(key==='s')return event.shiftKey?'checkpoint':'save';if(inText)return null;if(key==='z')return event.shiftKey?'redo':'undo';if(key==='y')return 'redo';if(key==='n')return 'new-region';if(key==='w')return 'close';if(key==='enter')return 'apply';if(key==='p'&&event.shiftKey)return 'capture';return null;}
 if(inText)return null;return {v:'select',b:'plan-area',o:'plan-polygon',m:'plan-marker',p:'paint',e:'erase',r:'orbit',f:'focus',g:'grid','7':'top','1':'north','3':'east',f5:'refresh',f1:'help',delete:'delete-block'}[key]??null;
}
