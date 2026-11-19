import readline from 'node:readline';
import {callTool} from './creative-workbench.mjs';
let active=0,ended=false;
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line',line=>{if(line.length>4*1024*1024)return;let q;try{q=JSON.parse(line);}catch{return;}active++;Promise.resolve().then(()=>callTool(q.tool,q.args??{},{origin:'desktop'})).then(result=>process.stdout.write(JSON.stringify({id:q.id,result})+'\n'),error=>process.stdout.write(JSON.stringify({id:q.id,error:error.message})+'\n')).finally(()=>{active--;if(ended&&!active)process.exit(0);});});
lines.on('close',()=>{ended=true;if(!active)process.exit(0);});
