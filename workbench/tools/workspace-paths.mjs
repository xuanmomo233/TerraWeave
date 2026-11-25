import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const PROJECT=fileURLToPath(new URL('../',import.meta.url)).replace(/[\\/]$/,'');
const projectId=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function projectDescriptor(root,id){
 try{
  const data=JSON.parse(fs.readFileSync(path.join(root,'project.json'),'utf8'));
  return data?.schema===1&&data.id===id&&typeof data.name==='string'?data:null;
 }catch(error){
  if(error.code==='ENOENT'||error.code==='ENOTDIR'||error instanceof SyntaxError)return null;
  throw error;
 }
}

export function registeredProject(primary,id){
 if(typeof id!=='string'||!projectId.test(id))return null;
 const root=path.join(primary,'projects',id),data=projectDescriptor(root,id);
 return data?{root,id,name:data.name,created_at:data.created_at}:null;
}

export function startupPaths(install,env){
 const pinned=env.TERRAWEAVE_STATE&&path.resolve(install,env.TERRAWEAVE_STATE);
 let primary=pinned||path.join(install,'project-state','workbench');
 if(env.TERRAWEAVE_PRIMARY_STATE)primary=path.resolve(install,env.TERRAWEAVE_PRIMARY_STATE);
 else if(pinned&&path.basename(path.dirname(pinned))==='projects'){
  const catalog=path.dirname(path.dirname(pinned));
  if(registeredProject(catalog,path.basename(pinned)))primary=catalog;
 }
 if(pinned||env.TERRAWEAVE_WORLD)return {primary,root:pinned||primary};
 try{
  const session=JSON.parse(fs.readFileSync(path.join(primary,'desktop-session.json'),'utf8'));
  const last=registeredProject(primary,session?.project_id);
  return {primary,root:last?.root??primary};
 }catch{return {primary,root:primary};}
}

export const {primary:PRIMARY_ROOT,root:ROOT}=startupPaths(PROJECT,process.env);
