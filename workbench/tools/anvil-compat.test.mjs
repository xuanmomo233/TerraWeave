import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {deflateSync,gzipSync} from 'node:zlib';
import {decodeAnvilLz4} from './anvil-lz4.mjs';
import {identifyWorld,saveWorldSource,worldSource} from './world-source.mjs';
import {decodeSurfaceChunk,readWorldChunk,sampleSurface,surfaceTile,worldIndex} from './world-surface.mjs';
import {javaReleases} from '../minecraft-version.js';
import {blockEntityAppearance} from './block-entity-appearance.mjs';
import {normalizeAnvilPalette} from './anvil-block-palette.mjs';
import {normalizeBlockState} from './block-states.mjs';
import {savedDetailSnapshot} from './render-context.mjs';
import {modelTile} from './world-models.mjs';
import {snapshotBytes} from './project-store.mjs';
import {constructionView,registerConstructionSource} from './construction-view.mjs';
import {blockConverter} from './design-conversion.mjs';
import {validateDesignPacket} from './world-writer.mjs';

const short=n=>Buffer.from([n>>>8,n&255]);
const int=n=>{const b=Buffer.alloc(4);b.writeInt32BE(n);return b;};
const text=s=>Buffer.concat([short(Buffer.byteLength(s)),Buffer.from(s)]);
const tag=(type,name,value)=>Buffer.concat([Buffer.from([type]),text(name),value]);
const compound=(...tags)=>Buffer.concat([...tags,Buffer.from([0])]);
const list=(type,...values)=>Buffer.concat([Buffer.from([type]),int(values.length),...values]);
const root=payload=>tag(10,'',payload);
const str=(key,value)=>tag(8,key,text(value));
const num=(key,value)=>tag(3,key,int(value));

for(const [version,dataVersion] of Object.entries(javaReleases)){
 test('Java '+version+' 离线读取 · DataVersion '+dataVersion,t=>{
  const world=fs.mkdtempSync(path.join(os.tmpdir(),'terraweave-java-release-'));
  t.after(()=>fs.rmSync(world,{recursive:true}));
  const relative=dataVersion>=4786?'dimensions/minecraft/overworld/region':'region';
  const region=path.join(world,relative);
  fs.mkdirSync(region,{recursive:true});
  const versionTag=tag(10,'Version',compound(str('Name',version),num('Id',dataVersion)));
  fs.writeFileSync(path.join(world,'level.dat'),gzipSync(root(compound(tag(10,'Data',compound(num('DataVersion',dataVersion),versionTag))))));
  const palette=tag(9,'palette',list(10,compound(str('Name','minecraft:stone'))));
  const section=compound(tag(1,'Y',Buffer.from([0])),tag(10,'block_states',compound(palette)));
  const chunk=root(compound(num('DataVersion',dataVersion),str('Status','minecraft:full'),tag(9,'sections',list(10,section))));
  const codecs=[gzipSync,deflateSync,b=>b];
  const compression=dataVersion%codecs.length;
  const payload=codecs[compression](chunk);
  const mca=Buffer.alloc(3*4096);
  mca.writeUInt32BE(2<<8|1,0);
  mca.writeUInt32BE(payload.length+1,8192);
  mca[8196]=compression+1;
  payload.copy(mca,8197);
  fs.writeFileSync(path.join(region,'r.0.0.mca'),mca);
  const index=worldIndex(identifyWorld(world));
  assert.equal(index.minecraft,version);
  assert.equal(index.data_version,dataVersion);
  assert.equal(index.chunk_count,1);
  assert.equal(index.region_directory,region);
  assert.equal(savedDetailSnapshot([0,0,0,0,0,0],index).blocks['0,0,0'],'minecraft:stone');
 });
}

