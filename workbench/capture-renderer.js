import * as THREE from 'three';

const directions={north:[0,.25,-1],south:[0,.25,1],east:[1,.25,0],west:[-1,.25,0],top:[0,1,0],isometric:[1,.8,-1]};
export function captureCamera(width,height,origin,bounds,{name,position,target,up,fov=50}){
 const center=bounds.slice(0,3).map((n,i)=>(n+bounds[i+3]+1)/2);
 const extent=Math.max(...bounds.slice(0,3).map((n,i)=>bounds[i+3]-n+1));
 const distance=extent/(2*Math.tan(THREE.MathUtils.degToRad(fov/2)))*1.5*Math.max(1,height/width);
 if(!position||!target){
  const offset=new THREE.Vector3(...directions[name]).normalize().multiplyScalar(distance);
  position=center.map((n,i)=>n+offset.getComponent(i));target=center;
 }
 const camera=new THREE.PerspectiveCamera(fov,width/height,.1,Math.max(5000,distance*4+1024));
 camera.position.fromArray(position.map((n,i)=>n-origin[i]));
 camera.up.fromArray(up??(name==='top'?[0,0,-1]:[0,1,0]));
 camera.lookAt(...target.map((n,i)=>n-origin[i]));
 camera.updateMatrixWorld();
 return {camera,pose:{position,target,up:camera.up.toArray(),fov,width,height,world_coordinates:true}};
}
export function captureFrustum(camera){
 camera.updateMatrixWorld();
 return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
}
export function renderCapture(renderer,scene,camera,width,height){
 const target=new THREE.WebGLRenderTarget(width,height);
 target.texture.colorSpace=THREE.SRGBColorSpace;
 const previous=renderer.getRenderTarget();
 try{
  renderer.setRenderTarget(target);
  renderer.render(scene,camera);
  return readCapture(renderer,target);
 }finally{
  renderer.setRenderTarget(previous);
  target.dispose();
 }
}

export function readCapture(renderer,target){
 const {width,height}=target,rgba=new Uint8Array(width*height*4),stride=width*4;
 renderer.readRenderTargetPixels(target,0,0,width,height,rgba);
 const pixels=new Uint8ClampedArray(rgba.length);
 for(let row=0;row<height;row++)pixels.set(rgba.subarray(row*stride,(row+1)*stride),(height-row-1)*stride);
 const canvas=document.createElement('canvas');
 canvas.width=width;canvas.height=height;
 canvas.getContext('2d').putImageData(new ImageData(pixels,width,height),0,0);
 return canvas;
}

export function paintCaptureBatch(renderer,scene,views,clear){
 const target=renderer.getRenderTarget(),autoClear=renderer.autoClear,background=scene.background;
 const color=renderer.getClearColor(new THREE.Color()),alpha=renderer.getClearAlpha();
 try{
  renderer.autoClear=false;
  scene.background=null;
  for(const view of views){
   renderer.setRenderTarget(view.buffer);
   if(clear){renderer.setClearColor(background,1);renderer.clear(true,true,true);}
   renderer.render(scene,view.camera);
  }
 }finally{
  scene.background=background;
  renderer.autoClear=autoClear;
  renderer.setClearColor(color,alpha);
  renderer.setRenderTarget(target);
 }
}
