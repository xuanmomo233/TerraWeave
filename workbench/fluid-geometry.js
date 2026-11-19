import * as THREE from 'three';
export function fluidGeometry(corners,mask=0){
 const [a,b,c,d]=corners,p=[],uv=[],quads=[[[1,0,1],[1,0,0],[1,b,0],[1,c,1]],[[0,0,0],[0,0,1],[0,d,1],[0,a,0]],[[0,d,1],[1,c,1],[1,b,0],[0,a,0]],[[0,0,0],[1,0,0],[1,0,1],[0,0,1]],[[0,0,1],[1,0,1],[1,c,1],[0,d,1]],[[1,0,0],[0,0,0],[0,a,0],[1,b,0]]];
 for(let face=0;face<6;face++){if(mask&(1<<face))continue;const points=quads[face],coords=[[0,0],[1,0],[1,1],[0,1]];for(const i of [0,1,2,0,2,3]){p.push(...points[i]);uv.push(...coords[i]);}}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.computeVertexNormals();return g;
}
