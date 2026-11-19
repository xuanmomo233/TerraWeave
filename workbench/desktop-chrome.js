import {invoke} from '@tauri-apps/api/core';
export function installDesktopChrome(popup,say){
 document.addEventListener('contextmenu',event=>{
  if(event.defaultPrevented)return;event.preventDefault();const field=event.target.closest('input,textarea'),selection=window.getSelection()?.toString()??'';
  if(field){const value=field.value,start=field.selectionStart??0,end=field.selectionEnd??value.length,selected=value.slice(start,end),editable=!field.disabled&&!field.readOnly;
   const replace=text=>{if(field.value!==value){say('内容已变化，请重新打开菜单');return;}field.focus();try{field.setSelectionRange(start,end);}catch{}if(!document.execCommand('insertText',false,text)){field.value=value.slice(0,start)+text+value.slice(end);field.dispatchEvent(new Event('input',{bubbles:true}));}field.dispatchEvent(new Event('change',{bubbles:true}));};
   popup([{label:'剪切',key:'Ctrl+X',disabled:!editable||!selected,action:async()=>{await invoke('workbench_clipboard',{text:selected});replace('');}},{label:'复制',key:'Ctrl+C',disabled:!selected,action:()=>invoke('workbench_clipboard',{text:selected})},{label:'粘贴',key:'Ctrl+V',disabled:!editable,action:async()=>{const text=await invoke('workbench_clipboard');if(text)replace(text);}},null,{label:'全选',key:'Ctrl+A',action:()=>{field.focus();field.select();}}],event.clientX,event.clientY);
  }else if(selection)popup([{label:'复制',key:'Ctrl+C',action:()=>invoke('workbench_clipboard',{text:selection})}],event.clientX,event.clientY);
 });
 document.addEventListener('dragstart',event=>{if(!event.target.closest('input,textarea,[contenteditable=true]'))event.preventDefault();});
 document.addEventListener('mousedown',event=>{if(event.button===1&&!event.target.closest('input,textarea'))event.preventDefault();});
 document.addEventListener('keydown',event=>{if(event.key==='F12'||(event.ctrlKey||event.metaKey)&&event.shiftKey&&['i','j','c'].includes(event.key.toLowerCase())){event.preventDefault();return;}if(!(event.ctrlKey||event.metaKey)||event.target.closest('input,textarea,[contenteditable=true]'))return;const key=event.key.toLowerCase();if(key==='f'){event.preventDefault();document.getElementById('tree-search')?.focus();}else if(key==='r'){event.preventDefault();document.getElementById('refresh')?.click();}else if(!event.shiftKey&&['p','u','+','-','=','0'].includes(key))event.preventDefault();});
}
