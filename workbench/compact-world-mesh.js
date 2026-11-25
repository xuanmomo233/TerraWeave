import * as THREE from 'three';

export const coordinateOf=encoded=>[encoded%32,Math.floor(encoded/1024)-64,Math.floor(encoded/32)%32];
export const vertexCount=geometry=>geometry.getAttribute('position').count;
export const indexCount=geometry=>geometry.index?.count??vertexCount(geometry);
export const compactModelBytes=geometry=>vertexCount(geometry)*34+indexCount(geometry)*4;

export function compactBlockLookup(groups){
 const states=[...new Set(groups.map(group=>group.state))];
 const stride=8192;
 if(states.length>stride)return new Map(groups.flatMap(group=>group.positions.map(p=>[p,group.state])));
 const ids=new Map(states.map((state,i)=>[state,i]));
 const cells=new Uint32Array(groups.reduce((count,group)=>count+group.positions.length,0));
 let cursor=0;
 for(const group of groups){
  const id=ids.get(group.state);
  for(const position of group.positions)cells[cursor++]=position*stride+id;
 }
 cells.sort();
 return {get(position){
  const from=position*stride;
  let a=0,b=cells.length;
  while(a<b){
   const mid=(a+b)>>>1;
   if(cells[mid]<from)a=mid+1;
   else b=mid;
  }
  const entry=cells[a];
  return entry<from+stride?states[entry%stride]:undefined;
 }};
}

export function compactWorldMesh(bucket,atlas,material){
 const {vertices,indices}=bucket;
 const positions=new Float32Array(vertices*3),normals=new Int8Array(vertices*3),uvs=new Float32Array(vertices*2);
 const slots=atlas.dimension/atlas.tileSize>256?new Float32Array(vertices):new Uint16Array(vertices);
 const colors=new Uint8Array(vertices*3),owners=new Float32Array(vertices);
 const index=vertices>65536?new Uint32Array(indices):new Uint16Array(indices);
 let cursor=0,offset=0;
 for(const {g,part} of bucket.items){
  const geometry=part.geometry,p=geometry.getAttribute('position'),n=geometry.getAttribute('normal'),uv=geometry.getAttribute('uv');
  const rect=atlas.rects.get(part.material.map)??atlas.white,tint=part.material.color??new THREE.Color(0xffffff);
  const color=[tint.r,tint.g,tint.b].map(value=>Math.round(THREE.MathUtils.clamp(value,0,1)*255));
  const placeholder=part.placeholder?.5:0,count=vertexCount(geometry),indices=indexCount(geometry);
  for(const encoded of g.positions){
   const [x,y,z]=coordinateOf(encoded);
   for(let i=0;i<indices;i++)index[offset++]=cursor+(geometry.index?.getX(i)??i);
   for(let i=0;i<count;i++,cursor++){
    const j=cursor*3,k=cursor*2;
    positions[j]=p.getX(i)+x+placeholder;positions[j+1]=p.getY(i)+y+placeholder;positions[j+2]=p.getZ(i)+z+placeholder;
    normals[j]=Math.round((n?.getX(i)??0)*127);normals[j+1]=Math.round((n?.getY(i)??1)*127);normals[j+2]=Math.round((n?.getZ(i)??0)*127);
    uvs[k]=uv?.getX(i)??0;uvs[k+1]=uv?.getY(i)??0;
    slots[cursor]=rect.slot;colors.set(color,j);owners[cursor]=encoded;
   }
  }
 }
 const geometry=new THREE.BufferGeometry();
 geometry.setIndex(new THREE.BufferAttribute(index,1));
 geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
 geometry.setAttribute('blockOwner',new THREE.BufferAttribute(owners,1));
 geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3,true));
 geometry.setAttribute('uv',new THREE.BufferAttribute(uvs,2));
 geometry.setAttribute('atlasSlot',new THREE.BufferAttribute(slots,1));
 geometry.setAttribute('color',new THREE.BufferAttribute(colors,3,true));
 geometry.computeBoundingBox();
 geometry.computeBoundingSphere();
 return new THREE.Mesh(geometry,material);
}
