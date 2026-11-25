// CPU tile data can use spare system memory. Meshes and their upload staging need
// both GPU and system memory, including on adapters with dedicated video memory.
const pressure={residentTiles:144,streamTiles:24,initialTiles:3,maxVertices:2_300_000};
const small={residentTiles:288,streamTiles:48,initialTiles:4,maxVertices:4_600_000};
const standard={residentTiles:320,streamTiles:64,initialTiles:6,maxVertices:6_900_000};
const roomy={...standard,maxVertices:10_200_000};
const medium={residentTiles:448,streamTiles:96,initialTiles:10,maxVertices:11_600_000};
const large={residentTiles:576,streamTiles:128,initialTiles:14,maxVertices:13_800_000};
export const DEFAULT_RENDER_CAPACITY=Object.freeze({cpuTiles:192,...standard});

export function chooseRenderCapacity(metrics,previous){
 const total=metrics?.system_total_mib,available=metrics?.system_available_mib,vram=metrics?.dedicated_mib;
 if(!Number.isFinite(total)||total<=0||!Number.isFinite(available)||available<0)return previous??DEFAULT_RENDER_CAPACITY;
 const free=Math.min(total,available);
 // After a downgrade require 25% extra free memory to cross the same boundary again.
 const room=(minimum,retaining)=>free>=minimum*(previous&&!retaining?1.25:1);
 let cpuTiles=64,gpu=pressure;
 if(room(1536,previous?.cpuTiles>=192)){
  cpuTiles=192;gpu=standard;
  if(total>=24576&&room(10240,previous?.cpuTiles>=512))cpuTiles=512;
  else if(total>=12288&&room(5120,previous?.cpuTiles>=320))cpuTiles=320;
  const unified=metrics.unified===true,dedicated=metrics.unified===false&&Number.isFinite(vram)&&vram>0;
  const adapterUnknown=metrics.unified==null&&vram==null;
  if((unified||adapterUnknown)&&total>=12288&&room(unified?4096:5120,previous?.maxVertices>=roomy.maxVertices))gpu=roomy;
  if(dedicated&&vram<1536)gpu=small;
  if(dedicated&&vram>=3584&&cpuTiles>=320)gpu=medium;
  if(dedicated&&vram>=7168&&cpuTiles>=512)gpu=large;
  if(unified&&total>=24576&&room(14336,previous?.residentTiles>=medium.residentTiles))gpu=medium;
 }
 return Object.freeze({cpuTiles,...gpu});
}
