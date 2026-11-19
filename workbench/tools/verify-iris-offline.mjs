import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {readIrisArchive,inspectIrisArchive} from './iris-shaderpack.mjs';
import {lowerLegacyProgram} from '../iris-legacy-glsl.js';

const file=process.argv[2]??"assets/shaderpacks/Sildur's+Vibrant+Shaders+v1.51+High.zip";
const pack=readIrisArchive(file),inspection=inspectIrisArchive(pack);
const shaders={};
for(const [name,stages] of pack.programs('world0')){
 if(stages.vsh&&stages.fsh&&Object.keys(stages).length===2){
  shaders[name]=lowerLegacyProgram(pack.expand(stages.vsh),pack.expand(stages.fsh));
 }
}
const runtime=process.env.TERRAWEAVE_PLAYWRIGHT??'C:/Users/杨骋达/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const {chromium}=await import(pathToFileURL(runtime));
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
 args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-networking']});
try{
 const page=await browser.newPage();
 const result=await page.evaluate(sources=>{
  const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;
  const gl=canvas.getContext('webgl2',{preserveDrawingBuffer:true});
  if(!gl)throw Error('WebGL 2 is unavailable');
  const linked=[],errors=[];
  let final;
  function compile(type,text){
   const shader=gl.createShader(type);gl.shaderSource(shader,text);gl.compileShader(shader);
   if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){
    const error=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw Error(error);
   }
   return shader;
  }
  for(const [name,s] of Object.entries(sources)){
   let vs,fs,program;
   try{
    vs=compile(gl.VERTEX_SHADER,s.vertex.source);
    fs=compile(gl.FRAGMENT_SHADER,s.fragment.source);
    program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
    linked.push(name);
    if(name==='final'){final=program;program=null;}
   }catch(e){errors.push({pass:name,error:String(e).slice(0,350)});}
   finally{if(vs)gl.deleteShader(vs);if(fs)gl.deleteShader(fs);if(program)gl.deleteProgram(program);}
  }
  if(!final)return {linked,errors,pixels:null};
  gl.useProgram(final);
  const vao=gl.createVertexArray();gl.bindVertexArray(vao);
  function attribute(name,values){
   const loc=gl.getAttribLocation(final,name);if(loc<0)return;
   const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
   gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.STATIC_DRAW);
   gl.vertexAttribPointer(loc,4,gl.FLOAT,false,0,0);gl.enableVertexAttribArray(loc);
  }
  attribute('twVertex',[-1,-1,0,1,1,-1,0,1,-1,1,0,1,1,1,0,1]);
  attribute('twTexCoord0',[0,0,0,1,1,0,0,1,0,1,0,1,1,1,0,1]);
  const identity=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
  for(const unit of [0,1,2]){
   const tex=gl.createTexture();gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,tex);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
   gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
   const value=unit===2?.98:0;
   gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,1,1,0,gl.RGBA,gl.FLOAT,new Float32Array([value,value,value,1]));
  }
  const floats={viewWidth:32,viewHeight:32,aspectRatio:1,near:.1,far:512};
  for(let i=0;i<gl.getProgramParameter(final,gl.ACTIVE_UNIFORMS);i++){
   const u=gl.getActiveUniform(final,i),loc=gl.getUniformLocation(final,u.name);
   switch(u.type){
    case gl.FLOAT:gl.uniform1f(loc,floats[u.name]??0);break;
    case gl.SAMPLER_2D:gl.uniform1i(loc,u.name==='gaux4'||u.name==='colortex7'?0:u.name.startsWith('depthtex')?2:1);break;
    case gl.INT:case gl.BOOL:gl.uniform1i(loc,u.name==='worldTime'?6000:0);break;
    case gl.INT_VEC2:gl.uniform2i(loc,240,240);break;
    case gl.FLOAT_VEC3:gl.uniform3f(loc,0,1,0);break;
    case gl.FLOAT_MAT4:gl.uniformMatrix4fv(loc,false,identity);break;
   }
  }
  gl.viewport(0,0,32,32);
  function draw(input){
   gl.activeTexture(gl.TEXTURE0);
   gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,1,1,0,gl.RGBA,gl.FLOAT,new Float32Array(input));
   gl.clearColor(1,0,1,1);gl.clear(gl.COLOR_BUFFER_BIT);
   gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
   const pixel=new Uint8Array(4);
   gl.readPixels(16,16,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
   return Array.from(pixel);
  }
  return {linked,errors,pixels:[draw([.004,.001,.0005,1]),draw([.0005,.001,.004,1])],glError:gl.getError()};
 },shaders);
 console.log(JSON.stringify({scope:'Offline WebGL 2 compatibility harness; synthetic inputs for the original final pass',pack_hash:inspection.hash,programs:inspection.passes,buffer_count:inspection.buffers.length,uniform_count:inspection.uniforms.length,include_errors:inspection.issues,...result},null,2));
 assert.deepEqual(inspection.issues,[]);
 assert.ok(result.pixels,'The original final program must link');
 assert.equal(result.glError,0);
 assert.notDeepEqual(result.pixels[0],[255,0,255,255]);
 assert.notDeepEqual(result.pixels[0],result.pixels[1],'The original final pass must respond to its input texture');
}finally{await browser.close();}