test('saved submerged plants keep their models without exposing water faces around them',t=>{
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'terraweave-seagrass-'));
 t.after(()=>fs.rmSync(world,{recursive:true}));
 const region=path.join(world,'region');
 fs.mkdirSync(region);
 const version=javaReleases['1.20.1'];
 fs.writeFileSync(path.join(world,'level.dat'),gzipSync(root(compound(tag(10,'Data',compound(
  num('DataVersion',version),tag(10,'Version',compound(str('Name','1.20.1'),num('Id',version)))
 ))))));
 const states=['air','water','seagrass','mud'].map(name=>compound(str('Name','minecraft:'+name)));
 const cell=(x,y,z)=>y*256+z*16+x;
 const words=Array(256).fill(0n);
 const set=(x,y,z,id)=>{
  const i=cell(x,y,z);
  words[i>>4]|=BigInt(id)<<BigInt((i&15)*4);
 };
 for(let y=2;y<=4;y++)for(let z=2;z<=4;z++)for(let x=2;x<=4;x++){
  set(x,y,z,x===3&&z===3?(y===3?2:y===2?3:1):1);
 }
 const packed=Buffer.alloc(4+words.length*8);
 packed.writeInt32BE(words.length);
 words.forEach((value,i)=>packed.writeBigUInt64BE(value,4+i*8));
 const section=compound(tag(1,'Y',Buffer.from([0])),tag(10,'block_states',compound(tag(9,'palette',list(10,...states)),tag(12,'data',packed))));
 const content=deflateSync(root(compound(num('DataVersion',version),str('Status','full'),tag(9,'sections',list(10,section)))));
 const mca=Buffer.alloc(3*4096);
 mca.writeUInt32BE(2<<8|1,0);
 mca.writeUInt32BE(content.length+1,8192);
 mca[8196]=2;content.copy(mca,8197);
 fs.writeFileSync(path.join(region,'r.0.0.mca'),mca);
 const tile=modelTile(0,0,path.join(world,'model-cache'),worldIndex(identifyWorld(world)));
 const packedTile=(x,y,z)=>(y+64)*1024+z*32+x;
 const plant=tile.groups.find(g=>g.positions.includes(packedTile(3,3,3)));
 assert.equal(plant.state,'minecraft:seagrass');
 assert.equal(plant.fluid_mask,63);
 const water=tile.groups.find(g=>g.positions.includes(packedTile(2,3,3)));
 assert.equal(water.fluid_mask&1,1);
});

test('legacy and modern banner and container NBT preserves their visible information',()=>{
 assert.deepEqual(blockEntityAppearance({id:'minecraft:banner',Patterns:[{Pattern:'cr',Color:14}]}),
  blockEntityAppearance({id:'minecraft:banner',patterns:[{pattern:'minecraft:cross',color:'red'}]}));
 assert.deepEqual(blockEntityAppearance({id:'minecraft:chest',CustomName:'{"text":"箱子"}',Items:[{Slot:3,id:'minecraft:diamond',Count:7}]}),
  blockEntityAppearance({id:'minecraft:chest',CustomName:{text:'箱子'},Items:[{Slot:3,id:'minecraft:diamond',count:7}]}));
});

test('26.2 overworld resolves modern regions, decodes external chunks and preserves sign appearance',t=>{
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'terraweave-modern-anvil-'));
 t.after(()=>fs.rmSync(world,{recursive:true}));
 const region=path.join(world,'dimensions/minecraft/overworld/region');
 fs.mkdirSync(region,{recursive:true});
 fs.writeFileSync(path.join(world,'level.dat'),gzipSync(root(compound(tag(10,'Data',compound(
  num('DataVersion',4903),tag(10,'Version',compound(str('Name','26.2'),num('Id',4903)))
 ))))));
 const sign=compound(str('id','minecraft:sign'),num('x',0),num('y',0),num('z',0),
  tag(10,'front_text',compound(str('color','red'),tag(9,'messages',list(8,text('{"text":"入口"}'),text('26.2'))))));
 const section=compound(tag(1,'Y',Buffer.from([0])),tag(10,'block_states',compound(
  tag(9,'palette',list(10,compound(str('Name','minecraft:oak_sign'),tag(10,'Properties',compound(str('rotation','0'),str('waterlogged','false'))))))
 )));
 const chunk=root(compound(num('DataVersion',4903),str('Status','minecraft:full'),
  tag(9,'sections',list(10,section)),tag(9,'block_entities',list(10,sign))));
 const mca=Buffer.alloc(3*4096);
 mca.writeUInt32BE(2<<8|1,0);
 mca.writeUInt32BE(1,8192);
 mca[8196]=0x82;
 fs.writeFileSync(path.join(region,'r.0.0.mca'),mca);
 fs.writeFileSync(path.join(region,'c.0.0.mcc'),deflateSync(chunk));
 const source=identifyWorld(world);
 assert.equal(source.region_directory,region);
 const data=readWorldChunk(0,0,world);
 assert.equal(data.DataVersion,4903);
 assert.equal(decodeSurfaceChunk(data).block(0,0,0),'minecraft:oak_sign[rotation=0,waterlogged=false]');
 const index={...source,minecraft:'26.2',revision:'fixture',regions:[{x:0,z:0,size:12288,mtime:1}]};
 const snapshot=savedDetailSnapshot([0,0,0,0,0,0],index);
 assert.deepEqual(snapshot.block_entities['0,0,0'].front.lines,['入口','26.2','','']);
 assert.match(snapshotBytes(snapshot),/入口/);
 const tile=modelTile(0,0,path.join(world,'model-cache'),index);
 assert.equal(tile.minecraft,'26.2');
 assert.equal(tile.groups.find(group=>group.block_entity).block_entity.front.color,0xb02e26);
});

