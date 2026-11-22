const positive=n=>Number.isSafeInteger(n)&&n>0;

export function textureAnimation(imageWidth,imageHeight,metadata){
 if(!metadata||typeof metadata!=='object')return null;
 const width=metadata.width??(metadata.height?imageWidth:Math.min(imageWidth,imageHeight));
 const height=metadata.height??(metadata.width?imageHeight:Math.min(imageWidth,imageHeight));
 if(!positive(width)||!positive(height)||imageWidth%width||imageHeight%height)return null;
 const columns=imageWidth/width,count=columns*(imageHeight/height);
 if(count<2||count>4096)return null;
 const defaultTime=positive(metadata.frametime)?metadata.frametime:1;
 const sequence=Array.isArray(metadata.frames)?metadata.frames:Array.from({length:count},(_,i)=>i);
 if(sequence.length>4096)return null;
 const frames=[];let duration=0;
 for(const entry of sequence){
  const index=typeof entry==='number'?entry:entry?.index;
  const ticks=positive(entry?.time)?entry.time:defaultTime;
  if(!Number.isInteger(index)||index<0||index>=count)continue;
  frames.push({index,start:duration,ticks});duration+=ticks;
 }
 return frames.length&&Number.isSafeInteger(duration)?{width,height,columns,frames,duration,interpolate:metadata.interpolate===true}:null;
}

export function textureFrame(animation,now){
 const phase=((Math.floor(now/50)%animation.duration)+animation.duration)%animation.duration;
 let lo=0,hi=animation.frames.length;
 while(lo+1<hi){const at=(lo+hi)>>1;if(animation.frames[at].start<=phase)lo=at;else hi=at;}
 const frame=animation.frames[lo],next=animation.frames[(lo+1)%animation.frames.length].index;
 return {index:frame.index,next,mix:animation.interpolate&&next!==frame.index?(phase-frame.start)/frame.ticks:0};
}

export function updateAnimatedTexture(map,now){
 const animate=map?.userData.animation;
 if(!animate)return false;
 const {animation,image,context}=animate,frame=textureFrame(animation,now);
 const key=frame.index+':'+(frame.mix?frame.next+':'+frame.mix:'');
 if(animate.key===key)return false;
 animate.key=key;
 const {width,height,columns}=animation;
 const draw=(index,alpha)=>{
  context.globalAlpha=alpha;
  context.drawImage(image,index%columns*width,Math.floor(index/columns)*height,width,height,0,0,width,height);
 };
 context.clearRect(0,0,width,height);
 draw(frame.index,1-frame.mix);
 if(frame.mix){context.globalCompositeOperation='lighter';draw(frame.next,frame.mix);context.globalCompositeOperation='source-over';}
 context.globalAlpha=1;
 map.needsUpdate=true;
 return true;
}

export function setTextureImage(map,image,metadata){
 const animation=textureAnimation(image.width,image.height,metadata);
 if(!animation){map.image=image;map.needsUpdate=true;return;}
 const canvas=document.createElement('canvas');
 canvas.width=animation.width;canvas.height=animation.height;
 const context=canvas.getContext('2d');context.imageSmoothingEnabled=false;
 map.image=canvas;
 map.userData.animation={animation,image,context,key:null};
 updateAnimatedTexture(map,0);
}
