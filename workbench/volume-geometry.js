import * as THREE from 'three';
export function volumeGeometry(tile,origin){
 const positions=[],normals=[],colors=[],palette=new Map();
 for(const [direction,plane,u0,v0,width,height,color]of tile.quads){const axis=Math.floor(direction/2),u=(axis+1)%3,v=(axis+2)%3,positive=direction%2,normal=[0,0,0];normal[axis]=positive?1:-1;const corners=[[u0,v0],[u0+width,v0],[u0+width,v0+height],[u0,v0+height]],order=positive?[0,1,2,0,2,3]:[0,2,1,0,3,2];if(!palette.has(color))palette.set(color,new THREE.Color(color).toArray());
  for(const index of order){const p=[0,0,0];p[axis]=plane;p[u]=corners[index][0];p[v]=corners[index][1];positions.push(...p.map((n,i)=>n-origin[i]));normals.push(...normal);colors.push(...palette.get(color));}
 }
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.computeBoundingSphere();return g;
}
export function sceneTileSelection(info,position,pixels=650,maxTiles=96){
 const roots=new Map(),rootLevel=6;for(const chunk of info.occupied_chunks){const span=64*2**rootLevel,x=Math.floor(chunk[0]*16/span),z=Math.floor(chunk[1]*16/span),key=x+','+z;if(!roots.has(key))roots.set(key,{x,z,level:rootLevel,chunks:[]});roots.get(key).chunks.push(chunk);}
 const select=error=>{const wanted=[];function visit(node){const span=64*2**node.level,minX=node.x*span,minZ=node.z*span,minY=Math.min(...node.chunks.map(c=>c[2])),maxY=Math.max(...node.chunks.map(c=>c[3])),dx=Math.max(minX-position[0],0,position[0]-minX-span),dy=Math.max(minY-position[1],0,position[1]-maxY),dz=Math.max(minZ-position[2],0,position[2]-minZ-span),distance=Math.max(1,Math.hypot(dx,dy,dz));
   if(node.level&&2**node.level*pixels/distance>error){const children=new Map(),childSpan=span/2;for(const c of node.chunks){const x=Math.floor(c[0]*16/childSpan),z=Math.floor(c[1]*16/childSpan),key=x+','+z;if(!children.has(key))children.set(key,{x,z,level:node.level-1,chunks:[]});children.get(key).chunks.push(c);}for(const child of children.values())visit(child);}
   else wanted.push({x:node.x,z:node.z,level:node.level,key:[node.level,node.x,node.z].join(':'),distance});
  }for(const node of roots.values())visit(node);return wanted;};let wanted=select(2.5),error=2.5;while(wanted.length>maxTiles&&error<1024)wanted=select(error*=1.5);return wanted.sort((a,b)=>a.distance-b.distance);
}
