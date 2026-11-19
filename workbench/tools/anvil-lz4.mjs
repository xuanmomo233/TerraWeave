// Minecraft uses lz4-java's LZ4Block stream, not the LZ4 frame format.
const magic=Buffer.from('LZ4Block');
const primes=[0x9e3779b1,0x85ebca77,0xc2b2ae3d,0x27d4eb2f,0x165667b1];
const rotate=(n,bits)=>(n<<bits)|(n>>>(32-bits));
function checksum(bytes){
 const [p1,p2,p3,p4,p5]=primes,seed=0x9747b28c;
 let i=0,h=(seed+p5)|0;
 if(bytes.length>=16){
  const acc=[seed+p1+p2,seed+p2,seed,seed-p1];
  for(;i+16<=bytes.length;i+=16)
   for(let lane=0;lane<4;lane++)acc[lane]=Math.imul(rotate(acc[lane]+Math.imul(bytes.readUInt32LE(i+lane*4),p2),13),p1);
  h=rotate(acc[0],1)+rotate(acc[1],7)+rotate(acc[2],12)+rotate(acc[3],18);
 }
 h=(h+bytes.length)|0;
 for(;i+4<=bytes.length;i+=4)h=Math.imul(rotate(h+Math.imul(bytes.readUInt32LE(i),p3),17),p4);
 for(;i<bytes.length;i++)h=Math.imul(rotate(h+Math.imul(bytes[i],p5),11),p1);
 h=Math.imul(h^(h>>>15),p2);
 h=Math.imul(h^(h>>>13),p3);
 return (h^(h>>>16))&0x0fffffff;
}

function decodeBlock(input,size){
 const out=Buffer.alloc(size);
 let src=0,dst=0;
 function count(n){
  if(n<15)return n;
  let next;
  do{
   if(src>=input.length)throw Error('Truncated LZ4 length');
   next=input[src++];
   n+=next;
  }while(next===255);
  return n;
 }
 while(src<input.length){
  const token=input[src++],literals=count(token>>>4);
  if(src+literals>input.length||dst+literals>size)throw Error('Invalid LZ4 literals');
  input.copy(out,dst,src,src+literals);
  src+=literals;
  dst+=literals;
  if(src===input.length)break;
  if(src+2>input.length)throw Error('Truncated LZ4 match');
  const distance=input.readUInt16LE(src);
  src+=2;
  const length=count(token&15)+4;
  if(!distance||distance>dst||dst+length>size)throw Error('Invalid LZ4 match');
  for(let n=0;n<length;n++,dst++)out[dst]=out[dst-distance];
 }
 if(dst!==size)throw Error('Invalid LZ4 block size');
 return out;
}

export function decodeAnvilLz4(input,maxBytes){
 let cursor=0,size=0;
 const blocks=[];
 while(cursor+21<=input.length){
  const header=input.subarray(cursor,cursor+21);
  if(!header.subarray(0,8).equals(magic))throw Error('Invalid LZ4 stream signature');
  const token=header[8],method=token&0xf0,stored=header.readUInt32LE(9),original=header.readUInt32LE(13),expected=header.readUInt32LE(17);
  cursor+=21;
  if(method!==0x10&&method!==0x20)throw Error('Invalid LZ4 method');
  if(!stored&&!original&&!expected&&cursor===input.length)return Buffer.concat(blocks,size);
  if(!stored||!original||stored>original||original>2**(10+(token&15))||cursor+stored>input.length||size+original>maxBytes)
   throw Error('Invalid LZ4 stream length');
  const bytes=input.subarray(cursor,cursor+stored);
  const block=method===0x10?bytes:decodeBlock(bytes,original);
  if(block.length!==original||checksum(block)!==expected)throw Error('LZ4 checksum mismatch');
  blocks.push(block);
  cursor+=stored;
  size+=original;
 }
 throw Error('LZ4 stream has no end marker');
}
