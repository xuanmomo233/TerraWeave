import {invoke} from '@tauri-apps/api/core';

export function installViewportLook(canvas, canStart, move) {
  let pointer = null, hadLock = false, restore = false;
  function centerCursor() {
    if (!document.hasFocus() || !canvas.clientWidth) return;
    const rect = canvas.getBoundingClientRect();
    invoke('center_view_cursor', {
      x: Math.round((rect.left + rect.width / 2) * devicePixelRatio),
      y: Math.round((rect.top + rect.height / 2) * devicePixelRatio)
    }).catch(()=>{});
  }
  function finish(center = false) {
    if (pointer === null) return;
    const id = pointer;
    pointer = null;
    canvas.classList.remove('looking');
    if (document.pointerLockElement === canvas) {
      restore = center;
      document.exitPointerLock();
    } else if (center) centerCursor();
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }
  canvas.addEventListener('pointerdown',event => {
    if (pointer !== null) {event.stopImmediatePropagation();return;}
    if (event.button !== 2 || event.buttons !== 2 || !canStart()) return;
    event.stopImmediatePropagation();event.preventDefault();
    pointer=event.pointerId;restore=false;
    canvas.classList.add('looking');
    canvas.setPointerCapture(pointer);
    try { canvas.requestPointerLock?.()?.catch(()=>{}); } catch {}
  },true);
  canvas.addEventListener('pointermove',event=>{
    if(pointer===null)return;
    event.stopImmediatePropagation();
    if(!(event.buttons & 2) || !canStart()){finish();return;}
    move(event.movementX,event.movementY,event);
  },true);
  function release(event) {
    if(pointer===null || event.button!==2)return;
    event.stopImmediatePropagation();finish(true);
  }
  window.addEventListener('pointerup',release,true);
  window.addEventListener('mouseup',release,true);
  canvas.addEventListener('pointercancel',()=>finish());
  canvas.addEventListener('contextmenu',event=>event.preventDefault());
  document.addEventListener('pointerlockchange',()=>{
    if(document.pointerLockElement === canvas) {
      hadLock=true;
      if(pointer===null)document.exitPointerLock();
    } else if(hadLock){
      hadLock=false;finish();
      if(restore)centerCursor();
      restore=false;
    }
  });
  window.addEventListener('blur',()=>{restore=false;finish();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)finish();});
  window.addEventListener('keydown',event=>{if(event.key==='Escape')finish();},true);
}

