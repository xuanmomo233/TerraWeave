export const faceDirections=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
export const fluidBlockKind=s=>/^minecraft:(water|lava)(?:\[|$)/.exec(s??'')?.[1]??null;
export const aquaticPlant=id=>id==='seagrass'||id==='tall_seagrass'||id==='kelp'||id==='kelp_plant';
export function fluidKind(state){
 if(!state)return null;
 const pure=fluidBlockKind(state);
 if(pure)return pure;
 const id=state.startsWith('minecraft:')?state.slice(10).split('[')[0]:'';
 return aquaticPlant(id)||id==='bubble_column'||/[\[,]waterlogged=true(?:,|\])/.test(state)?'water':null;
}
export function fluidCornerHeights(x,y,z,kind,get,opaque){
 const height=(x,z)=>{const s=get(x,y,z);if(s==null)return -1;if(fluidKind(s)!==kind)return opaque(s)?-1:0;if(fluidKind(get(x,y+1,z))===kind)return 1;const level=Number(/level=(\d+)/.exec(s)?.[1]??0);return level>=8?8/9:(8-level)/9;};
 return [[0,0],[1,0],[1,1],[0,1]].map(([dx,dz])=>{let sum=0,weight=0;for(const xx of [x+dx-1,x+dx])for(const zz of [z+dz-1,z+dz]){const h=height(xx,zz);if(h===1)return 1;if(h<0)continue;const w=h>=.8?10:1;sum+=h*w;weight+=w;}return weight?Math.round(sum/weight*10000)/10000:0;});
}