test('26.3 reads default and explicit block palettes in a world with older chunks',t=>{
 const world=fs.mkdtempSync(path.join(os.tmpdir(),'terraweave-26.3-'));
 t.after(()=>fs.rmSync(world,{recursive:true}));
 const directory=path.join(world,'dimensions/minecraft/overworld/region');
 fs.mkdirSync(directory,{recursive:true});
 const version=javaReleases['26.3'];
 const level=compound(num('DataVersion',version),
  tag(10,'Version',compound(str('Name','26.3'),num('Id',version))));
 fs.writeFileSync(path.join(world,'level.dat'),gzipSync(root(compound(tag(10,'Data',level)))));
 const chunk=(dataVersion,states)=>deflateSync(root(compound(num('DataVersion',dataVersion),
  str('Status','minecraft:full'),tag(9,'sections',list(10,compound(
   tag(1,'Y',Buffer.from([19])),tag(10,'block_states',compound(...states))
  ))))));
 const indices=Buffer.alloc(256*8);
 indices.writeBigUInt64BE(0x2_1_0n);
 const payloads=[
  chunk(version,[tag(9,'palette',list(10,
   compound(str('','minecraft:poplar_log')),
   compound(str('id','minecraft:poplar_log'),tag(10,'properties',compound(str('axis','x')))),
   compound(str('','minecraft:oak_stairs')))),
   tag(12,'data',Buffer.concat([int(256),indices]))]),
  chunk(version,[tag(9,'palette',list(8,text('minecraft:grass_block')))]),
  chunk(javaReleases['26.2'],[tag(9,'palette',list(10,compound(str('Name','minecraft:stone'))))])
 ];
 const mca=Buffer.alloc((2+payloads.length)*4096);
 for(const [cx,payload] of payloads.entries()){
  const sector=cx+2,offset=sector*4096;
  mca.writeUInt32BE(sector<<8|1,cx*4);
  mca.writeUInt32BE(payload.length+1,offset);
  mca[offset+4]=2;payload.copy(mca,offset+5);
 }
 fs.writeFileSync(path.join(directory,'r.0.0.mca'),mca);
 const index=worldIndex(identifyWorld(world));
 assert.equal(index.minecraft,'26.3');
 const expected=['minecraft:poplar_log[axis=y]','minecraft:poplar_log[axis=x]',
  'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]'];
 assert.deepEqual(sampleSurface(1,0,true,world),{y:319,state:expected[0]});
 const snap=savedDetailSnapshot([0,304,0,32,304,0],index);
 assert.deepEqual([0,1,2,16,32].map(x=>snap.blocks[x+',304,0']),[...expected,'minecraft:grass_block[snowy=false]','minecraft:stone']);
 const colors=surfaceTile(0,0,0,path.join(world,'map-cache'),index,304);
 assert.deepEqual([0,1,2,16,32].map(x=>colors.availability[x]),[2,2,2,2,2]);
 const models=modelTile(0,0,path.join(world,'model-cache'),index);
 assert.ok(expected.every(state=>models.groups.some(group=>group.state===state)));
 const project=path.join(world,'conversion-project'),source=path.join(world,'building.json');
 fs.writeFileSync(source,JSON.stringify({schema:1,minecraft:'1.20.1',world_uuid:index.world_uuid,
  draft_id:'00000000-0000-4000-8000-000000000002',draft_revision:1,
  base:{'0,304,0':'minecraft:air'},changes:{'0,304,0':'minecraft:grass'},previously_applied:{}}));
 const call=(tool,args)=>{
  const result=spawnSync(process.execPath,['tools/creative-workbench.mjs','--json'],{
   cwd:new URL('..',import.meta.url),encoding:'utf8',input:JSON.stringify({tool,args}),
   env:{...process.env,TERRAWEAVE_STATE:project,TERRAWEAVE_PRIMARY_STATE:project,TERRAWEAVE_WORLD:world}
  });
  assert.equal(result.status,0,result.stdout||result.stderr);
  return JSON.parse(result.stdout);
 };
 const input={export_path:source},analysis=call('analyze_design_conversion',input);
 const converted=call('convert_design_export',{...input,analysis_token:analysis.analysis_token});
 const result=JSON.parse(fs.readFileSync(converted.path,'utf8'));
 assert.match(result.world_uuid,/^local-/);
 assert.deepEqual(result.base,{'0,304,0':expected[0]});
 assert.deepEqual(result.changes,{'0,304,0':'minecraft:short_grass'});
 assert.throws(()=>validateDesignPacket(result),/无效的织境工坊方案/);
 const audit=call('audit_world_version',{target_version:'26.2'});
 assert.equal(audit.scope.terrain_chunks,3);
 assert.ok(audit.issues.some(issue=>issue.kind==='incompatible_block'&&issue.id==='minecraft:poplar_log[axis=x]'));
 assert.match(fs.readFileSync(audit.report_path,'utf8'),/世界存档版本差异/);
 assert.deepEqual(fs.readFileSync(path.join(directory,'r.0.0.mca')),mca);
});

