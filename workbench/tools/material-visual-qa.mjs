import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'vite';
import {normalizeBlockState} from './block-states.mjs';
import {assetRoots,ensurePackAnimationMetadata} from './render-packs.mjs';
import {ensureVanillaAssets} from './vanilla-assets.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),assets=path.join(root,'assets');
const out=process.env.TERRAWEAVE_MATERIAL_QA_OUTPUT??path.join(root,'packages/material-visual-qa');
fs.mkdirSync(out,{recursive:true});
await ensureVanillaAssets('1.20.1');
ensurePackAnimationMetadata(assets);
const overlays=assetRoots(assets);
const {chromium}=await import(pathToFileURL(process.env.TERRAWEAVE_PLAYWRIGHT??
 'C:/Users/杨骋达/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);

const cases=[
 'redstone_wire[power=0,east=side,west=side]','redstone_wire[power=15,east=side,west=side]',
 'pumpkin_stem[age=7]','melon_stem[age=3]','attached_pumpkin_stem[facing=east]','attached_melon_stem[facing=north]',
 'bamboo_sapling','pink_petals[flower_amount=4]','potted_fern','lava_cauldron','powder_snow_cauldron[level=3]','stonecutter',
 'lily_pad','yellow_bed[part=head,facing=east]','yellow_bed[part=foot,facing=east]',
 'skeleton_skull[rotation=2]','zombie_head','player_head','piglin_head','creeper_wall_head[facing=north]','dragon_head',
 'decorated_pot','piston_head','moving_piston','end_portal','end_gateway','bubble_column',
 'lantern','sea_lantern','glowstone','stone_brick_stairs[facing=east]','stone_brick_stairs[facing=north]',
];
const blocks={};
for(let z=0;z<=24;z++)for(let x=0;x<=39;x++)blocks[[x,63,z]]='minecraft:smooth_stone';
for(const [i,state] of cases.entries()){
 const x=state.startsWith('yellow_bed[part=foot')?26:2+i%8*5,z=2+Math.floor(i/8)*5;
 blocks[[x,64,z]]=normalizeBlockState(state);
 if(state==='lily_pad')blocks[[x,63,z]]=normalizeBlockState('water');
}
for(let x=1;x<=38;x++){
 blocks[[x,64,20]]=normalizeBlockState('stone');
 blocks[[x,64,22]]=normalizeBlockState('bookshelf');
 blocks[[x,64,24]]=normalizeBlockState('grass_block');
}

async function exercise({THREE,buildState,awaitTextures,chooseVariantGroups,ChunkRenderer,TexturedWorld,makeIndex,renderCapture,blocks}){
 const require=(condition,message)=>{if(!condition)throw Error(message);};
 const view=()=>{const scene=new THREE.Scene();scene.background=new THREE.Color('#172332');
  scene.add(new THREE.HemisphereLight(0xffffff,0x777777,1.8));
  const sun=new THREE.DirectionalLight(0xffffff,2);sun.position.set(3,5,2);scene.add(sun);return scene;};
 const localScene=view(),worldScene=view(),minecraft='1.20.1',bounds=[0,63,0,39,65,24];
 const choices={local:new Map(),panoramic:new Map()};
 const pick=mode=>async(state,positions,position,version)=>{
  const groups=await chooseVariantGroups(state,positions,position,version);
  for(const group of groups)if(group.indices)for(const item of group.items)
   choices[mode].set(position(item).join(','),group.indices.join(','));
  return groups;
 };
 const parts=(state,options)=>buildState(state,{...options,minecraft});
 const chunks=new ChunkRenderer(localScene,parts,[0,0,0]);
 chunks.reset(makeIndex({minecraft,bounds,blocks}),319);
 await chunks.update(20,12,64,64,{chooseVariants:pick('local'),minecraft,prepare:awaitTextures});
 const sourceTiles=new Map();
 const expected=new Set();
 for(const [key,state] of Object.entries(blocks)){
  const [x,y,z]=key.split(',').map(Number),tx=Math.floor(x/32),tz=Math.floor(z/32),tileKey=tx+','+tz;
  if(!sourceTiles.has(tileKey))sourceTiles.set(tileKey,{x:tx,z:tz,bounds:[tx*32,-64,tz*32,tx*32+32,320,tz*32+32],minecraft,groups:new Map()});
  const tile=sourceTiles.get(tileKey);
  if(!tile.groups.has(state))tile.groups.set(state,{state,mask:0,fluid_mask:0,positions:[]});
  tile.groups.get(state).positions.push((y+64)*1024+(z%32)*32+(x%32));
  expected.add(state);
 }
 const lod=new TexturedWorld(worldScene,async(name,{x,z})=>{
  require(name==='world_model_tile','Unexpected tile request');
  const t=sourceTiles.get(x+','+z);return {...t,groups:[...t.groups.values()]};
 },parts,undefined,pick('panoramic'));
 await lod.initialize({revision:'material-fixture',bounds,occupied_chunks:[...sourceTiles.values()].map(t=>[t.x*2,t.z*2,63,65])});
 lod.enabled=true;
 await lod.update(20,12,1,[0,0,0],null);
 const localStates=new Set(chunks.meshes().map(mesh=>mesh.userData.s));
 const panoramicStates=new Set(Object.keys(lod.evidence().models).map(key=>JSON.parse(key)[1]));
 for(const state of expected)require(localStates.has(state)&&panoramicStates.has(state),'Missing visible model for '+state);
 const tested=[];
 for(const name of ['bookshelf','grass_block','stone']){
  const selected=[...choices.local].filter(([key])=>blocks[key].startsWith('minecraft:'+name));
  require(selected.every(([key,indices])=>choices.panoramic.get(key)===indices),'Variant differs by renderer: '+name);
  const count=new Set(selected.map(([,indices])=>indices)).size;
  require(count>1||!selected.length,'All placements used the first variant: '+name);
  tested.push({block:name,placements:selected.length,variants:count});
 }
 require(tested.some(result=>result.variants>1),'The fixture did not draw multiple weighted variants');
 const gradients=[];
 for(const facing of ['east','north']){
  const state=[...expected].find(s=>s.startsWith('minecraft:stone_brick_stairs[')&&s.includes('facing='+facing));
  const mesh=chunks.meshes().find(mesh=>mesh.userData.s===state);
  const geometry=mesh.geometry,p=geometry.getAttribute('position'),uv=geometry.getAttribute('uv'),n=geometry.getAttribute('normal');
  const index=geometry.index.array;
  for(let i=0;i<index.length;i+=3){
   const [a,b,c]=index.slice(i,i+3);if(n.getY(a)<.99)continue;
   const dx=p.getX(b)-p.getX(a),dz=p.getZ(b)-p.getZ(a),ex=p.getX(c)-p.getX(a),ez=p.getZ(c)-p.getZ(a);
   const det=dx*ez-ex*dz;if(Math.abs(det)<1e-7)continue;
   const du=uv.getX(b)-uv.getX(a),eu=uv.getX(c)-uv.getX(a);
   gradients.push([Math.round((du*ez-eu*dz)/det),Math.round((dx*eu-ex*du)/det)]);break;
  }
 }
 require(gradients.length===2&&JSON.stringify(gradients[0])===JSON.stringify(gradients[1]),'Locked stair texture rotated');
 const material=(name,state)=>chunks.meshes().find(mesh=>mesh.userData.s.startsWith(state)&&mesh.material.map?.userData.source===name)?.material;
 const strong=chunks.meshes().find(mesh=>mesh.userData.s.includes('power=15')&&mesh.userData.s.startsWith('minecraft:redstone_wire'));
 const weak=chunks.meshes().find(mesh=>mesh.userData.s.includes('power=0')&&mesh.userData.s.startsWith('minecraft:redstone_wire'));
 require(strong.material.color.getHex()!==weak.material.color.getHex(),'Redstone retained one tint');
 const animated=material('block/lantern','minecraft:lantern')?.map??material('block/sea_lantern','minecraft:sea_lantern')?.map;
 require(animated?.userData.animation,'Actual resource has no animated material');
 const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
 const camera=new THREE.PerspectiveCamera(46,1440/850,.1,256);
 camera.position.set(20,96,47);camera.lookAt(20,64,11);camera.updateMatrixWorld();
 const png=scene=>renderCapture(renderer,scene,camera,1440,850).toDataURL('image/png');
 const sampledColors=[];
 {
  const texture=paint=>{
   const canvas=document.createElement('canvas');canvas.width=canvas.height=16;
   const ctx=canvas.getContext('2d');paint(ctx);return new THREE.CanvasTexture(canvas);
  };
  const checker=texture(ctx=>{
   for(let z=0;z<16;z++)for(let x=0;x<16;x++){
    ctx.fillStyle=(x+z)%2?'#00ff00':'#000000';ctx.fillRect(x,z,1,1);
   }
  });
  const adjacent=texture(ctx=>{ctx.fillStyle='#ff00ff';ctx.fillRect(0,0,16,16);});
  const materials=[checker,adjacent].map(map=>new THREE.MeshLambertMaterial({map}));
  const geometry=new THREE.PlaneGeometry(1,1).rotateX(-Math.PI/2).translate(.5,0,.5);
  const scene=new THREE.Scene();scene.add(new THREE.AmbientLight(0xffffff,1));
  const tile={x:0,z:0,bounds:[0,-64,0,32,320,32],minecraft,groups:[
   {state:'minecraft:stone',positions:Array.from({length:1023},(_,i)=>64*1024+i)},
   {state:'minecraft:red_wool',positions:[64*1024+1023]},
  ]};
  const extraStates=['minecraft:blue_wool','minecraft:yellow_wool'];
  const neighbor={...tile,x:1,bounds:[32,-64,0,64,320,32],groups:tile.groups.map((group,i)=>({...group,state:extraStates[i]}))};
  const world=new TexturedWorld(scene,async(name,{x})=>x===0?tile:neighbor,async state=>{
   const index=extraStates.indexOf(state);
   return [{geometry,material:materials[index>=0?index+2:state.endsWith('stone')?0:1]}];
  });
  await world.initialize({revision:'mip-fixture',bounds:[0,0,0,31,0,31],occupied_chunks:[[0,0]]});
  world.enabled=true;
  await world.update(16,16,1,[0,0,0],null);
  const firstRect=world.atlas.rects.get(checker);
  const extra=texture(ctx=>{ctx.fillStyle='#00ffff';ctx.fillRect(0,0,16,16);});
  require(world.atlas.extend([extra]),'A free aligned atlas cell should accept another texture');
  require(world.atlas.rects.get(checker)===firstRect,'Extending the atlas moved a loaded texture');
  const probe=new THREE.OrthographicCamera(-16,16,16,-16,.1,80);
  probe.up.set(0,0,-1);probe.position.set(16,24,16);probe.lookAt(16,0,16);probe.updateMatrixWorld();
  const output=renderCapture(renderer,scene,probe,64,64);
  const rgba=output.getContext('2d').getImageData(20,20,3,3).data;
  for(let i=0;i<rgba.length;i+=4)sampledColors.push(Array.from(rgba.slice(i,i+3)));
  require(sampledColors.every(([r,g,b])=>r<8&&g>100&&g<230&&b<8),'Distant tiles must average within their own texture '+JSON.stringify(sampledColors));
  const retained=world.meshes.get('0,0'),previousAtlas=world.atlas;
  for(const color of ['#0000ff','#ffff00'])materials.push(new THREE.MeshLambertMaterial({map:texture(ctx=>{ctx.fillStyle=color;ctx.fillRect(0,0,16,16);})}));
  await world.initialize({...world.info,occupied_chunks:[[0,0],[2,0]]});
  await world.update(16,16,1,[0,0,0],null);
  require(world.meshes.get('0,0')===retained&&world.lastUpdate.rebuilt===1,'Atlas growth rebuilt the resident model tile');
  require(world.atlas.dimension>previousAtlas.dimension&&world.atlas.rects.get(checker).slot===firstRect.slot,'Atlas growth changed a retained material slot');
  const retainedPixels=renderCapture(renderer,scene,probe,64,64).getContext('2d').getImageData(20,20,3,3).data;
  require(rgba.every((value,i)=>value===retainedPixels[i]),'Atlas growth changed pixels on unchanged geometry');
  probe.position.x+=32;probe.lookAt(48,0,16);probe.updateMatrixWorld();
  const [r,g,b]=renderCapture(renderer,scene,probe,64,64).getContext('2d').getImageData(20,20,1,1).data;
  require(r<8&&g<8&&b>100,'Newly exposed geometry sampled the wrong texture');
  world.clear();world.markerMaterial.dispose();geometry.dispose();extra.dispose();
  for(const material of materials){material.map.dispose();material.dispose();}
 }
 chunks.animate(0);lod.animate(0);
 const before={local:png(localScene),panoramic:png(worldScene)};
 const atlasBefore=lod.atlas.canvas.toDataURL(),textureBefore=animated.image.toDataURL();
 const time=animated.userData.animation.animation.frames[0].ticks*50;
 require(chunks.animate(time)&&lod.animate(time),'Animated texture did not update both paths');
 require(atlasBefore!==lod.atlas.canvas.toDataURL(),'Panorama atlas stayed on frame zero');
 require(textureBefore!==animated.image.toDataURL(),'Local texture stayed on frame zero');
 const after={local:png(localScene),panoramic:png(worldScene)};
 require(before.local!==after.local&&before.panoramic!==after.panoramic,'Animation did not change either rendered image');
 renderer.dispose();
 return {checked_states:expected.size,variants:tested,uv_top_gradients:gradients,animation_ms:time,screenshots:{local:after.local,panoramic:after.panoramic,animation_start:before.panoramic}};
}

const id='/__material-fixture.js',moduleId='\0terraweave-material-fixture';
const bundle=await build({root,configFile:false,logLevel:'error',build:{write:false,rollupOptions:{input:id}},plugins:[{
 name:'material-visual-fixture',
 resolveId(source){if(source===id)return moduleId;},
 load(source){
  if(source!==moduleId)return;
  return "import * as THREE from 'three';import {buildState,awaitTextures,chooseVariantGroups} from '/model-terrain.js';"
   +"import {ChunkRenderer} from '/chunk-renderer.js';import {TexturedWorld} from '/textured-world.js';"
   +"import {makeIndex} from '/chunk-index.js';import {renderCapture} from '/capture-renderer.js';"
   +"window.materialFixture=("+exercise.toString()+")({THREE,buildState,awaitTextures,chooseVariantGroups,ChunkRenderer,TexturedWorld,makeIndex,renderCapture,blocks:"+JSON.stringify(blocks)+"});";
 }
}]});
const output=new Map((Array.isArray(bundle)?bundle.flatMap(entry=>entry.output):bundle.output)
 .map(entry=>['/'+entry.fileName,entry]));
const entry=[...output.values()].find(file=>file.type==='chunk'&&file.isEntry);
const server=http.createServer((req,res)=>{
 try{
   const url=new URL(req.url,'http://localhost');
   if(url.pathname==='/__material_fixture'){
    const html='<script>window.__TAURI_INTERNALS__={invoke:async (name,args)=>{if(name!=="read_asset")throw Error(name);'
     +'const u=new URL("/__material_asset",location.href);for(const [k,v] of Object.entries(args))u.searchParams.set(k,v);'
     +'u.searchParams.set("mode",new URL(location.href).searchParams.get("mode"));const response=await fetch(u);'
     +'if(!response.ok)throw Error(await response.text());return response.text();}};</script><script type="module" src="/'+entry.fileName+'"></script>';
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;
   }
   if(url.pathname!=='/__material_asset'){
    const asset=output.get(url.pathname);
    if(!asset){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',asset.type==='chunk'?'text/javascript':'application/octet-stream');
    res.end(asset.type==='chunk'?asset.code:asset.source);return;
   }
   const name=url.searchParams.get('name');
   if(!/^minecraft\/(?:blockstates|models|textures)\/[a-z0-9_/-]+\.(?:png|json)$/.test(name)){res.statusCode=400;res.end('Unsupported asset');return;}
   const roots=url.searchParams.get('mode')==='vanilla'?[assets]:[...overlays,assets];
   const file=roots.map(r=>path.join(r,name)).find(p=>fs.existsSync(p));
   if(!file){res.statusCode=404;res.end(name);return;}
   const bytes=fs.readFileSync(file);
   if(!name.endsWith('.png')){res.end(bytes);return;}
   const data='data:image/png;base64,'+bytes.toString('base64'),sidecar=file+'.mcmeta';
   res.end(url.searchParams.get('includeAnimation')==='true'?JSON.stringify({url:data,animation:fs.existsSync(sidecar)?JSON.parse(fs.readFileSync(sidecar)).animation:null}):data);
 }catch(error){res.writeHead(500);res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-networking']});
 const reports=[];
 for(const mode of ['vanilla','active-pack']){
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/__material_fixture?mode='+mode,{waitUntil:'domcontentloaded',timeout:90_000});
  try{await page.waitForFunction(()=>!!window.materialFixture,{},{timeout:90_000});}
  catch(error){throw Error('Material fixture failed to start: '+errors.join('; '),{cause:error});}
  const {screenshots,...result}=await page.evaluate(()=>window.materialFixture);
  assert.ok(result.checked_states>20);
  for(const [name,data] of Object.entries(screenshots)){
   fs.writeFileSync(path.join(out,mode+'-'+name+'.png'),Buffer.from(data.split(',')[1],'base64'));
  }
  reports.push({mode,...result});
  await page.close();
 }
 const result={passed:true,reports};
 fs.writeFileSync(path.join(out,'material-regression.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result,null,2));
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
