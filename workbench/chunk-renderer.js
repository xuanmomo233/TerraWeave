import * as THREE from 'three';
import {wantedChunks,cellsInChunk} from './chunk-index.js';
import {updateAnimatedTexture} from './texture-animation.js';
export class ChunkRenderer {
 constructor(scene,parts,origin){this.scene=scene;this.parts=parts;this.origin=origin;this.loaded=new Map();this.animatedMaps=[];this.epoch=0;this.busy=false;this.stats={};}
 reset(index,cap,min=-Infinity){this.epoch++;for(const v of this.loaded.values())this.dispose(v);this.loaded.clear();this.animatedMaps=[];this.index=index;this.cap=cap;this.min=min;this.stats={built:0,evicted:0,buildMs:0,activeChunks:0,activeBlocks:0};}
 dispose(v){this.scene.remove(v.group);v.group.traverse(o=>{if(o.isInstancedMesh)o.dispose()});v.group.clear();}
 async update(x,z,radius,maxChunks=36,{parts=this.parts,dirty,prepare,chooseVariants,minecraft,geometry=this,isCurrent=()=>true}={}){
  const {index,cap,min,origin,replace=false}=geometry;
  if(!index||this.busy||!isCurrent())return;this.busy=true;const epoch=this.epoch;
  const current=()=>epoch===this.epoch&&isCurrent();
  const staged=new Map(),started=performance.now();
  let committed=false;
  try{
   const wanted=wantedChunks(index,x,z,radius,maxChunks),ids=new Set(wanted.map(c=>c.id));
   for(const chunk of wanted){
    if(!replace&&this.loaded.has(chunk.id)&&!dirty?.has(chunk.column))continue;
    const cells=cellsInChunk(chunk,cap,min),group=new THREE.Group(),batches=new Map();
    staged.set(chunk.id,{group,count:cells.length});
    for(const cell of cells){
     const key=JSON.stringify([cell.s,cell.mask,cell.fluid_mask,cell.fluid_corners,cell.block_entity]);
     if(!batches.has(key))batches.set(key,{
      state:cell.s,options:{occlusionMask:cell.mask,fluidMask:cell.fluid_mask,fluidCorners:cell.fluid_corners,blockEntity:cell.block_entity},cells:[]
     });
     batches.get(key).cells.push(cell);
    }
    for(const {state,options,cells:positions} of batches.values()){
     const choices=chooseVariants?await chooseVariants(state,positions,cell=>cell.p,minecraft):[{items:positions}];
     for(const {items,indices} of choices){
      const models=await parts(state,{...options,variantIndices:indices});
      if(!current())return;
      for(const part of models){
       const mesh=new THREE.InstancedMesh(part.geometry,part.material,items.length),matrix=new THREE.Matrix4();
       const offset=part.placeholder?.5:0;
       items.forEach(({p},i)=>{
        matrix.makeTranslation(p[0]-origin[0]+offset,p[1]-origin[1]+offset,p[2]-origin[2]+offset);
        mesh.setMatrixAt(i,matrix);
       });
       mesh.userData={ps:items,s:state};
       mesh.computeBoundingSphere();
       group.add(mesh);
      }
     }
    }
    await new Promise(r=>setTimeout(r,0));
    if(!current())return;
   }
   if(prepare)await prepare([...staged.values()].flatMap(v=>v.group.children.map(mesh=>mesh.material)));
   if(!current())return;
   // Keep old meshes visible until the whole affected set and its textures are ready.
   const retained=[...this.loaded.keys()].filter(id=>ids.has(id)&&!staged.has(id)).length;
   for(const [id,entry] of this.loaded){
    if(ids.has(id)&&!staged.has(id))continue;
    this.dispose(entry);
    this.loaded.delete(id);
    this.stats.evicted++;
   }
   for(const [id,entry] of staged){this.scene.add(entry.group);this.loaded.set(id,entry);}
   Object.assign(this,{index,cap,min,origin});
   this.animatedMaps=[...new Set(this.meshes().map(mesh=>mesh.material.map).filter(map=>map?.userData.animation))];
   committed=true;
   this.stats.built+=staged.size;
   this.stats.buildMs+=performance.now()-started;
   this.stats.activeChunks=this.loaded.size;this.stats.activeBlocks=[...this.loaded.values()].reduce((n,v)=>n+v.count,0);
   return {rebuilt_chunks:staged.size,retained_chunks:retained};
  }finally{
   if(!committed)for(const entry of staged.values())this.dispose(entry);
   this.busy=false;
  }
 }
 meshes(){return [...this.loaded.values()].flatMap(v=>v.group.children)}
 animate(now){let changed=false;for(const map of this.animatedMaps)if(updateAnimatedTexture(map,now))changed=true;return changed;}
}
