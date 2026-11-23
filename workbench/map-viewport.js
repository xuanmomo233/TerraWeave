import {inkFor} from './theme-model.js';
import {installViewportLook} from './viewport-look.js';
import {mapToScreen,screenToMap,pointInPolygon,planBounds} from './tools/planning-core.mjs';
import {wheelSteps,wheelZoomFactor,readWheelSensitivity} from './viewport-wheel.js';
import {PlanningSketch,planningModes,planningPoint,drawPlanningTarget,nearestHandle} from './planning-sketch.js';

const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const tileVisibility=(info,key)=>info?.visibility_map_tiles?info.visibility_map_tiles[key]??'':info?.visibility_revision??'';
export class MapViewport{
 constructor(canvas,call,events={},offscreen=false){
  this.canvas=canvas;this.ctx=canvas.getContext('2d');this.call=call;this.events=events;this.view={x:0,z:0,scale:4,rotation:0};this.tiles=new Map();this.pending=new Set();this.fetching=new Map();this.queue=[];this.tool='select';this.sketch=new PlanningSketch();this.drag=null;this.width=1;this.height=1;this.active=true;
  if(offscreen)return;
  const readAppearance=()=>{
   const style=getComputedStyle(document.documentElement);
   const token=key=>style.getPropertyValue('--'+key).trim();
   this.appearance={font:parseFloat(style.fontSize),text:token('text'),muted:token('muted'),background:token('background'),accent:token('accent'),outline:inkFor(token('text'))};
  };
  readAppearance();
  window.addEventListener('workbench-appearance',()=>{readAppearance();if(this.ctx&&this.active)this.draw();});
  this.sketchCanvas=document.createElement('canvas');
  this.sketchCanvas.id='map-planning-preview';
  this.sketchCanvas.setAttribute('aria-hidden','true');
  this.sketchCanvas.hidden=true;
  canvas.after(this.sketchCanvas);
  this.sketchContext=this.sketchCanvas.getContext('2d');
  this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(canvas.parentElement);
  installViewportLook(canvas, () => !this.capturing && !this.drag, dx => {
   this.userMoved = true;
   this.view.rotation = ((this.view.rotation + dx * .4) % 360 + 360) % 360;
   this.request(); this.draw(); this.notify();
  });
  canvas.addEventListener('contextmenu',e=>e.preventDefault());canvas.addEventListener('pointerdown',e=>this.down(e));canvas.addEventListener('pointermove',e=>this.move(e));canvas.addEventListener('pointerup',e=>this.up(e));canvas.addEventListener('pointercancel',()=>this.cancelDrag());canvas.addEventListener('lostpointercapture',()=>this.cancelDrag());window.addEventListener('blur',()=>this.cancelDrag());canvas.addEventListener('dblclick',e=>this.double(e));canvas.addEventListener('wheel',e=>this.wheel(e),{passive:false});
  canvas.addEventListener('pointerleave',()=>{this.sketch.hover(null);this.drawSketch();});
 }
 resize(){
  if(!this.active)return false;
  const r=this.canvas.parentElement.getBoundingClientRect();
  if(!r.width||!r.height)return false;
  const width=Math.max(1,Math.floor(r.width)),height=Math.max(1,Math.floor(r.height)),d=Math.min(devicePixelRatio,2);
  const pixelsX=Math.floor(width*d),pixelsY=Math.floor(height*d);
  if(this.width===width&&this.height===height&&this.canvas.width===pixelsX&&this.canvas.height===pixelsY)return false;
  this.width=width;this.height=height;this.canvas.width=pixelsX;this.canvas.height=pixelsY;
  this.ctx.setTransform(d,0,0,d,0,0);this.request();this.draw();return true;
 }
 setActive(value){
  if(this.active===value)return;
  this.active=value;
  if(value){if(!this.resize()){this.request();this.draw();}}
  else{this.queue=[];this.events.progress?.(0);}
 }
 async open(info,planning,view){this.cancelDrag();this.setTerrain(info,false);this.planning=planning;this.autoFocus=!view&&!info.view;this.userMoved=false;if(view)this.view={...view};else if(info.view)this.view={...info.view};else this.fit(info.bounds);if(!this.resize()){this.request();this.draw();}}
 fit(bounds){if(!bounds)return;this.view={...this.view,x:(bounds[0]+bounds[2])/2,z:(bounds[1]+bounds[3])/2,scale:Math.max((bounds[2]-bounds[0])/Math.max(100,this.width*.78),(bounds[3]-bounds[1])/Math.max(100,this.height*.78),.05),rotation:this.view.rotation};this.request();this.draw();this.notify();}
 focus(plan){this.fit(planBounds(plan));this.view.scale=Math.max(this.view.scale,.15);this.request();this.draw();}
 setPlanning(state,redraw=true){if(this.drag&&this.planning?.revision!==state.revision)this.cancelDrag();this.planning=state;if(redraw)this.draw();}
 setTerrain(info,redraw=true){
  const prior=this.info;
  this.info=info;
  if(prior?.revision===info.revision&&prior?.visibility_revision===info.visibility_revision)return;
  this.previousTerrain=prior?.revision===info.revision?prior:undefined;
  if(redraw){this.request();this.draw();}
 }
 setTool(tool){
  this.cancelDrag();
  this.tool=tool;
  this.sketch.setMode(planningModes.includes(tool)?tool:null);
  this.canvas.style.cursor=this.sketch.active?'crosshair':tool==='pan'?'grab':'default';
  this.draw();
 }
 position(e){const r=this.canvas.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top];}
 world(e){return screenToMap(this.position(e),this.view,this.width,this.height).map(Math.round);}
 target(e){
  const screen=this.position(e);
  if(screen[0]<0||screen[1]<0||screen[0]>this.width||screen[1]>this.height)return null;
  return planningPoint(...screenToMap(screen,this.view,this.width,this.height),{snap:this.events.snap?.(),blockY:this.view.slice_y??null});
 }
 setSlice(slice_y){
  this.userMoved=true;
  this.view={...this.view,slice_y};
  this.sketch.hover(null);
  this.request();
  this.draw();
  this.notify();
 }
 locate(point,focus=false){
  this.pin=point;
  if(focus&&point){
   this.userMoved=true;
   this.view={...this.view,x:point.x,z:point.z,scale:Math.min(this.view.scale,.55)};
   this.request();
   this.draw();
   this.notify();
  }else this.drawSketch();
 }
 drawSketch(){
  const ctx=this.sketchContext,w=this.width,h=this.height;
  const sketch=this.sketch.preview();
  this.sketchCanvas.hidden=!this.pin&&!this.sketch.cursor&&!sketch.points.length;
  this.events.sketchChanged?.();
  if(this.sketchCanvas.hidden)return;
  if(this.sketchCanvas.width!==this.canvas.width||this.sketchCanvas.height!==this.canvas.height){
   this.sketchCanvas.width=this.canvas.width;
   this.sketchCanvas.height=this.canvas.height;
  }
  ctx.setTransform(this.sketchCanvas.width/w,0,0,this.sketchCanvas.height/h,0,0);
  ctx.clearRect(0,0,w,h);
  const project=p=>mapToScreen([p.x,p.z],this.view,w,h);
  ctx.beginPath();
  sketch.points.forEach((point,i)=>i?ctx.lineTo(...project(point)):ctx.moveTo(...project(point)));
  if(sketch.closed){ctx.closePath();ctx.fillStyle='#69d8ff26';ctx.fill();}
  ctx.strokeStyle='#a8eaff';ctx.lineWidth=2;
  ctx.stroke();
  if(sketch.guide?.length){
   ctx.beginPath();ctx.moveTo(...project(sketch.guide[0]));ctx.lineTo(...project(sketch.guide[1]));
   ctx.setLineDash([4,4]);ctx.stroke();ctx.setLineDash([]);
  }
  for(const point of sketch.handles){
   ctx.beginPath();ctx.arc(...project(point),4.5,0,Math.PI*2);
   ctx.fillStyle='#bbf2ff';ctx.fill();ctx.strokeStyle='#225271';ctx.stroke();
  }
  if(this.pin)drawPlanningTarget(ctx,project(this.pin),this.pin,w,h,true);
  const cursor=this.sketch.cursor;
  if(cursor)drawPlanningTarget(ctx,project(cursor),cursor,w,h);
 }
 notify(){this.events.view?.({...this.view});clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>this.saveView()?.catch(error=>this.events.error?.(String(error))),450);}
 saveView(){
  if(!this.saveTimer)return;
  clearTimeout(this.saveTimer);
  this.saveTimer=undefined;
  return this.events.saveView?.({...this.view});
 }
 visibleKeys(){if(!this.info)return[];const corners=[[0,0],[this.width,0],[this.width,this.height],[0,this.height]].map(p=>screenToMap(p,this.view,this.width,this.height)),xs=corners.map(p=>p[0]),zs=corners.map(p=>p[1]),level=clamp(Math.floor(Math.log2(this.view.scale))+1,0,10),span=64*2**level,b=this.info.bounds;if(!b)return[];const list=[];
  const slice_y=this.view.slice_y??undefined;
  for(let z=Math.floor(Math.max(Math.min(...zs),b[1])/span);z<=Math.floor(Math.min(Math.max(...zs),b[3])/span);z++)for(let x=Math.floor(Math.max(Math.min(...xs),b[0])/span);x<=Math.floor(Math.min(Math.max(...xs),b[2])/span);x++){
   const base=[this.info.revision,slice_y??'surface',level,x,z].join(':');
   const tile=level+':'+x+','+z,visible=tileVisibility(this.info,tile);
   const projection=this.info.visibility_map_tiles?{visibility_key:visible}:{visibility_revision:visible};
   list.push({x,z,level,slice_y,world_revision:this.info.revision,projection,key:base+':'+visible,previous:base+':'+tileVisibility(this.previousTerrain,tile)});
  }
  return list.sort((a,b)=>Math.hypot((a.x+.5)*span-this.view.x,(a.z+.5)*span-this.view.z)-Math.hypot((b.x+.5)*span-this.view.x,(b.z+.5)*span-this.view.z)).slice(0,256);
 }
 request(){
  if(!this.active)return;
  const wanted=this.visibleKeys();
  this.wanted=new Set(wanted.map(t=>t.key));
  this.queue=wanted.filter(t=>!this.tiles.has(t.key)&&!this.pending.has(t.key));
  this.pump();
 }
 rememberTile(key,tile){
  this.tiles.delete(key);this.tiles.set(key,tile);
  if(this.tiles.size>256)for(const candidate of this.tiles.keys()){
   if(!this.wanted?.has(candidate)){this.tiles.delete(candidate);break;}
  }
 }
 loadTile(t){
  if(this.tiles.has(t.key))return Promise.resolve(this.tiles.get(t.key));
  if(!this.fetching.has(t.key)){
   const request=this.call('world_map_tile',{x:t.x,z:t.z,level:t.level,slice_y:t.slice_y,world_revision:t.world_revision,...t.projection})
    .then(data=>({data,image:this.image(data)})).finally(()=>this.fetching.delete(t.key));
   this.fetching.set(t.key,request);
  }
  return this.fetching.get(t.key);
 }
 pump(){
  if(!this.active)return;
  while(this.pending.size<2&&this.queue.length){
   const t=this.queue.shift();
   if(this.tiles.has(t.key))continue;
   this.pending.add(t.key);
   this.loadTile(t).then(tile=>{
    this.rememberTile(t.key,tile);
    if(this.active&&!this.capturing&&this.wanted.has(t.key))this.draw();
   }).catch(e=>{if(this.active&&this.wanted.has(t.key))this.events.error?.(String(e));}).finally(()=>{
    this.pending.delete(t.key);this.pump();
   });
  }
  const remaining=this.queue.length+[...this.pending].filter(key=>this.wanted.has(key)).length;
  this.events.progress?.(remaining);
  if(!remaining&&this.wanted.size&&this.autoFocus&&!this.userMoved&&!this.capturing){
   this.autoFocus=false;this.fitContent();
  }
 }
 fitContent(){const b=[Infinity,Infinity,-Infinity,-Infinity];let count=0;for(const tile of [...this.wanted].map(key=>this.tiles.get(key)).filter(Boolean))for(let i=0;i<tile.data.heights.length;i++)if(tile.data.heights[i]!==null){const x=tile.data.bounds[0]+i%64*tile.data.step,z=tile.data.bounds[1]+Math.floor(i/64)*tile.data.step;b[0]=Math.min(b[0],x);b[1]=Math.min(b[1],z);b[2]=Math.max(b[2],x+tile.data.step);b[3]=Math.max(b[3],z+tile.data.step);count++;}if(count){const padding=Math.max(80,(b[2]-b[0])*.12,(b[3]-b[1])*.12);this.fit([b[0]-padding,b[1]-padding,b[2]+padding,b[3]+padding]);}}
 image(tile){const canvas=document.createElement('canvas');canvas.width=canvas.height=tile.size;const data=new Uint8ClampedArray(tile.size*tile.size*4);for(let i=0;i<tile.colors.length;i++){const color=tile.colors[i],known=tile.availability?.[i]??(tile.heights[i]===null?0:2);if(!known)continue;const y=tile.heights[i],left=tile.heights[i%tile.size?i-1:i],up=tile.heights[i>=tile.size?i-tile.size:i],shade=y===null?1:clamp(1+(y-(left??y))*.018+(y-(up??y))*.018,.55,1.3);data[i*4]=known===1?24:Math.min(255,(color>>16&255)*shade);data[i*4+1]=known===1?32:Math.min(255,(color>>8&255)*shade);data[i*4+2]=known===1?42:Math.min(255,(color&255)*shade);data[i*4+3]=255;}canvas.getContext('2d').putImageData(new ImageData(data,tile.size,tile.size),0,0);return canvas;}
 draw(capture=false){const c=this.ctx,w=this.width,h=this.height;if(!this.active||!w||!h)return;c.save();c.setTransform(this.canvas.width/w,0,0,this.canvas.height/h,0,0);c.clearRect(0,0,w,h);const theme=capture?null:this.appearance;c.fillStyle=theme?.background??'#1a2532';c.fillRect(0,0,w,h);
  c.strokeStyle='#263342';c.lineWidth=1;for(let x=-h;x<w+h;x+=22){c.beginPath();c.moveTo(x,0);c.lineTo(x+h,h);c.stroke();}
  c.save();c.translate(w/2,h/2);c.rotate(this.view.rotation*Math.PI/180);c.scale(1/this.view.scale,1/this.view.scale);c.translate(-this.view.x,-this.view.z);c.imageSmoothingEnabled=false;
  for(const t of this.visibleKeys()){const tile=this.tiles.get(t.key)??(!capture?this.tiles.get(t.previous):null);if(tile){const b=tile.data.bounds;c.drawImage(tile.image,b[0],b[1],b[2]-b[0],b[3]-b[1]);}}
  c.restore();
  for(const p of this.planning?.objects??[]){const layer=this.planning.layers.find(l=>l.id===p.layer_id);if(p.visible===false||layer?.visible===false)continue;const points=p.points.map(point=>mapToScreen(point,this.view,w,h)),selected=p.id===this.planning.selected_id;
   c.beginPath();points.forEach((point,i)=>i?c.lineTo(...point):c.moveTo(...point));if(p.type==='area')c.closePath();c.strokeStyle=selected?'#e6f2ff':p.color;c.lineWidth=p.type==='route'?Math.max(2,p.width/this.view.scale):selected?2.5:1.5;if(p.type==='area'){c.fillStyle=p.color+'30';c.fill();}if(p.type==='marker'){c.fillStyle=p.color;c.arc(points[0][0],points[0][1],6,0,Math.PI*2);c.fill();}c.stroke();
   if(selected&&!capture&&this.tool==='select'){c.fillStyle='#e6f2ff';c.strokeStyle='#4d8bd4';c.lineWidth=1.5;for(const [x,y]of points){c.fillRect(x-4,y-4,8,8);c.strokeRect(x-4,y-4,8,8);}}
   const b=planBounds(p),label=mapToScreen([(b[0]+b[2])/2,(b[1]+b[3])/2],this.view,w,h);c.font=(theme?.font??12)+'px Segoe UI,Microsoft YaHei';c.textAlign='center';c.lineWidth=4;c.strokeStyle=theme?.outline??'#111a24';c.strokeText(p.name,label[0],label[1]-10);c.fillStyle=(selected?theme?.text:theme?.muted)??(selected?'#e7f2ff':'#b9cce3');c.fillText(p.name,label[0],label[1]-10);
  }
  // Leave room for the fullscreen button in the interactive viewport.
  const compassInset=capture?38:66;
  c.save();c.translate(w-compassInset,40);c.rotate(this.view.rotation*Math.PI/180);c.fillStyle='#8fbfff';c.beginPath();c.moveTo(0,-15);c.lineTo(-5,7);c.lineTo(5,7);c.closePath();c.fill();c.rotate(-this.view.rotation*Math.PI/180);c.font=(theme?.font??12)+'px Segoe UI';c.textAlign='center';c.fillText('N',0,-22);c.restore();
  const length=2**Math.floor(Math.log2(this.view.scale*90)),pixels=length/this.view.scale;c.strokeStyle='#c1d2e7';c.lineWidth=2;c.beginPath();c.moveTo(18,h-22);c.lineTo(18+pixels,h-22);c.stroke();c.fillStyle=theme?.muted??'#a0b4cc';c.font=(theme?Math.round(theme.font*.92):11)+'px Segoe UI';c.textAlign='left';c.fillText(length>=1000?(length/1000).toFixed(1)+' km':length+' m',18,h-30);c.restore();
  if(!capture&&!this.capturing)this.drawSketch();
 }
 pick(point){const plans=[...(this.planning?.objects??[])].reverse();for(const p of plans){if(p.visible===false||this.planning.layers.find(l=>l.id===p.layer_id)?.visible===false)continue;if(p.type==='area'&&pointInPolygon(point,p.points))return p;if(p.type==='marker'&&Math.hypot(point[0]-p.points[0][0],point[1]-p.points[0][1])<10*this.view.scale)return p;if(p.type==='route')for(let i=1;i<p.points.length;i++){const a=p.points[i-1],b=p.points[i],dx=b[0]-a[0],dz=b[1]-a[1],t=clamp(((point[0]-a[0])*dx+(point[1]-a[1])*dz)/(dx*dx+dz*dz||1),0,1);if(Math.hypot(point[0]-a[0]-t*dx,point[1]-a[1]-t*dz)<Math.max(p.width/2,6*this.view.scale))return p;}}return null;}
 down(e){if(this.capturing)return;this.userMoved=true;this.canvas.setPointerCapture(e.pointerId);const point=this.world(e),screen=this.position(e);
  if(e.button===2||e.button===1||this.tool==='pan'){
   this.drag={type:e.button===2?'rotate':'pan',screen,view:{...this.view}};
   this.sketch.hover(null);this.drawSketch();return;
  }
  if(e.button!==0)return;
  if(this.sketch.active){
   const handle=nearestHandle(screen,this.sketch.handles,p=>mapToScreen([p.x,p.z],this.view,this.width,this.height));
   if(this.sketch.start(this.target(e),screen,handle))this.drag={type:'sketch',pointer:e.pointerId};
   this.drawSketch();
   return;
  }
  const selected=this.planning.objects.find(p=>p.id===this.planning.selected_id);if(selected){const index=selected.points.findIndex(p=>{const s=mapToScreen(p,this.view,this.width,this.height);return Math.hypot(s[0]-screen[0],s[1]-screen[1])<9;});if(index>=0){this.drag={type:'vertex',id:selected.id,index,original:structuredClone(selected.points),start:point};return;}}
  const picked=this.pick(point);if(picked){this.planning.selected_id=picked.id;this.drag={type:'object',id:picked.id,original:structuredClone(picked.points),start:point};this.draw();}else{this.events.select?.(null);this.drag={type:'pan',screen,view:{...this.view}};}
 }
 move(e){if(this.capturing)return;const world=this.world(e);this.events.hover?.(world);const p=this.position(e),d=this.drag;
  if(this.sketch.active&&(!d||d.type==='sketch')){
   this.sketch.hover(this.target(e));this.drawSketch();return;
  }
  if(!d)return;
  if(d.type==='vertex'||d.type==='object'){const object=this.planning.objects.find(p=>p.id===d.id);if(d.type==='vertex'){object.points=structuredClone(d.original);object.points[d.index]=world;}else object.points=d.original.map(p=>[p[0]+world[0]-d.start[0],p[1]+world[1]-d.start[1]]);d.moved=true;this.draw();return;}
  if(d.type==='rotate')this.view.rotation=(d.view.rotation+(p[0]-d.screen[0])*.4+360)%360;
  else if(d.type==='pan'){const before=screenToMap(d.screen,d.view,this.width,this.height),after=screenToMap(p,d.view,this.width,this.height);this.view.x=d.view.x+before[0]-after[0];this.view.z=d.view.z+before[1]-after[1];}
  this.request();this.draw();this.notify();
 }
 up(e){
  const d=this.drag;
  if(!d||d.type==='sketch'&&d.pointer!==e.pointerId)return;
  this.drag=null;
  if(d.type==='sketch'){
   this.sketch.finish(this.target(e),this.position(e));
   this.drawSketch();
   return;
  }
  if(d.type==='vertex'||d.type==='object'){
   if(d.moved)this.events.update?.({plan_id:d.id,points:this.planning.objects.find(p=>p.id===d.id).points});
   else this.events.select?.(d.id);
  }
  if(this.sketch.active)this.sketch.hover(this.target(e));
  this.draw();this.notify();
 }
 cancelDrag(){const d=this.drag;if(!d)return;if(d.original){const object=this.planning?.objects.find(p=>p.id===d.id);if(object)object.points=structuredClone(d.original);}if(d.type==='sketch')this.sketch.cancelDrag();this.drag=null;this.draw();}
 double(e){if(!this.sketch.active)this.events.detail?.(this.world(e));}
 wheel(e){if(this.capturing)return;this.userMoved=true;e.preventDefault();const p=this.position(e),before=screenToMap(p,this.view,this.width,this.height);if(e.altKey)this.view.rotation=(this.view.rotation+wheelSteps(e)*4*readWheelSensitivity()/100+360)%360;else this.view.scale=clamp(this.view.scale*wheelZoomFactor(e),.025,2048);const after=screenToMap(p,this.view,this.width,this.height);this.view.x+=before[0]-after[0];this.view.z+=before[1]-after[1];if(this.sketch.active)this.sketch.hover(this.target(e));this.request();this.draw();this.notify();}
 async settle(){this.request();const end=Date.now()+90000;while(this.visibleKeys().some(t=>!this.tiles.has(t.key))&&Date.now()<end)await new Promise(r=>setTimeout(r,80));if(this.visibleKeys().some(t=>!this.tiles.has(t.key)))throw Error('地形图块尚未读取完整，请刷新后重试截图');}
 async capture(request,info,planning){
  const canvas=document.createElement('canvas');
  const target=new MapViewport(canvas,this.call,{},true);
  target.capturing=true;
  target.info=info;target.planning=planning;target.view={...request.view};
  target.width=target.canvas.width=request.width;
  target.height=target.canvas.height=request.height;
  if(info.revision===this.info?.revision){
   target.tiles=new Map(this.tiles);
   target.loadTile=async t=>{
    const tile=await this.loadTile(t);
    this.rememberTile(t.key,tile);
    return tile;
   };
  }
  await target.settle();
  target.draw(true);
  const {width,height,view}=target,corners=[[0,0],[width,0],[width,height],[0,height]].map(p=>screenToMap(p,view,width,height));
  return {images:[{name:'map',data_url:canvas.toDataURL('image/png'),camera:{...view,width,height,world_corners:corners}}],
   view,planning_revision:planning.revision,world_revision:info.revision,
   tile_revisions:target.visibleKeys().filter(t=>target.tiles.has(t.key)).map(t=>({x:t.x,z:t.z,level:t.level,revision:target.tiles.get(t.key).data.revision})),
   bounds:[Math.min(...corners.map(p=>p[0])),Math.min(...corners.map(p=>p[1])),Math.max(...corners.map(p=>p[0])),Math.max(...corners.map(p=>p[1]))],
   source:view.slice_y==null?'saved_world_surface_and_planning':'saved_world_slice_and_planning',created_at:new Date().toISOString(),minecraft_client_screenshot:false};
 }
}
