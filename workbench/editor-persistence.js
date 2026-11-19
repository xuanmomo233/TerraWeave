export function editorPersistence(call,report,getViews){
  let state={version:1,updated_at:0,forms:{},tabs:[],active:null},key,timer,write=Promise.resolve();
  const ready=call('read_editor_state').then(result=>{
    key='terraweave.editor.'+result.key;
    let local;
    try{local=JSON.parse(localStorage.getItem(key));}catch{}
    const stored=local?.version===1&&local.updated_at>(result.state?.updated_at??0)?local:result.state;
    if(stored?.version===1)state={...stored,forms:{...stored.forms,...state.forms}};
    return state;
  }).catch(()=>state);

  function snapshot(){
    const views=getViews();
    if(views)Object.assign(state,views);
    state.updated_at=Math.max(Date.now(),state.updated_at+1);
    return JSON.stringify(state);
  }
  function stash(){
    const bytes=snapshot();
    if(key){try{localStorage.setItem(key,bytes);}catch{}}
    return bytes;
  }
  window.addEventListener('pagehide',()=>{if(key)stash();});
  async function flush(){
    await ready;
    clearTimeout(timer);
    if(!key)return;
    const next=JSON.parse(stash());
    write=write.catch(()=>{}).then(()=>call('save_editor_state',{state:next}));
    return write;
  }
  function schedule(){
    if(!key)return;
    stash();
    clearTimeout(timer);
    timer=setTimeout(()=>flush().catch(error=>report('无法写入工程会话 · '+String(error))),450);
  }
  return {
    ready,flush,schedule,
    fields(id){return state.forms[id]??{};},
    edit(id,field,value){(state.forms[id]??={})[field]=value;schedule();},
    clear(id){delete state.forms[id];schedule();},
    hasEdits(){return Object.keys(state.forms).length>0;},
  };
}
