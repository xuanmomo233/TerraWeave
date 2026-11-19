import {Matrix4,Vector4} from 'three';
import {drawPlanningTarget,nearestHandle} from './planning-sketch.js';

const coordinates=p=>[p.x,p.height,p.z];
const visiblePoint=p=>p.z>=-p.w&&p.z<=p.w;

function projection(camera,origin,width,height){
 camera.updateMatrixWorld();
 const matrix=new Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
 return {
  clip:([x,y,z])=>new Vector4(x-origin[0],y-origin[1],z-origin[2],1).applyMatrix4(matrix),
  screen:p=>[(p.x/p.w+1)*width/2,(1-p.y/p.w)*height/2]
 };
}

function drawSegment(ctx,a,b,width,height){
 const nearA=a.z+a.w,nearB=b.z+b.w;
 if(nearA<0&&nearB<0)return;
 if(nearA<0)a=a.clone().lerp(b,nearA/(nearA-nearB));
 else if(nearB<0)b=b.clone().lerp(a,nearB/(nearB-nearA));
 ctx.moveTo((a.x/a.w+1)*width/2,(1-a.y/a.w)*height/2);
 ctx.lineTo((b.x/b.w+1)*width/2,(1-b.y/b.w)*height/2);
}

export class PlanningOverlay{
 constructor(host){
  this.canvas=document.createElement('canvas');
  this.canvas.id='planning-preview';
  this.canvas.setAttribute('aria-hidden','true');
  this.canvas.hidden=true;
  host.append(this.canvas);
  this.ctx=this.canvas.getContext('2d');
  this.paths=[];
 }
 update(state,enabled,height,terrainKey){
  const key=enabled&&state?[state.revision,state.selected_id,terrainKey].join(':'):'';
  if(this.key===key)return false;
  this.key=key;
  this.paths=key?state.objects.filter(plan=>plan.visible!==false&&
   state.layers.find(layer=>layer.id===plan.layer_id)?.visible!==false).map(plan=>({
    points:plan.points.map(([x,z])=>[x,(plan.min_y??height(x,z))+1.05,z]),
    closed:plan.type==='area',
    color:plan.id===state.selected_id?'#d1efff':plan.color,
    selected:plan.id===state.selected_id
   })):[];
  return true;
 }
 handleAt(screen,handles,camera,origin){
  if(!handles.length)return null;
  const view=projection(camera,origin,this.canvas.parentElement.clientWidth,this.canvas.parentElement.clientHeight);
  return nearestHandle(screen,handles,p=>{
   const clip=view.clip(coordinates(p));
   return visiblePoint(clip)?view.screen(clip):null;
  });
 }
 paint(ctx,width,height,camera,origin,sketch,cursor,pin){
  const view=projection(camera,origin,width,height);
  const paths=sketch?.points.length?[...this.paths,{points:sketch.points.map(coordinates),
   handles:sketch.handles.map(coordinates),closed:sketch.closed,color:'#a8eaff',draft:true}]:this.paths;
  for(const path of paths){
   const points=path.points.map(view.clip);
   ctx.save();
   ctx.strokeStyle=path.color;
   ctx.fillStyle=path.color;
   ctx.lineWidth=path.selected?2.5:1.5;
   ctx.shadowColor='#101722';
   ctx.shadowBlur=3;
   if(path.draft&&path.closed&&points.every(visiblePoint)){
    ctx.beginPath();
    points.forEach((p,i)=>i?ctx.lineTo(...view.screen(p)):ctx.moveTo(...view.screen(p)));
    ctx.closePath();
    ctx.fillStyle='#69d8ff26';
    ctx.fill();
    ctx.fillStyle=path.color;
   }
   ctx.beginPath();
   for(let i=1;i<points.length;i++)drawSegment(ctx,points[i-1],points[i],width,height);
   if(path.closed)drawSegment(ctx,points.at(-1),points[0],width,height);
   ctx.stroke();
   const handles=path.draft?path.handles.map(view.clip):path.selected||points.length===1?points:[];
   for(const p of handles){
    if(!visiblePoint(p))continue;
    ctx.beginPath();
    ctx.arc(...view.screen(p),path.draft?4.5:3,0,Math.PI*2);
    ctx.fill();
   }
   ctx.restore();
  }
  if(sketch?.guide?.length){
   ctx.save();ctx.strokeStyle='#a8eaff';ctx.lineWidth=2;ctx.setLineDash([4,4]);ctx.beginPath();
   const [a,b]=sketch.guide.map(p=>view.clip(coordinates(p)));
   drawSegment(ctx,a,b,width,height);ctx.stroke();ctx.restore();
  }
  for(const [point,pinned] of [[pin,true],[cursor,false]])if(point){
   const p=view.clip(coordinates(point));
   if(visiblePoint(p))drawPlanningTarget(ctx,view.screen(p),point,width,height,pinned);
  }
 }
 draw(camera,origin,sketch,cursor,pin){
  this.canvas.hidden=!camera||!origin||!this.paths.length&&!sketch?.points.length&&!cursor&&!pin;
  if(this.canvas.hidden)return;
  const {clientWidth:width,clientHeight:height}=this.canvas.parentElement;
  const ratio=Math.min(devicePixelRatio,2);
  const bufferWidth=Math.max(1,Math.round(width*ratio)),bufferHeight=Math.max(1,Math.round(height*ratio));
  if(this.canvas.width!==bufferWidth||this.canvas.height!==bufferHeight){
   this.canvas.width=bufferWidth;
   this.canvas.height=bufferHeight;
  }
  this.ctx.setTransform(ratio,0,0,ratio,0,0);
  this.ctx.clearRect(0,0,width,height);
  this.paint(this.ctx,width,height,camera,origin,sketch,cursor,pin);
 }
 capture(frame,camera,origin){
  if(!this.paths.length)return frame;
  const canvas=document.createElement('canvas');
  canvas.width=frame.width;
  canvas.height=frame.height;
  const ctx=canvas.getContext('2d');
  ctx.drawImage(frame,0,0);
  this.paint(ctx,canvas.width,canvas.height,camera,origin,null);
  return canvas;
 }
}
