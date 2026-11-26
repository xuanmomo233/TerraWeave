import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {baselineMinecraft,javaReleases} from './minecraft-version.js';
import {copperStatueModel} from './copper-statues.js';
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

export function signFaceText(id,appearance,element,face,board){
 const side=face==='south'?'front':face==='north'?'back':null;
 if(!side||element.to[0]-element.from[0]<14||element.to[1]-element.from[1]<8||
    element.to[2]-element.from[2]>2)return null;
 const material=signInk(appearance[side],id.endsWith('_hanging_sign'));
 if(!material)return null;
 const geometry=board.clone(),positions=geometry.getAttribute('position'),normal=geometry.getAttribute('normal');
 const points=[0,1,2,3].map(i=>new THREE.Vector3().fromBufferAttribute(positions,i));
 const center=points[0].clone().add(points[2]).multiplyScalar(.5);
 const right=points[1].clone().sub(points[0]).normalize();
 const up=points[3].clone().sub(points[0]).normalize();
 const offset=new THREE.Vector3().fromBufferAttribute(normal,0).multiplyScalar(.001);
 for(const [i,vertex] of points.entries()){
  vertex.sub(center);
  const p=center.clone().addScaledVector(right,vertex.dot(right)*.9)
   .addScaledVector(up,vertex.dot(up)*.88).add(offset);
  positions.setXYZ(i,p.x,p.y,p.z);
 }
 geometry.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,1,0,1,1,0,1],2));
 return {geometry,material};
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

function bedModel(id,props,makeMaterial){
 const head=props.part==='head',color=id.slice(0,-4);
 const mattress=cuboid([1,1,6/16],[0,0,0],[16,16,6],[0,head?0:22])
  .rotateX(Math.PI/2).translate(.5,6/16,.5);
 const legs=[3/32,29/32].map(x=>new THREE.BoxGeometry(3/16,3/16,3/16).translate(x,3/32,head?3/32:29/32));
 return [
  {geometry:orient(mattress,props.facing),material:makeMaterial('entity/bed/'+color,id,false)},
  {geometry:orient(mergeGeometries(legs),props.facing),material:makeMaterial('block/oak_planks',id,false)},
 ];
}

const skullTextures={skeleton:'skeleton/skeleton',wither_skeleton:'skeleton/wither_skeleton',zombie:'zombie/zombie',
 creeper:'creeper/creeper',piglin:'piglin/piglin',dragon:'enderdragon/dragon',player:'player/wide/steve'};
function skullModel(id,props,makeMaterial){
 const kind=id.replace(/(?:_wall)?_(?:skull|head)$/,''),wall=!!props.facing;
 const dimension=kind==='dragon'?[256,256]:['skeleton','wither_skeleton'].includes(kind)?[64,32]:[64,64];
 const box=kind==='dragon'?[16,16,16]:[8,8,8],z=wall?.75:.5,y=wall?.5:box[1]/32;
 const part=(units,center,uv)=>cuboid(units.map(n=>n/16),center,units,uv,dimension);
 const components=[part(box,[.5,y,z],kind==='dragon'?[112,30]:[0,0])];
 if(kind==='piglin'){
  components.push(part([4,3,1],[.5,y-.08,z-.28],[31,1]));
  for(const x of [.18,.82])components.push(part([2,4,3],[x,y+.04,z],[50,0]));
 }
 if(kind==='dragon'){
  components.push(part([12,5,12],[.5,y-.08,z-.67],[176,44]),part([12,4,12],[.5,y-.27,z-.67],[176,65]));
  for(const x of [.23,.77])components.push(part([2,4,6],[x,y+.58,z+.05],[0,0]));
 }
 const geometry=mergeGeometries(components);
 if(wall)orient(geometry,props.facing);
 else geometry.translate(-.5,0,-.5).rotateY(-(Number(props.rotation)||0)*Math.PI/8).translate(.5,0,.5);
 return [{geometry,material:makeMaterial('entity/'+skullTextures[kind],id,false)}];
}

