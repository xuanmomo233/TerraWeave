import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PROJECT,ROOT} from './workspace-paths.mjs';
import {identifyWorld,saveWorldSource,worldSource} from './world-source.mjs';
import {writeVoidWorld} from './void-world.mjs';

export const primaryRoot = path.resolve(PROJECT,process.env.TERRAWEAVE_PRIMARY_STATE??ROOT);
export const primaryWorld = process.env.TERRAWEAVE_PRIMARY_WORLD??(ROOT===primaryRoot?process.env.TERRAWEAVE_WORLD:undefined);
const projects = path.join(primaryRoot,'projects');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const descriptor = id => path.join(id==='primary'?primaryRoot:path.join(projects,id),'project.json');

function readDescriptor(id){
 try {
  const data=JSON.parse(fs.readFileSync(descriptor(id),'utf8'));
  if(data.schema!==1||data.id!==id||typeof data.name!=='string')return null;
  return data;
 }catch(error){
  if(error.code==='ENOENT'||error instanceof SyntaxError)return null;
  throw error;
 }
}
function registered(id){
 if(typeof id!=='string'||!uuid.test(id))return null;
 const data=readDescriptor(id);
 return data?{id,name:data.name,root:path.join(projects,id),created_at:data.created_at}:null;
}
function primary(){
 const metadata=readDescriptor('primary');
 if(metadata)return {id:'primary',name:metadata.name,root:primaryRoot};
 let label;
 try{label=JSON.parse(fs.readFileSync(path.join(primaryRoot,'workspace.json'),'utf8')).label;}
 catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
 return {id:'primary',name:label&&label!=='织境工坊'&&label!=='TerraWeave 世界工程'?label:'原工程',root:primaryRoot};
}

export function projectFor(id){
 const project=id==='primary'?primary():registered(id);
 if(!project)throw Error('工程不存在或不可读取');
 return project;
}
export function currentProject(){
 if(ROOT!==primaryRoot){
  const project=registered(path.basename(ROOT));
  if(project?.root===ROOT)return project;
 }
 return primary();
}
export function listProjects(status){
 const entries=fs.existsSync(projects)?fs.readdirSync(projects,{withFileTypes:true}):[];
 const records=entries.filter(entry=>entry.isDirectory()).map(entry=>registered(entry.name)).filter(Boolean)
  .sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
 return [primary(),...records].map(project=>{
  return {...projectDetails(project),current:project.root===ROOT,running:status(project.root).running};
 });
}

function projectDetails(project){
 const source=worldSource(project.root,project.id==='primary'?primaryWorld:undefined);
 const worlds=path.join(project.root,'worlds');
 const owned=source?.void_world&&fs.existsSync(worlds)&&
  path.dirname(source.directory)===fs.realpathSync(worlds);
 const source_kind=source?.error?'unavailable':owned?'project-world':source?'linked':'blank';
 return {id:project.id,name:project.name,project_directory:project.root,world:source?.world??null,
  directory:source?.directory??null,error:source?.error??null,source_kind};
}

export function projectLocations(id){
 return projectDetails(projectFor(id));
}

function projectName(name){
 const label=typeof name==='string'?name.trim():'';
 if(!label||label.length>64||/[\u0000-\u001f\u007f]/u.test(label))throw Error('工程名称须为 1 至 64 个字，且不能含控制符');
 return label;
}

export function renameProject(id,name){
 const project=projectFor(id),label=projectName(name);
 if(project.name===label)return {id,name:label};
 fs.mkdirSync(project.root,{recursive:true});
 const file=descriptor(id),pending=file+'.pending-'+randomUUID();
 const data=readDescriptor(id)??{schema:1,id};
 fs.writeFileSync(pending,JSON.stringify({...data,name:label}),{flag:'wx'});
 try{fs.renameSync(pending,file);}
 catch(error){fs.unlinkSync(pending);throw error;}
 return {id,name:label};
}

export function createProject({name,type,directory}){
 const label=projectName(name);
 if(!['blank','void','save'].includes(type))throw Error('请选择工程的存档类型');
 if(type==='save'&&(typeof directory!=='string'||!directory.trim()))throw Error('请填写世界存档目录');
 const source=type==='save'?identifyWorld(directory.trim()):null;
 const id=randomUUID(),root=path.join(projects,id);
 fs.mkdirSync(projects,{recursive:true});
 fs.mkdirSync(root);
 try {
  if(source)saveWorldSource(source.directory,undefined,root);
  if(type==='void')saveWorldSource(writeVoidWorld(root,label,[0,64,0]),undefined,root);
  fs.writeFileSync(descriptor(id),JSON.stringify({schema:1,id,name:label,created_at:new Date().toISOString()}),{flag:'wx'});
  return {id,name:label};
 }catch(error){
  fs.rmSync(root,{recursive:true,force:true});
  throw error;
 }
}

export async function createRestoredProject(name,install){
 const label=projectName(name),id=randomUUID(),root=path.join(projects,id);
 fs.mkdirSync(projects,{recursive:true});
 fs.mkdirSync(root);
 try{
  await install(root);
  fs.writeFileSync(descriptor(id),JSON.stringify({schema:1,id,name:label,created_at:new Date().toISOString()}),{flag:'wx'});
  return {id,name:label,project_directory:root};
 }catch(error){
  fs.rmSync(root,{recursive:true,force:true});
  throw error;
 }
}
