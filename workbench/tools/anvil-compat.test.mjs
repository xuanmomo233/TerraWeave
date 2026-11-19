import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {deflateSync,gzipSync} from 'node:zlib';
import {decodeAnvilLz4} from './anvil-lz4.mjs';
import {identifyWorld} from './world-source.mjs';
import {decodeSurfaceChunk,readWorldChunk,worldIndex} from './world-surface.mjs';
import {javaReleases} from '../minecraft-version.js';
import {blockEntityAppearance} from './block-entity-appearance.mjs';
import {savedDetailSnapshot} from './render-context.mjs';
import {modelTile} from './world-models.mjs';
import {snapshotBytes} from './project-store.mjs';

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

test('reads an actual lz4-java compressed block and rejects a corrupted checksum',()=>{
 const payload=Buffer.from('TFo0QmxvY2smFgAAAIACAAAYqFIBr1RlcnJhV2VhdmUKAP//YFBXZWF2ZUxaNEJsb2NrFgAAAAAAAAAAAAAAAA==','base64');
 assert.equal(decodeAnvilLz4(payload,1024).toString(),'TerraWeave'.repeat(64));
 assert.throws(()=>decodeAnvilLz4(payload,639),/length/);
 payload[17]^=1;
 assert.throws(()=>decodeAnvilLz4(payload,1024),/checksum/);
});
