import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';

export function parseNbt(bytes){
 let offset=0,nodes=0;
 const take=n=>{if(n<0||offset+n>bytes.length)throw Error('Truncated NBT');const b=bytes.subarray(offset,offset+n);offset+=n;return b;};
 const u8=()=>take(1)[0],i32=()=>take(4).readInt32BE(),str=()=>take(take(2).readUInt16BE()).toString('utf8');
 function value(tag,depth=0){if(depth>64||++nodes>2000000)throw Error('NBT complexity limit');switch(tag){
  case 1:return take(1).readInt8();case 2:return take(2).readInt16BE();case 3:return i32();case 4:return take(8).readBigInt64BE();case 5:return take(4).readFloatBE();case 6:return take(8).readDoubleBE();
  case 7:{const length=i32();return take(length);}case 8:return str();
  case 9:{const type=u8(),length=i32();if(length<0||length>1000000)throw Error('Invalid NBT list');return Array.from({length},()=>value(type,depth+1));}
  case 10:{const result=Object.create(null);while(true){const type=u8();if(!type)return result;const key=str();result[key]=value(type,depth+1);}}
  case 11:case 12:{const length=i32(),size=tag===11?4:8;if(length<0||length>4000000/size)throw Error('Invalid NBT array');const b=take(length*size);return Array.from({length},(_,i)=>tag===11?b.readInt32BE(i*4):b.readBigUInt64BE(i*8));}
  default:throw Error('Unknown NBT tag '+tag);
 }}
 if(u8()!==10)throw Error('NBT root is not a compound');str();return value(10);
}

export function readLevelNbt(file){
 try{return parseNbt(gunzipSync(fs.readFileSync(file),{maxOutputLength:4_000_000}));}
 catch{return null;}
}