function potModel(id,props,makeMaterial,appearance){
 const place=geometry=>orient(geometry,props.facing);
 const ring=(size,y)=>cuboid(size,[.5,y,.5],[14,3,14],[0,0],[32,32]);
 const rim=mergeGeometries([
  ring([14/16,2/16,14/16],1/16),ring([8/16,2/16,8/16],15/16),
  ring([7/16,2/16,7/16],13/16),
 ]);
 const result=[{geometry:place(rim),material:makeMaterial('entity/decorated_pot/decorated_pot_base',id,false)}];
 const sherds=appearance?.sherds??[];
 for(const [index,yaw] of [Math.PI,Math.PI/2,-Math.PI/2,0].entries()){
  const name=sherds[index];
  const texture=name?'entity/decorated_pot/'+name+'_pottery_pattern':'entity/decorated_pot/decorated_pot_side';
  const panel=new THREE.PlaneGeometry(14/16,.75).translate(0,.4375,7/16).rotateY(yaw).translate(.5,0,.5);
  result.push({geometry:place(panel),material:makeMaterial(texture,id,false)});
 }
 return result;
}

function chestModel(id,props,makeMaterial){
 const copper=/^(?:waxed_)?(?:(exposed|weathered|oxidized)_)?copper_chest$/.exec(id);
 const sprite=copper?'copper'+(copper[1]?'_'+copper[1]:''):({chest:'normal',trapped_chest:'trapped',ender_chest:'ender'})[id];
 if(!sprite)return null;
 const type=id==='ender_chest'?'single':props.type??'single';
 const left=type==='left',right=type==='right';
 const x=left?8.5:right?7.5:8,width=left||right?15:14;
 const boxes=[
  cuboid([width/16,10/16,14/16],[x/16,5/16,.5],[width,10,14],[0,19]),
  cuboid([width/16,5/16,14/16],[x/16,11.5/16,.5],[width,5,14])
 ];
 const lockWidth=left||right?1:2,lockCenter=left?15.5:right?.5:8;
 boxes.push(cuboid([lockWidth/16,4/16,1/16],[lockCenter/16,9/16,.5/16],[lockWidth,4,1],[2,4]));
 const suffix=left||right?'_'+type:'';
 return [{geometry:orient(mergeGeometries(boxes),props.facing),material:makeMaterial('entity/chest/'+sprite+suffix,id,false)}];
}

export function specialModel(id,props,makeMaterial,appearance,minecraft=baselineMinecraft){
 const relocatedEntityTextures=javaReleases[minecraft]>=javaReleases['26.1'];
 if(id.endsWith('_sign')&&javaReleases[minecraft]<javaReleases['26.2'])return signModel(id,props,makeMaterial,appearance);
 if(id.endsWith('_bed')&&javaReleases[minecraft]<javaReleases['26.2'])return bedModel(id,props,makeMaterial);
 if(Object.hasOwn(skullTextures,id.replace(/(?:_wall)?_(?:skull|head)$/,'')))return skullModel(id,props,makeMaterial);
 if(id==='decorated_pot')return potModel(id,props,makeMaterial,appearance);
 if(/(?:^|_)copper_golem_statue$/.test(id))return copperStatueModel(id,props,makeMaterial,cuboid,orient,minecraft);
 if(id==='end_portal'||id==='end_gateway'){
  const geometry=id==='end_portal'?new THREE.PlaneGeometry(1,1).rotateX(-Math.PI/2).translate(.5,.75,.5):
   new THREE.BoxGeometry(1,1,1).translate(.5,.5,.5);
  const sprite=relocatedEntityTextures?'entity/end_portal/end_portal':'entity/end_portal';
  return [{geometry,material:makeMaterial(sprite,id,false)}];
 }
 if(id==='conduit'){
  const size=6/16;
  return [{geometry:new THREE.BoxGeometry(size,size,size).translate(.5,.5,.5),material:makeMaterial('block/conduit',id,false)}];
 }
 if(id==='chest'||id.endsWith('_chest'))return chestModel(id,props,makeMaterial);
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
  const sprite=relocatedEntityTextures?'entity/banner/banner_base':'entity/banner_base';
  const parts=[{geometry:body(1/24),material:makeMaterial(sprite,id,true)},
   {geometry:place(mergeGeometries(frame)),material:makeMaterial('block/oak_planks',id,false)}];
  for(const [index,pattern] of (appearance?.patterns??[]).entries()){
   parts.push({geometry:body(1/24+(index+1)*.0008),
    material:makeMaterial('entity/banner/'+pattern.name,id,pattern.color)});
  }
  return parts;
 }
 return null;
}