test('26.3 authoring and Anvil use actual defaults, including properties absent from the model',()=>{
 const cases=[
  ['acacia_fence','acacia_fence[east=false,north=false,south=false,waterlogged=false,west=false]'],
  ['andesite_wall','andesite_wall[east=none,north=none,south=none,up=true,waterlogged=false,west=none]'],
  ['poplar_trapdoor[waterlogged=true]','poplar_trapdoor[facing=north,half=bottom,open=false,powered=false,waterlogged=true]'],
  ['stone','stone']
 ];
 for(const [input,expected] of cases)assert.equal(normalizeBlockState(input,'26.3'),'minecraft:'+expected);
 assert.throws(()=>normalizeBlockState('poplar_log[axis=diagonal]','26.3'),/属性/);
 assert.throws(()=>normalizeBlockState('not_a_real_block','26.3'),/不存在/);
 const chunk=normalizeAnvilPalette({DataVersion:5023,sections:[{block_states:{palette:[
  {id:'minecraft:stone',properties:{}},'minecraft:acacia_fence'
 ]}}],block_entities:[{id:'minecraft:piston',blockState:{id:'minecraft:poplar_trapdoor',properties:{waterlogged:'true'}}}]});
 assert.deepEqual(chunk.sections[0].block_states.palette[0],{Name:'minecraft:stone'});
 assert.equal(chunk.sections[0].block_states.palette[1].Properties.north,'false');
 assert.equal(blockEntityAppearance(chunk.block_entities[0]).state,'minecraft:'+cases[2][1]);
});

test('all supported version pairs convert a common fully specified building block',()=>{
 const state='minecraft:oak_stairs[facing=east,half=top,shape=inner_left,waterlogged=true]';
 const versions=Object.keys(javaReleases);
 for(const source of versions)for(const target of versions){
  assert.deepEqual(blockConverter(source,target)(state),{state,kind:'exact'},source+' → '+target);
 }
});

