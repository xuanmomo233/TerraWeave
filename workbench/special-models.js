import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
function cuboid(size,center,uvSize,offset=[0,0],textureSize=[64,64]){
 const g=new THREE.BoxGeometry(...size),uv=g.getAttribute('uv'),[w,h,d]=uvSize,[u,v]=offset,rects=[[u+d+w,v+d,d,h],[u,v+d,d,h],[u+d,v,w,d],[u+d+w,v,w,d],[u+d+w+d,v+d,w,h],[u+d,v+d,w,h]];
 for(let face=0;face<6;face++)for(let n=0;n<4;n++){const i=face*4+n,[x,y,width,height]=rects[face];uv.setXY(i,(x+uv.getX(i)*width)/textureSize[0],1-(y+(1-uv.getY(i))*height)/textureSize[1]);}g.translate(...center);return g;
}
function orient(g,facing){g.translate(-.5,0,-.5);g.rotateY(({north:0,east:-1,south:2,west:1}[facing]??0)*Math.PI/2);g.translate(.5,0,.5);return g;}
const signMaterials=new Map();
function signInk(side,hanging){
 if(!side?.lines.some(Boolean))return null;
 const key=JSON.stringify([side,hanging]);
 if(signMaterials.has(key))return signMaterials.get(key);
 const canvas=document.createElement('canvas');
 canvas.width=128;canvas.height=hanging?72:64;
 const ctx=canvas.getContext('2d');
 ctx.textAlign='center';ctx.textBaseline='middle';
 ctx.font=(hanging?16:14)+'px "Microsoft YaHei", monospace';
 ctx.fillStyle='#'+side.color.toString(16).padStart(6,'0');
 for(const [row,text] of side.lines.entries()){
  const y=(row+.5)*canvas.height/4;
  if(side.glowing){
   ctx.strokeStyle=side.color===0x1d1d21?'#bdb8a6':'#252121';
   ctx.lineWidth=2;
   ctx.strokeText(text,64,y,124);
  }
  ctx.fillText(text,64,y,124);
 }
 const map=new THREE.CanvasTexture(canvas);
 map.colorSpace=THREE.SRGBColorSpace;
 map.magFilter=THREE.NearestFilter;map.minFilter=THREE.NearestFilter;
 const Ink=side.glowing?THREE.MeshBasicMaterial:THREE.MeshLambertMaterial;
 const ink=new Ink({map,alphaTest:.35});
 signMaterials.set(key,ink);
 return ink;
}
function signModel(id,props,makeMaterial,appearance){
 const [,wood,wall,hanging]=/^([a-z_]+?)(_wall)?(_hanging)?_sign$/.exec(id);
 const width=hanging?.875:1,height=hanging?.625:.5,depth=hanging?.125:.094;
 const z=wall?.11:.5,y=hanging?.438:.69;
 const yaw=props.facing?({north:Math.PI,south:0,east:Math.PI/2,west:-Math.PI/2}[props.facing]??0):
  -(Number(props.rotation)||0)*Math.PI/8;
 const place=geometry=>geometry.translate(-.5,0,-.5).rotateY(yaw).translate(.5,0,.5);
 const body=[new THREE.BoxGeometry(width,height,depth).translate(.5,y,z)];
 if(!wall&&!hanging)body.push(new THREE.BoxGeometry(.075,.55,.075).translate(.5,.275,.5));
 if(hanging)for(const x of [.25,.75])body.push(new THREE.BoxGeometry(.04,.28,.04).translate(x,.86,z));
 const result=[{geometry:place(mergeGeometries(body)),material:makeMaterial('block/'+wood+'_planks',id,false)}];
 for(const [name,dir] of [['front',1],['back',-1]]){
  const ink=signInk(appearance?.[name],hanging);
  if(!ink)continue;
  const geometry=new THREE.PlaneGeometry(width*.90,height*.88).rotateY(dir<0?Math.PI:0);
  result.push({geometry:place(geometry.translate(.5,y,z+dir*(depth/2+.001))),material:ink});
 }
 return result;
}
export function specialModel(id,props,makeMaterial,appearance){
 if(/_sign$/.test(id))return signModel(id,props,makeMaterial,appearance);
 if(id==='conduit'){
  const size=6/16;
  return [{geometry:new THREE.BoxGeometry(size,size,size).translate(.5,.5,.5),material:makeMaterial('block/conduit',id,false)}];
 }
 if(['chest','trapped_chest','ender_chest'].includes(id)){
  const texture=id==='ender_chest'?'ender':id==='trapped_chest'?'trapped':'normal',type=props.type??'single',suffix=type==='single'?'':'_'+type;
  const boxes=[cuboid([14/16,10/16,14/16],[.5,5/16,.5],[14,10,14],[0,19]),cuboid([14/16,5/16,14/16],[.5,11.5/16,.5],[14,5,14]),cuboid([2/16,4/16,1/16],[.5,9/16,.5/16],[2,4,1])];return [{geometry:orient(mergeGeometries(boxes),props.facing),material:makeMaterial('entity/chest/'+texture+suffix,id,false)}];
 }
 if(id==='shulker_box'||id.endsWith('_shulker_box')){
  const color=id.replace(/_?shulker_box$/,''),facing={down:[0,-1,0],north:[0,0,-1],south:[0,0,1],east:[1,0,0],west:[-1,0,0]}[props.facing]??[0,1,0];
  const rotation=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),new THREE.Vector3(...facing));
  const boxes=[cuboid([1,.5,1],[.5,.25,.5],[16,8,16],[0,28]),cuboid([1,.75,1],[.5,.625,.5],[16,12,16])];
  const geometry=mergeGeometries(boxes).translate(-.5,-.5,-.5).applyQuaternion(rotation).translate(.5,.5,.5);
  return [{geometry,material:makeMaterial('entity/shulker/shulker'+(color?'_'+color:''),id,false)}];
 }
 if(/_banner$/.test(id)){
  const wall=id.endsWith('_wall_banner'),z=wall?.1:.56,y=wall?.1:1.03;
  const yaw=wall?({north:Math.PI,south:0,east:Math.PI/2,west:-Math.PI/2}[props.facing]??0):
   -(Number(props.rotation)||0)*Math.PI/8;
  const place=g=>g.translate(-.5,0,-.5).rotateY(yaw).translate(.5,0,.5);
  const body=depth=>place(cuboid([20/24,40/24,depth],[.5,y,z],[20,40,1]));
  const frame=[new THREE.BoxGeometry(22/24,2/24,2/24).translate(.5,y+.84,z)];
  if(!wall)frame.push(new THREE.BoxGeometry(2/24,1.93,2/24).translate(.5,.965,.5));
  const parts=[{geometry:body(1/24),material:makeMaterial('entity/banner_base',id,true)},
   {geometry:place(mergeGeometries(frame)),material:makeMaterial('block/oak_planks',id,false)}];
  for(const [index,pattern] of (appearance?.patterns??[]).entries()){
   parts.push({geometry:body(1/24+(index+1)*.0008),
    material:makeMaterial('entity/banner/'+pattern.name,id,pattern.color)});
  }
  return parts;
 }
 return null;
}
