use serde_json::{json,Value};
use std::{collections::HashMap,fs,io::{BufRead,BufReader,Write},process::{Child,ChildStdin,Command,Stdio},sync::{Arc,Mutex,OnceLock,atomic::{AtomicU64,Ordering},mpsc::{self,Receiver,Sender}},time::Duration};
type Pending=Arc<Mutex<HashMap<u64,Sender<Result<Value,String>>>>>;
struct Worker{child:Child,input:ChildStdin,pending:Pending}
static WORKER:OnceLock<Mutex<Option<Worker>>>=OnceLock::new();
static TERRAIN_WORKER:OnceLock<Mutex<Option<Worker>>>=OnceLock::new();
static IDS:AtomicU64=AtomicU64::new(1);
fn terrain(tool:&str)->bool{matches!(tool,"world_model_tile"|"world_scene_info")}
pub fn handles(tool:&str)->bool{terrain(tool)||matches!(tool,"ui_snapshot"|"planning_state"|"create_layer"|"update_layer"|"delete_layer"|"save_plan"|"delete_plan"|"select_plan"|"undo_plan"|"redo_plan"|"save_map_view"|"world_map_info"|"save_workspace"|"update_draft"|"list_regions"|"list_drafts"|"list_history"|"list_captures"|"workspace_status"|"workbench_status"|"read_editor_state"|"save_editor_state")}
impl Worker{
 fn spawn()->Result<Self,String>{
  let root=crate::workbench::project();let state=crate::workbench::root();fs::create_dir_all(&state).map_err(|e|e.to_string())?;let log=state.join("ui-worker.log");if fs::metadata(&log).map(|m|m.len()>1_000_000).unwrap_or(false){let _=fs::write(&log,[]);}
  let stderr=fs::OpenOptions::new().create(true).append(true).open(log).map_err(|e|e.to_string())?;
  let mut command=Command::new(crate::workbench::node_program());command.arg(root.join("tools/ui-worker.mjs")).current_dir(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(stderr);
  command.env("TERRAWEAVE_DESKTOP_EXE",std::env::current_exe().map_err(|e|e.to_string())?);
  #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
  let mut child=command.spawn().map_err(|e|e.to_string())?;let input=child.stdin.take().ok_or("Missing UI worker input")?;let output=child.stdout.take().ok_or("Missing UI worker output")?;let pending:Pending=Arc::new(Mutex::new(HashMap::new()));let replies=pending.clone();
  std::thread::spawn(move||{for line in BufReader::new(output).lines(){let Ok(line)=line else{break};let Ok(value)=serde_json::from_str::<Value>(&line)else{continue};let Some(id)=value["id"].as_u64()else{continue};let sender=replies.lock().ok().and_then(|mut p|p.remove(&id));if let Some(sender)=sender{let result=if let Some(error)=value["error"].as_str(){Err(error.to_string())}else{Ok(value["result"].clone())};let _=sender.send(result);}}if let Ok(mut p)=replies.lock(){for (_,sender)in p.drain(){let _=sender.send(Err("界面服务已退出，请重试操作".into()));}}});
  Ok(Self{child,input,pending})
 }
 fn enqueue(&mut self,tool:&str,args:Value)->Result<(u64,Receiver<Result<Value,String>>),String>{let id=IDS.fetch_add(1,Ordering::Relaxed);let(tx,rx)=mpsc::channel();self.pending.lock().map_err(|e|e.to_string())?.insert(id,tx);let mut bytes=serde_json::to_vec(&json!({"id":id,"tool":tool,"args":args})).map_err(|e|e.to_string())?;bytes.push(b'\n');if let Err(error)=self.input.write_all(&bytes).and_then(|_|self.input.flush()){self.pending.lock().map_err(|e|e.to_string())?.remove(&id);return Err(error.to_string());}Ok((id,rx))}
}
impl Drop for Worker{fn drop(&mut self){let _=self.child.kill();let _=self.child.wait();}}
pub fn request(tool:&str,args:Value)->Result<Value,String>{
 let slot=if terrain(tool){&TERRAIN_WORKER}else{&WORKER};
 let(id,receiver,pending)={let mut manager=slot.get_or_init(||Mutex::new(None)).lock().map_err(|e|e.to_string())?;let restart=match manager.as_mut(){Some(worker)=>worker.child.try_wait().map_err(|e|e.to_string())?.is_some(),None=>true};if restart{*manager=Some(Worker::spawn()?);}let worker=manager.as_mut().ok_or("UI worker unavailable")?;let(id,rx)=worker.enqueue(tool,args)?;(id,rx,worker.pending.clone())};
 let result=receiver.recv_timeout(Duration::from_secs(175));if let Ok(mut p)=pending.lock(){p.remove(&id);}match result{Ok(result)=>result,Err(error)=>Err(format!("界面操作未完成：{error}"))}
}
#[cfg(test)]mod tests{use super::*;#[test]fn heavy_world_reads_stay_outside_the_ui_worker(){assert!(handles("select_plan"));assert!(handles("ui_snapshot"));assert!(!handles("world_model_tile"));assert!(!handles("apply_draft"));}}
