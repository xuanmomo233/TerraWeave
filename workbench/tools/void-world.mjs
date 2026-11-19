import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';

const marker = 'terraweave-void.json';
const text = value => {
 // NBT strings use Java's modified UTF-8, so supplementary characters encode as UTF-16 surrogate pairs.
 const encoded=[];
 for(let i=0;i<value.length;i++){
  const code=value.charCodeAt(i);
  if(code>0&&code<=0x7f)encoded.push(code);
  else if(code<=0x7ff)encoded.push(0xc0|(code>>6),0x80|(code&63));
  else encoded.push(0xe0|(code>>12),0x80|((code>>6)&63),0x80|(code&63));
 }
 const bytes = Buffer.from(encoded);
 const length = Buffer.alloc(2);
 length.writeUInt16BE(bytes.length);
 return Buffer.concat([length, bytes]);
};
const integer = value => {const bytes = Buffer.alloc(4);bytes.writeInt32BE(value);return bytes;};
const long = value => {const bytes = Buffer.alloc(8);bytes.writeBigInt64BE(BigInt(value));return bytes;};
const compound = entries => Buffer.concat([
 ...entries.flatMap(([type, name, value]) => [Buffer.from([type]), text(name), value]), Buffer.from([0])
]);
const str = (name, value) => [8, name, text(value)];
const int = (name, value) => [3, name, integer(value)];
const byte = (name, value) => [1, name, Buffer.from([value])];
const obj = (name, ...entries) => [10, name, compound(entries)];

function levelDat(name, [x,y,z]) {
 const overworld = obj('minecraft:overworld', str('type','minecraft:overworld'),
  obj('generator',str('type','minecraft:flat'),obj('settings',
   str('biome','minecraft:the_void'),byte('features',0),byte('lakes',0),
   [9,'layers',Buffer.from([10,0,0,0,0])], [9,'structure_overrides',Buffer.from([8,0,0,0,0])])));
 const data = obj('Data', str('LevelName',name), int('DataVersion',3465), int('version',19133),
  int('GameType',1),byte('allowCommands',1),byte('Difficulty',0),int('SpawnX',x),int('SpawnY',y),int('SpawnZ',z),
  [4,'LastPlayed',long(Date.now())],
  obj('Version',str('Name','1.20.1'),int('Id',3465),str('Series','main'),byte('Snapshot',0)),
  obj('WorldGenSettings',[4,'seed',long(0)],byte('generate_features',0),byte('bonus_chest',0),
   obj('dimensions',overworld,
    obj('minecraft:the_nether',str('type','minecraft:the_nether'),
     obj('generator',str('type','minecraft:noise'),str('settings','minecraft:nether'),
      obj('biome_source',str('type','minecraft:multi_noise'),str('preset','minecraft:nether')))),
    obj('minecraft:the_end',str('type','minecraft:the_end'),
     obj('generator',str('type','minecraft:noise'),str('settings','minecraft:end'),obj('biome_source',str('type','minecraft:the_end')))))));
 return gzipSync(Buffer.concat([Buffer.from([10,0,0]),compound([data])]));
}

export function readVoidWorld(directory) {
 const file = path.join(directory,marker);
 if (!fs.existsSync(file)) return null;
 const data = JSON.parse(fs.readFileSync(file,'utf8'));
 const {name,spawn} = data;
 if (data.schema!==1 || typeof name!=='string' || !Array.isArray(spawn) || spawn.length!==3 ||
     !spawn.every(Number.isSafeInteger) || Math.abs(spawn[0])>30000000 || Math.abs(spawn[2])>30000000 ||
     spawn[1]<-64 || spawn[1]>319) throw Error('虚空世界配置无效');
 return {name,spawn};
}

export function writeVoidWorld(root, name, spawn) {
 const id = randomUUID();
 const directory = path.join(root,'worlds',id);
 fs.mkdirSync(path.dirname(directory),{recursive:true});
 fs.mkdirSync(directory);
 try {
  fs.mkdirSync(path.join(directory,'region'));
  fs.writeFileSync(path.join(directory,'level.dat'),levelDat(name,spawn),{flag:'wx'});
  fs.writeFileSync(path.join(directory,'uid.dat'),Buffer.from(id.replaceAll('-',''),'hex'),{flag:'wx'});
  fs.writeFileSync(path.join(directory,marker),JSON.stringify({schema:1,name,spawn}),{flag:'wx'});
  return directory;
 } catch (error) {
  // This directory was allocated by this call and cannot be an existing save.
  fs.rmSync(directory,{recursive:true,force:true});
  throw error;
 }
}
