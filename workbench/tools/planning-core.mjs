export function pointInPolygon(point,points){let inside=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[i],b=points[j];if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;}
export function planBounds(plan){const xs=plan.points.map(p=>p[0]),zs=plan.points.map(p=>p[1]);return [Math.min(...xs),Math.min(...zs),Math.max(...xs),Math.max(...zs)];}
export function planningHeight(min,max){
 if(min==null&&max==null)return {min_y:null,max_y:null};
 const min_y=min??max,max_y=max??min;
 if(![min_y,max_y].every(y=>Number.isInteger(y)&&y>=-64&&y<=319)||min_y>max_y)throw Error('规划高度须在 Y -64 至 319 内，最低 Y 要小于或等于最高 Y');
 return {min_y,max_y};
}
export function planningFocusY(plan){
 const min=plan?.min_y??plan?.max_y;
 return min==null?undefined:Math.floor((min+(plan.max_y??min))/2);
}
export function validatePlan(plan){
 if(!['area','route','marker'].includes(plan.type))throw Error('Unknown planning object type');
 if(typeof plan.name!=='string'||!plan.name.trim()||plan.name.length>120)throw Error('Planning name must contain 1..120 characters');
 if(typeof plan.notes!=='string'||plan.notes.length>20000)throw Error('Invalid planning notes');
 if(!Array.isArray(plan.points)||plan.points.length>4096||plan.points.some(p=>!Array.isArray(p)||p.length!==2||!p.every(n=>Number.isFinite(n)&&Math.abs(n)<=30000000)))throw Error('Invalid world map coordinates');
 if(plan.type==='area'&&plan.points.length<3||plan.type==='route'&&plan.points.length<2||plan.type==='marker'&&plan.points.length!==1)throw Error('Not enough planning points');
 if(!/^#[0-9a-f]{6}$/i.test(plan.color)||!Number.isFinite(plan.width)||plan.width<.5||plan.width>512)throw Error('Invalid planning appearance');
 return plan;
}
export function mapToScreen(point,view,width,height){const x=(point[0]-view.x)/view.scale,z=(point[1]-view.z)/view.scale,r=view.rotation*Math.PI/180;return [width/2+x*Math.cos(r)-z*Math.sin(r),height/2+x*Math.sin(r)+z*Math.cos(r)];}
export function screenToMap(point,view,width,height){const x=(point[0]-width/2)*view.scale,z=(point[1]-height/2)*view.scale,r=-view.rotation*Math.PI/180;return [view.x+x*Math.cos(r)-z*Math.sin(r),view.z+x*Math.sin(r)+z*Math.cos(r)];}