test('conversion adapts verified aliases and requires explicit substitutes for unavailable states',()=>{
 assert.deepEqual(blockConverter('1.20.1','26.3')('minecraft:grass'),
  {state:'minecraft:short_grass',kind:'adapted'});
 assert.deepEqual(blockConverter('26.3','1.20.1')('minecraft:iron_chain[axis=x,waterlogged=true]'),
  {state:'minecraft:chain[axis=x,waterlogged=true]',kind:'adapted'});
 assert.equal(blockConverter('1.20.1','26.3')('minecraft:barrier').state,'minecraft:barrier[waterlogged=false]');
 assert.match(blockConverter('26.3','1.20.1')('minecraft:barrier[waterlogged=true]').reason,/waterlogged=true/);
 assert.match(blockConverter('26.1','1.21.11')('minecraft:note_block[instrument=trumpet]').reason,/trumpet/);
 const state='minecraft:poplar_log[axis=z]';
 assert.match(blockConverter('26.3','1.20.1')(state).reason,/目标版本没有/);
 assert.equal(blockConverter('26.3','1.20.1',{[state]:'minecraft:oak_log[axis=z]'})(state).state,'minecraft:oak_log[axis=z]');
 assert.match(blockConverter('26.3','1.20.1',{[state]:'minecraft:oak_log[facing=east]'})(state).reason,/替换后的方块/);
});

test('modern Paper metadata identifies the overworld and preserves an older project ID',t=>{
 const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),'terraweave-paper-uuid-'));
 t.after(()=>fs.rmSync(rootDir,{recursive:true}));
 const game=path.join(rootDir,'world'),project=path.join(rootDir,'project');
 const overworld=path.join(game,'dimensions','minecraft','overworld');
 fs.mkdirSync(path.join(overworld,'region'),{recursive:true});
 const level=tag(10,'Data',compound(num('DataVersion',javaReleases['26.3'])));
 fs.writeFileSync(path.join(game,'level.dat'),gzipSync(root(compound(level))));
 const local=saveWorldSource(game,undefined,project).world_uuid;
 assert.match(local,/^local-/);
 const metadata=path.join(overworld,'data','paper','metadata.dat');
 fs.mkdirSync(path.dirname(metadata),{recursive:true});
 const bits=Buffer.from('56393027df574faf867c38deb58b6e9c','hex');
 const writeUuid=()=>fs.writeFileSync(metadata,gzipSync(root(compound(tag(10,'data',compound(
  tag(11,'uuid',Buffer.concat([int(4),bits]))
 ))))));
 writeUuid();
 const uuid='56393027-df57-4faf-867c-38deb58b6e9c';
 assert.equal(identifyWorld(game).world_uuid,uuid);
 assert.equal(worldSource(project).world_uuid,local);
 assert.equal(worldSource(project).paper_world_uuid,uuid);
 saveWorldSource(game,local,project);
 const ledger=path.join(rootDir,'writer-ledger'),operation='00000000-0000-4000-8000-000000000001';
 fs.mkdirSync(ledger);
 fs.mkdirSync(path.join(project,'exports'));
 fs.mkdirSync(path.join(project,'drafts'));
 fs.writeFileSync(path.join(project,'drafts','draft.json'),JSON.stringify({id:'draft',world_uuid:local,plan_id:'plan'}));
 const exportPath=path.join(project,'exports','draft.json'),design={draft_id:'draft',world_uuid:uuid,plan_id:'plan'};
 fs.writeFileSync(exportPath,JSON.stringify(design));
 registerConstructionSource(exportPath,design,ledger);
 fs.writeFileSync(path.join(ledger,operation+'.json'),JSON.stringify({
  id:operation,kind:'apply',order:1,...design,batches:[{changes:[{x:0,y:70,z:0,before:'minecraft:air',after:'minecraft:stone'}]}]
 }));
 const planning={objects:[{id:'plan',visible:false}],layers:[]};
 assert.equal(constructionView(project,local,planning,uuid)?.block(0,70,0,'minecraft:stone'),'minecraft:air');
 bits[15]^=255;writeUuid();
 assert.match(worldSource(project).error,/UUID 已变化/);
});

test('reads an actual lz4-java compressed block and rejects a corrupted checksum',()=>{
 const payload=Buffer.from('TFo0QmxvY2smFgAAAIACAAAYqFIBr1RlcnJhV2VhdmUKAP//YFBXZWF2ZUxaNEJsb2NrFgAAAAAAAAAAAAAAAA==','base64');
 assert.equal(decodeAnvilLz4(payload,1024).toString(),'TerraWeave'.repeat(64));
 assert.throws(()=>decodeAnvilLz4(payload,639),/length/);
 payload[17]^=1;
 assert.throws(()=>decodeAnvilLz4(payload,1024),/checksum/);
});
