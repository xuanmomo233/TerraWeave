import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
function cuboid(size,center,uvSize,offset=[0,0],textureSize=[64,64]){
 const g=new THREE.BoxGeometry(...size),uv=g.getAttribute('uv'),[w,h,d]=uvSize,[u,v]=offset,rects=[[u+d+w,v+d,d,h],[u,v+d,d,h],[u+d,v,w,d],[u+d+w,v,w,d],[u+d+w+d,v+d,w,h],[u+d,v+d,w,h]];
 for(let face=0;face<6;face++)for(let n=0;n<4;n++){const i=face*4+n,[x,y,width,height]=rects[face];uv.setXY(i,(x+uv.getX(i)*width)/textureSize[0],1-(y+(1-uv.getY(i))*height)/textureSize[1]);}g.translate(...center);return g;
}
function orient(g,facing){g.translate(-.5,0,-.5);g.rotateY(({north:0,east:-1,south:2,west:1}[facing]??0)*Math.PI/2);g.translate(.5,0,.5);return g;}
export function specialModel(id,props,makeMaterial){
 if(id==='conduit'){
  const size=6/16;
  return [{geometry:new THREE.BoxGeometry(size,size,size).translate(.5,.5,.5),material:makeMaterial('block/conduit',id,false)}];
 }
 if(['chest','trapped_chest','ender_chest'].includes(id)){
  const texture=id==='ender_chest'?'ender':id==='trapped_chest'?'trapped':'normal',type=props.type??'single',suffix=type==='single'?'':'_'+type;
  const boxes=[cuboid([14/16,10/16,14/16],[.5,5/16,.5],[14,10,14],[0,19]),cuboid([14/16,5/16,14/16],[.5,11.5/16,.5],[14,5,14]),cuboid([2/16,4/16,1/16],[.5,9/16,.5/16],[2,4,1])];return [{geometry:orient(mergeGeometries(boxes),props.facing),material:makeMaterial('entity/chest/'+texture+suffix,id,false)}];
 }
 if(/_banner$/.test(id)){
  const cloth=orient(cuboid([20/24,40/24,1/24],[.5,-1/12,.9],[20,40,1]),props.facing),rod=orient(new THREE.BoxGeometry(22/24,2/24,2/24).translate(.5,.8,.9),props.facing);
  return [{geometry:cloth,material:makeMaterial('entity/banner_base',id,true)},{geometry:rod,material:makeMaterial('block/oak_planks',id,false)}];
 }
 return null;
}
