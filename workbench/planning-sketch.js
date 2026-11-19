const types={area:'area',polygon:'area',route:'route',marker:'marker'};
export const planningModes=Object.keys(types);
const same=(a,b)=>a&&b&&a.x===b.x&&a.z===b.z;
const round=n=>Math.round(n*100)/100;

export function planningPoint(x,z,{height=null,blockY=null,snap=true}={}){
 if(![x,z].every(n=>Number.isFinite(n)&&Math.abs(n)<=30000000))return null;
 const align=snap?Math.round:round;
 return {x:align(x),z:align(z),height,blockY};
}

export function pointLabel(point){
 return 'X '+point.x+(point.blockY===null?'':'  Y '+point.blockY)+'  Z '+point.z;
}

export class PlanningSketch{
 constructor(){this.mode=null;this.points=[];this.cursor=null;this.drag=null;this.past=[];this.future=[];this.saving=false;}
 setMode(mode){
  if(this.saving||this.mode===mode)return;
  this.mode=mode;
  this.reset();
 }
 reset(){
  this.points=[];this.cursor=null;this.drag=null;this.past=[];this.future=[];
 }
 get active(){return !!this.mode;}
 get editing(){return !!this.drag;}
 get hasWork(){return this.points.length>0||this.editing;}
 remember(points){
  if(this.points.length===points.length&&this.points.every((p,i)=>same(p,points[i])&&p.blockY===points[i].blockY))return;
  this.past.push(this.points);
  if(this.past.length>64)this.past.shift();
  this.points=points;
  this.future=[];
 }
 undo(redo=false){
  if(this.saving||this.editing)return true;
  const [from,to]=redo?[this.future,this.past]:[this.past,this.future];
  if(!from.length)return false;
  to.push(this.points);
  this.points=from.pop();
  return true;
 }
 hover(point){this.cursor=point;}
 start(point,screen,handle){
  if(this.saving)return false;
  this.cursor=point;
  if(handle!==null){
   this.drag={handle,start:screen,point:null};
   return true;
  }
  if(!point)return false;
  if(this.mode==='area'){
   if(this.points.length===2)return false;
   this.drag={handle:null,start:screen,point};
   return true;
  }
  if(this.mode==='marker')this.remember([point]);
  else if(this.points.length<4096&&!this.points.some(p=>same(p,point)))this.remember([...this.points,point]);
  return false;
 }
 finish(point,screen){
  const drag=this.drag;
  if(!drag)return;
  this.drag=null;
  this.cursor=point;
  if(!point)return;
  if(drag.handle!==null){this.remember(this.moved(drag.handle,point));return;}
  if(this.points.length===1){
   if(!same(this.points[0],point))this.remember([this.points[0],point]);
  }else if(Math.hypot(screen[0]-drag.start[0],screen[1]-drag.start[1])>=4&&!same(drag.point,point)){
   this.remember([drag.point,point]);
  }else this.remember([drag.point]);
 }
 cancelDrag(){this.drag=null;this.cursor=null;}
 moved(index,point){
  if(this.mode!=='area')return this.points.map((value,i)=>i===index?point:value);
  const [a,b]=this.points;
  if(!b||index===0)return [point,...this.points.slice(1)];
  if(index===2)return [a,point];
  const [low,high]=index===1?[a,b]:[b,a];
  const next=[{...low,z:point.z},{...high,x:point.x,height:point.height,blockY:point.blockY}];
  return index===1?next:next.reverse();
 }
 corners(points){
  if(this.mode!=='area'||points.length!==2)return points;
  const [a,b]=points;
  const height=a.height===null?b.height:b.height===null?a.height:Math.max(a.height,b.height);
  return [{...a,height},{...b,z:a.z,height},{...b,height},{...a,z:b.z,height}];
 }
 preview(){
  const previewCursor=this.cursor;
  let anchors=this.points;
  if(this.drag&&this.drag.handle!==null&&previewCursor)anchors=this.moved(this.drag.handle,previewCursor);
  if(this.mode==='area'){
   const first=anchors[0]??this.drag?.point;
   if(first&&anchors.length<2)anchors=previewCursor?[first,previewCursor]:[first];
   return {points:this.corners(anchors),handles:this.points.length===2?this.corners(anchors):this.points,
    closed:anchors.length===2};
  }
  const extending=previewCursor&&!this.drag&&this.mode!=='marker'&&anchors.length&&!same(anchors.at(-1),previewCursor);
  const guide=extending?[anchors.at(-1),previewCursor]:[];
  return {points:anchors,handles:anchors,closed:this.mode==='polygon'&&anchors.length>2,guide};
 }
 get handles(){return this.mode==='area'?(this.points.length===2?this.corners(this.points):[]):this.points;}
 geometry(){
  if(!this.active||this.editing)return null;
  if(this.mode==='area'&&this.points.length!==2)return null;
  const vertices=this.corners(this.points).map(p=>[p.x,p.z]);
  if(vertices.length<(this.mode==='marker'?1:this.mode==='route'?2:3))return null;
  if(types[this.mode]==='area'){
   const [x,z]=vertices[0];
   const area=vertices.reduce((sum,[a,b],i)=>{
    const [c,d]=vertices[(i+1)%vertices.length];
    return sum+(a-x)*(d-z)-(b-z)*(c-x);
   },0);
   if(Math.abs(area)<.001)return null;
  }
  const heights=this.points.map(p=>p.blockY).filter(y=>y!==null);
  return {type:types[this.mode],points:vertices,...(heights.length?{min_y:Math.min(...heights),max_y:Math.max(...heights)}:{})};
 }
}

export function drawPlanningTarget(ctx,[x,y],point,width,height,pinned=false){
 if(x<0||x>width||y<0||y>height)return;
 const color=pinned?'#ffcc73':'#91edff';
 const label=(pinned?'定位  ':'')+pointLabel(point);
 ctx.save();
 ctx.beginPath();
 ctx.moveTo(x-11,y);ctx.lineTo(x+11,y);
 ctx.moveTo(x,y-11);ctx.lineTo(x,y+11);
 ctx.moveTo(x+5,y);
 ctx.arc(x,y,5,0,Math.PI*2);
 ctx.strokeStyle='#17212e';ctx.lineWidth=4;ctx.stroke();
 ctx.strokeStyle=color;ctx.lineWidth=1.7;ctx.stroke();
 ctx.font='12px Segoe UI, Microsoft YaHei, sans-serif';
 ctx.textAlign='left';ctx.textBaseline='middle';
 const boxWidth=ctx.measureText(label).width+14;
 const left=Math.max(4,Math.min(width-boxWidth-4,x+14));
 const top=Math.max(4,Math.min(height-25,y+13));
 ctx.fillStyle='#122032f5';ctx.fillRect(left,top,boxWidth,22);
 ctx.fillStyle=color;ctx.fillText(label,left+7,top+11);
 ctx.restore();
}

export function nearestHandle(point,handles,project){
 let best=9,index=null;
 for(const [i,handle] of handles.entries()){
  const screen=project(handle);
  if(!screen)continue;
  const distance=Math.hypot(point[0]-screen[0],point[1]-screen[1]);
  if(distance<best){best=distance;index=i;}
 }
 return index;
}
