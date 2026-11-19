const fixedVertex={
 gl_Vertex:'twVertex',gl_MultiTexCoord0:'twTexCoord0',gl_MultiTexCoord1:'twTexCoord1',
 gl_Normal:'twNormal',gl_ModelViewMatrix:'twModelView',gl_ProjectionMatrix:'twProjection',
 gl_ModelViewProjectionMatrix:'twModelViewProjection',gl_NormalMatrix:'twNormalMatrix',
 gl_TextureMatrix:'twTextureMatrix'
};

/**
 * Lower a GLSL 120 vertex/fragment pair to WebGL 2 syntax. The host still
 * has to provide the original matrices, attributes, samplers and attachments.
 */
export function lowerLegacyProgram(vertex,fragment){
 function lower(source,isVertex){
  if(!/^\s*#version\s+120\b/m.test(source))throw Error('此兼容层目前只接受 GLSL 120');
  let body=source.replace(/^\s*#version\s+120[^\n]*\n/m,'')
   .replace(/^\s*#extension\s+GL_ARB_shader_texture_lod\s*:[^\n]*\n/gm,'')
   .replace(/\bvarying\b/g,isVertex?'out':'in')
   .replace(/\battribute\b/g,'in');
  // "texture" was a legal sampler name in 120; it becomes a function in 300 es.
  const samplerAliases={};
  if(/\buniform\s+sampler\w+\s+texture\b/.test(body)){
   body=body.replace(/\btexture\b/g,'twTerrainTexture');
   samplerAliases.texture='twTerrainTexture';
  }
  body=body.replace(/\btexture(?:2D|3D|Cube)(Lod|Grad)?(?:ARB)?\s*\(/g,(_match,suffix)=>'texture'+(suffix??'')+'(');
  // GLSL ES requires explicit promotion where legacy desktop GLSL accepted it.
  body=body.replace(/\b(worldTime|eyeBrightnessSmooth\.[xy])(?=\s*[-+*/]\s*(?:\d+\.\d*|vec[234]\s*\())/g,'float($1)');
  body=body.replace(/\((eyeBrightnessSmooth\.[xy]\s*[-+]\s*\d+)\)(?=\s*\/\s*\d+\.)/g,'float($1)');
  body=body.replace(/\babs\(\s*(\w+)(?=\s*-\s*float\()/g,'abs(float($1)');
  body=body.replace(/\babs\(float\((\w+)\)-float\((\w+)\)\)\s*\/\s*\2\b/g,'abs(float($1)-float($2))/float($2)');
  body=body.replace(/\b1\s*\+\s*isEyeInWater\s*\*\s*10\.0\b/g,'1.0+float(isEyeInWater)*10.0');
  body=body.replace(/\bisEyeInWater(?=\s*(?:==|!=|[-+*/])\s*\d+\.\d*)/g,'float(isEyeInWater)');
  body=body.replace(/^float\s+comp\s*=\s*(1\.0\s*-\s*near\s*\/\s*far\s*\/\s*far)\s*;/gm,'#define comp ($1)');
  body=body.replace(/\bftransform\s*\(\s*\)/g,'(gl_ModelViewProjectionMatrix * gl_Vertex)');
  const declarations=[];
  const types={
   twVertex:'in vec4',twTexCoord0:'in vec4',twTexCoord1:'in vec4',twNormal:'in vec3',
   twModelView:'uniform mat4',twProjection:'uniform mat4',twModelViewProjection:'uniform mat4',
   twNormalMatrix:'uniform mat3',twTextureMatrix:'uniform mat4'
  };
  for(const [from,to] of Object.entries(fixedVertex)){
   const name=new RegExp('\\b'+from+'\\b','g');
   if(!isVertex||!body.match(name))continue;
   body=body.replace(name,to);
   declarations.push(types[to]+' '+to+(to==='twTextureMatrix'?'[8]':'')+';');
  }
  if(isVertex&&/\bgl_Color\b/.test(body)){
   declarations.push('in vec4 twColor;');body=body.replace(/\bgl_Color\b/g,'twColor');
  }
  const color= isVertex?'gl_FrontColor':'gl_Color';
  const colorPattern=new RegExp('\\b'+color+'\\b','g');
  if(body.match(colorPattern)){
   declarations.push((isVertex?'out':'in')+' vec4 twVaryingColor;');
   body=body.replace(colorPattern,'twVaryingColor');
  }
  const outputs=new Set();
  if(!isVertex){
   body=body.replace(/\bgl_FragColor\b/g,()=>{outputs.add(0);return 'twOut0';});
   body=body.replace(/\bgl_FragData\s*\[\s*(\d+)\s*\]/g,(_m,index)=>{outputs.add(Number(index));return 'twOut'+index;});
   for(const index of outputs)declarations.push(`layout(location=${index}) out vec4 twOut${index};`);
  }
  return {source:'#version 300 es\n#define MC_VERSION 12001\nprecision highp float;\nprecision highp int;\nprecision highp sampler2DShadow;\n'+declarations.join('\n')+'\n'+body,samplerAliases,outputs:[...outputs]};
 }
 return {vertex:lower(vertex,true),fragment:lower(fragment,false)};
}
